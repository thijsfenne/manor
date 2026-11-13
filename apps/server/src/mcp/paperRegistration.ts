import type { McpServerConfig, McpServerDraft } from '@manor/contracts'
import type { Store } from '../store.js'
import { PAPER_DESKTOP_URL, paperMcpDraft } from './paperAttachment.js'
import { probeMcpServer, type McpProbeResult } from './probe.js'

export const PAPER_UNAVAILABLE_MESSAGE =
  'Paper Desktop is not serving this connector. Open a file in Paper Desktop, then try again.'

/** Paper being closed is an ordinary host state, not an opaque network failure. */
export async function probePaperRow(
  draft: McpServerDraft,
  probe: (server: McpServerDraft) => Promise<McpProbeResult> = probeMcpServer,
): Promise<McpProbeResult> {
  try {
    return await probe(draft)
  } catch (error: unknown) {
    if (isPaperUnavailable(error)) throw new Error(PAPER_UNAVAILABLE_MESSAGE)
    throw error
  }
}

function isPaperUnavailable(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return (
    error.message === `could not reach ${PAPER_DESKTOP_URL}` ||
    error.message.startsWith(`${PAPER_DESKTOP_URL} did not answer within `) ||
    /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|fetch failed/i.test(error.message)
  )
}

/**
 * Keeps an existing derived Paper row on the desktop endpoint. Absence remains
 * deliberate: registration is what adds a connector to the household.
 */
export async function reconcilePaperServer(
  store: Store,
  registry: readonly McpServerConfig[],
  probe: (server: McpServerDraft) => Promise<McpProbeResult> = probePaperRow,
): Promise<McpServerConfig[]> {
  const derived = paperMcpDraft()
  const existing = registry.find((server) => server.name === derived.name)
  if (existing === undefined) return [...registry]

  const draft = paperRowDraft(existing, derived)
  if (paperRuntimeUnchanged(existing, draft)) return [...registry]

  let probed: McpProbeResult = {
    tools: [...existing.tools],
    readOnlyTools: [...existing.readOnlyTools],
    schemaChars: existing.schemaChars,
  }
  let probeError: unknown
  try {
    probed = await probe(draft)
  } catch (error: unknown) {
    // The fixed endpoint and credential boundary are safer config, even when the
    // desktop app is temporarily unavailable. Keep the last live tool metadata.
    probeError = error
  }

  try {
    const saved = await store.saveMcpServer(draft, probed)
    if (probeError === undefined) {
      console.warn(`[manor] paper connector re-pointed at ${derived.url} (${probed.tools.length} tools)`)
    } else {
      console.warn(
        `[manor] paper connector configuration corrected; live probe unavailable: ${
          probeError instanceof Error ? probeError.message : 'probe failed'
        }`,
      )
    }
    return registry.map((server) => (server.id === saved.id ? saved : server))
  } catch (error: unknown) {
    console.warn(
      `[manor] the paper connector configuration could not be corrected: ${
        error instanceof Error ? error.message : 'probe failed'
      }`,
    )
    return [...registry]
  }
}

export function paperRowDraft(
  existing: McpServerConfig,
  derived: McpServerDraft,
): McpServerDraft & { id: string } {
  return {
    ...derived,
    id: existing.id,
  }
}

export function paperRuntimeUnchanged(existing: McpServerConfig, derived: McpServerDraft): boolean {
  return (
    (existing.url ?? '') === (derived.url ?? '') &&
    existing.command === derived.command &&
    existing.envKeys.length === 0 &&
    existing.writes === true
  )
}
