import { existsSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import type { AttachedMcpServer, McpServerConfig, McpServerDraft } from '@manor/contracts'
import { COMPUTER_MCP_NAME } from '../computerPolicy.js'
import type { Store } from '../store.js'
import { probeMcpServer } from './probe.js'

/** Installed by `scripts/provision-computer.sh`; the grants belong to this app. */
export const CUA_DRIVER_PATH = '/Applications/CuaDriver.app/Contents/MacOS/cua-driver'

/**
 * Upstream Cua's own MCP mode. It launches the driver daemon through LaunchServices,
 * so macOS attributes Accessibility and Screen Recording to CuaDriver.app rather
 * than to Manor. Multiple uses persona attachments; a Single session receives every
 * registered connector, this one included. The lease is per turn.
 *
 * A release Manor.app carries its own driver; see `embeddedComputerDraft`. The
 * registry row keeps this path either way, because a checkout and the app share it.
 */
export function computerMcpDraft(): McpServerDraft {
  return {
    name: COMPUTER_MCP_NAME,
    command: CUA_DRIVER_PATH,
    args: ['mcp'],
    // The driver finds its daemon socket and its persisted telemetry-off setting under
    // HOME; without it every call waits ten seconds and fails.
    envKeys: ['HOME'],
    description: 'Use Mac apps in the background (Cua driver). The first action of a turn asks to borrow the Mac; Escape stops it. When a canvas app drops background input, retry that one call with delivery_mode foreground and its window_id.',
    writes: true,
    effectPolicy: 'confirm_writes',
  }
}

/**
 * The driver inside Manor.app and the private socket of the daemon Electron main
 * started from it. Main passes both to the bundled server it starts; a checkout, a
 * LaunchAgent or a plain `pnpm start` has neither and keeps CuaDriver.app.
 */
export interface EmbeddedComputer {
  driver: string
  socket: string
}

/** Values the desktop shell sets beside the two paths. The proxy reads them through `envKeys`. */
export const EMBEDDED_COMPUTER_ENV_KEYS = ['CUA_DRIVER_RS_TELEMETRY_ENABLED', 'CUA_DRIVER_RS_UPDATE_CHECK']

export function embeddedComputerFromEnv(env: NodeJS.ProcessEnv): EmbeddedComputer | undefined {
  const driver = env['MANOR_CUA_DRIVER']
  const socket = env['MANOR_CUA_SOCKET']
  return driver === undefined || driver === '' || socket === undefined || socket === '' ? undefined : { driver, socket }
}

/** The process environment's embedded driver, read once. */
const embedded = embeddedComputerFromEnv(process.env)

/**
 * The computer connector row as this Manor.app launches it: an MCP proxy to the
 * daemon main started, so every check and prompt runs in Manor's responsibility
 * chain. Turns, Test and the first-start probe use it; the stored row stays as it
 * is. Any other row, or a server without the embedded driver, passes unchanged.
 */
export function embeddedComputerDraft<T extends McpServerDraft>(server: T, inside: EmbeddedComputer | undefined = embedded): T {
  if (inside === undefined || server.name !== COMPUTER_MCP_NAME || server.command !== CUA_DRIVER_PATH) return server
  return {
    ...server,
    command: inside.driver,
    args: ['mcp', '--embedded', '--socket', inside.socket],
    envKeys: [...new Set([...server.envKeys, ...EMBEDDED_COMPUTER_ENV_KEYS])],
  }
}

export function embeddedComputerLaunch(
  attached: AttachedMcpServer,
  inside: EmbeddedComputer | undefined = embedded,
): AttachedMcpServer {
  const server = embeddedComputerDraft(attached.server, inside)
  return server === attached.server ? attached : { ...attached, server }
}

/**
 * A new Manor.app adds the computer connector on its first start with its own driver,
 * so computer use needs no checkout step. The row is the usual one; turns reach the
 * driver through `embeddedComputerDraft`. It happens once: a row the user removes
 * later stays removed. A start where the daemon did not answer tries again on the
 * next start. Runs after the server is up, so a slow daemon never delays the window.
 * Resolves to the row it added, if any.
 */
export async function addEmbeddedComputer(
  store: Pick<Store, 'setupDone' | 'markSetupDone' | 'saveMcpServer'>,
  registry: () => readonly McpServerConfig[],
  options: { inside?: EmbeddedComputer; probe?: typeof probeMcpServer; socketWaitMs?: number } = {},
): Promise<McpServerConfig | undefined> {
  const { inside = embedded, probe = probeMcpServer, socketWaitMs = 10_000 } = options
  if (inside === undefined) return undefined
  const hasRow = () => registry().some((server) => server.name === COMPUTER_MCP_NAME)
  try {
    if (await store.setupDone('computer-connector')) return undefined
    if (!hasRow()) {
      // Main starts the daemon beside this server; it binds its socket within about a second.
      for (let waited = 0; !existsSync(inside.socket); waited += 200) {
        if (waited >= socketWaitMs) throw new Error('the embedded driver did not open its socket')
        await sleep(200)
      }
      const draft = computerMcpDraft()
      const probed = await probe(embeddedComputerDraft(draft, inside))
      // Registered by hand meanwhile: that row counts.
      if (!hasRow()) {
        const saved = await store.saveMcpServer(draft, probed)
        await store.markSetupDone('computer-connector')
        console.warn(`[manor] added the computer connector for this Manor.app (${saved.tools.length} tools)`)
        return saved
      }
    }
    await store.markSetupDone('computer-connector')
  } catch (error: unknown) {
    console.warn(`[manor] could not add the computer connector yet: ${error instanceof Error ? error.message : 'probe failed'}`)
  }
  return undefined
}
