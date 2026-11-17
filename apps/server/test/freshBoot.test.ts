import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import WebSocket from 'ws'

/**
 * The stranger's first launch, end to end: the real server process on a home folder
 * that holds nothing, no settings beyond where to listen, the mock driver standing in
 * for a provider. It guards the wiring in `main.ts` that the unit tests cannot see.
 */
const serverDir = fileURLToPath(new URL('..', import.meta.url))
let server: ChildProcess | undefined
let home: string | undefined
afterEach(() => {
  server?.kill('SIGKILL')
  if (home !== undefined) rmSync(home, { recursive: true, force: true })
})

/**
 * The two ways the server gets started. From source is how a checkout runs it. The
 * bundle is what the desktop app ships: one entry file and the files it reads, in a
 * folder with no checkout around it and started from somewhere else, so a lookup that
 * still leans on the source layout fails here instead of on a user's Mac.
 */
const LAUNCHES = [
  {
    name: 'from source',
    // Node with the tsx loader, not the `tsx` command: that command starts the server
    // as a child of its own, and killing the command at the end of the test left the
    // server running for good.
    start: (env: NodeJS.ProcessEnv) => spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
      cwd: serverDir, env, stdio: ['ignore', 'pipe', 'pipe'],
    }),
  },
  {
    name: 'as the bundle the desktop app ships',
    start: (env: NodeJS.ProcessEnv) => {
      const bundle = path.join(home!, 'bundle')
      execFileSync(process.execPath, [path.join(serverDir, 'scripts/build-bundle.mjs'), bundle], { stdio: 'ignore' })
      return spawn(process.execPath, [path.join(bundle, 'dist/main.mjs')], { cwd: home!, env, stdio: ['ignore', 'pipe', 'pipe'] })
    },
  },
] as const

/**
 * A checkout can hold the developer's own `apps/server/.env`, and the server started
 * from source reads it. Every key that file names is passed in empty, which wins over
 * the file, so the run is a stranger's first launch whoever's checkout it is in, and
 * it never reaches for that developer's database, vault or accounts.
 */
function withoutCheckoutSettings(): NodeJS.ProcessEnv {
  let text = ''
  try { text = readFileSync(path.join(serverDir, '.env'), 'utf8') } catch { return {} }
  const keys = text.split('\n').flatMap((line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1] ?? [])
  return Object.fromEntries(keys.map((key) => [key, '']))
}

const freePort = () => new Promise<number>((resolve, reject) => {
  const probe = createServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address()
    probe.close(() => (typeof address === 'object' && address !== null ? resolve(address.port) : reject(new Error('no port'))))
  })
})

type Door = { socket: WebSocket } | { refused: number }
const knock = (port: number, token?: string) => new Promise<Door>((resolve, reject) => {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws${token === undefined ? '' : `?token=${token}`}`)
  socket.once('open', () => resolve({ socket }))
  socket.once('unexpected-response', (_request, response) => resolve({ refused: response.statusCode ?? 0 }))
  socket.once('error', reject)
})

it.each(LAUNCHES)('starts as an empty house, keeps strangers out, and answers once the first agent exists, $name', async ({ start }) => {
  // The real path: the bundle is then started by exactly the path its modules report
  // as their own, which is what a run-as-script check inside one of them would see.
  home = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'manor-fresh-boot-')))
  const dataDir = path.join(home, '.manor')
  const port = await freePort()
  let log = ''
  // The port comes from `<data dir>/.env`, the settings file a packaged app can have.
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(path.join(dataDir, '.env'), `MANOR_PORT=${port}\n`)
  server = start({
    ...withoutCheckoutSettings(),
    PATH: process.env.PATH ?? '', HOME: home, MANOR_DATA_DIR: dataDir,
    MANOR_DRIVER: 'mock', MANOR_HOST: '127.0.0.1',
  })
  server.stdout?.on('data', (chunk) => { log += String(chunk) })
  server.stderr?.on('data', (chunk) => { log += String(chunk) })

  await expect.poll(async () => {
    if (server?.exitCode !== null) throw new Error(`The server stopped during its first start:\n${log}`)
    try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok } catch { return false }
  }, { timeout: 25_000, interval: 200 }).toBe(true)

  // The settings file in the data folder was read: it named the port the server listens on.
  expect(log).toContain(`:${port}/ws`)
  // Memory needs no setting either: its folder sits beside the database with starter files.
  expect(readFileSync(path.join(dataDir, 'memory', 'soul.md'), 'utf8')).toContain('# Voice and values')

  expect(await knock(port)).toEqual({ refused: 401 })
  expect(await knock(port, 'x'.repeat(43))).toEqual({ refused: 401 })

  // Listened to from the moment it exists, not from 'open'. The server sends its first
  // frames right behind the handshake, and on a busy runner both land in one read. `ws`
  // then emits those frames before an awaited 'open' could attach a listener, and the
  // empty roster this test answers is gone.
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${readFileSync(path.join(dataDir, 'local-access-token'), 'utf8').trim()}`)
  // The house starts empty. The onboarding's two moves, creating an agent and opening
  // its DM with a first message, are what a new user's first minute comes down to.
  const reply = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No reply to the first message:\n${log}`)), 15_000)
    socket.once('unexpected-response', (_request, response) => reject(new Error(`The local access token was refused with ${response.statusCode}`)))
    socket.once('error', reject)
    let asked = false
    let greeted = false
    socket.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as { type: string; agents?: { id: string }[]; projects?: unknown[]; homeFolders?: string[]; chats?: unknown[]; event?: { type: string; agentId?: string } }
      // No project is made for the user. A session without one works in the home room,
      // whose folder is the memory folder, told to the client as a host fact.
      if (frame.type === 'directory' && (frame.projects?.length ?? 0) > 0) {
        reject(new Error('A fresh house should hold no project'))
      }
      if (frame.type === 'host_capabilities' && frame.homeFolders?.map((folder) => realpathSync(folder)).join() !== realpathSync(path.join(dataDir, 'memory'))) {
        reject(new Error(`The home room should be the memory folder, got ${frame.homeFolders?.join()}`))
      }
      if (frame.type === 'directory' && !asked && (frame.chats?.length ?? 0) > 0) {
        reject(new Error('A fresh house should hold no chat'))
      }
      if (frame.type === 'roster' && frame.agents?.length === 0 && !asked) {
        asked = true
        socket.send(JSON.stringify({
          type: 'save_agent',
          requestId: 'first-agent',
          agent: { name: 'Marlow', color: '#8B7EC8', character: 'You are Marlow.', driver: 'claude', allowedTools: [], mcpServers: [], memoryScope: false, isCos: true },
        }))
      }
      const created = frame.type === 'roster' ? frame.agents?.[0]?.id : undefined
      if (created !== undefined && !greeted) {
        greeted = true
        socket.send(JSON.stringify({ type: 'create_chat', kind: 'dm', memberIds: [created], openingMessage: { text: 'Hello house' } }))
      }
      if (frame.type === 'event' && frame.event?.type === 'agent_message' && frame.event.agentId !== undefined) {
        clearTimeout(timer)
        resolve(frame.event.agentId)
      }
    })
  })
  socket.close()
  expect(reply).not.toBe('')
}, 60_000)
