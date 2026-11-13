import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readdir, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { isSignallableGroupPid } from './drivers/childTermination.js'

const run = promisify(execFile)

/** A spike nobody drove for this long, while its Session runs no turn, is stopped. */
export const SPIKE_IDLE_MS = 15 * 60 * 1000

/** Often enough that a settled or archived Session's spike is gone within the minute. */
export const SPIKE_SWEEP_INTERVAL_MS = 30 * 1000

/** How long a stopped group gets to exit on SIGTERM before it is killed. */
const STOP_GRACE_MS = 5_000

/**
 * `running`: the Session has a turn in flight, so its spike stays whatever else holds.
 * `closed`: settled or archived. `open`: anything else, including a chat this server
 * does not know, which then only ever stops on idle.
 */
export type SpikeChatState = 'running' | 'open' | 'closed'

/** The part of verify-manor's registry entry (`<data>/spikes/<port>.json`) the sweep reads. */
interface SpikeEntry {
  port: number
  chatId: string | null
  marker: string
  pgids: number[]
  lastUsedAt: number
}

export interface StoppedSpike {
  port: number
  chatId: string | null
  reason: 'closed' | 'idle'
}

export function spikeVerdict(
  entry: Pick<SpikeEntry, 'lastUsedAt'>,
  state: SpikeChatState,
  now: number,
  idleMs: number,
): 'keep' | StoppedSpike['reason'] {
  if (state === 'running') return 'keep'
  if (state === 'closed') return 'closed'
  return now - entry.lastUsedAt > idleMs ? 'idle' : 'keep'
}

function parseEntry(raw: string): SpikeEntry | undefined {
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) return undefined
    const { port, chatId, marker, pgids, lastUsedAt } = value as Record<string, unknown>
    if (typeof port !== 'number' || typeof marker !== 'string' || marker === '' || typeof lastUsedAt !== 'number') return undefined
    if (chatId !== null && typeof chatId !== 'string') return undefined
    const groups = Array.isArray(pgids) ? pgids.filter((pid): pid is number => isSignallableGroupPid(pid as number)) : []
    return { port, chatId, marker, pgids: groups, lastUsedAt }
  } catch {
    return undefined
  }
}

async function groupMembers(pgid: number): Promise<number[]> {
  const { stdout } = await run('ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' })
  return stdout.trim().split('\n').flatMap((line) => {
    const [pid, group] = line.trim().split(/\s+/).map(Number)
    return group === pgid && pid !== undefined ? [pid] : []
  })
}

async function environmentOf(pid: number | string): Promise<string> {
  try {
    // `e` appends the environment; `-o command=` alone would drop it on macOS.
    const { stdout } = await run('ps', ['eww', '-p', String(pid)], { encoding: 'utf8' })
    return stdout
  } catch {
    return ''
  }
}

/**
 * Stops one process group, but only while a member's environment still passes `ours`:
 * a pid the system has since handed to something else is never signalled. `allowed` is
 * asked again with no await before each signal, so a turn that started while this pass
 * read the store keeps its spike. SIGKILL follows the grace period, since Playwright's
 * own SIGTERM handler closes the browser but can leave a daemon running. Answers false
 * only when `allowed` refused, so the caller keeps the registration of a group it spared.
 */
async function stopMarkedGroup(pgid: number, ours: (env: string) => boolean, allowed: () => boolean = () => true): Promise<boolean> {
  const marked = async () => {
    for (const pid of await groupMembers(pgid)) if (ours(await environmentOf(pid))) return true
    return false
  }
  if (!isSignallableGroupPid(pgid) || !(await marked())) return true
  if (!allowed()) return false
  try {
    process.kill(-pgid, 'SIGTERM')
  } catch {
    return true
  }
  for (let waited = 0; waited < STOP_GRACE_MS; waited += 100) {
    if ((await groupMembers(pgid)).length === 0) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (!(await marked())) return true
  if (!allowed()) return false
  try {
    process.kill(-pgid, 'SIGKILL')
  } catch {
    // Gone between the check and the signal.
  }
  return true
}

const readEntry = async (file: string) => parseEntry(await readFile(file, 'utf8').catch(() => ''))

function readEntrySync(file: string): SpikeEntry | undefined {
  try {
    return parseEntry(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * One pass over the spike registry: stops every spike whose Session closed or that sat
 * idle past `idleMs`, and drops its entry. A Session with a turn running keeps its spike;
 * `turnRunning` is synchronous so it can be asked again right before every signal.
 * Every group is checked for the entry's marker before it is signalled, and spikes stop
 * side by side so one slow exit does not hold up the rest past the minute.
 */
export async function sweepSpikes(options: {
  dir: string
  chatState: (chatId: string) => Promise<Exclude<SpikeChatState, 'running'>>
  turnRunning: (chatId: string) => boolean
  now?: number
  idleMs?: number
}): Promise<StoppedSpike[]> {
  const { dir, chatState, turnRunning, now = Date.now(), idleMs = SPIKE_IDLE_MS } = options
  const busy = (chatId: string | null) => chatId !== null && turnRunning(chatId)
  const names = (await readdir(dir).catch(() => [])).filter((name) => /^\d+\.json$/.test(name))
  const results = await Promise.all(names.map(async (name): Promise<StoppedSpike | undefined> => {
    const file = path.join(dir, name)
    const entry = await readEntry(file)
    if (entry === undefined || busy(entry.chatId)) return undefined
    const state = entry.chatId === null ? 'open' : await chatState(entry.chatId)
    const verdict = spikeVerdict(entry, state, now, idleMs)
    if (verdict === 'keep') return undefined
    // The verdict belongs to this entry only: a port freed and claimed again by another
    // Session meanwhile carries a new marker and waits for the next pass.
    const stillDue = () => {
      const latest = readEntrySync(file)
      if (latest?.marker !== entry.marker || busy(latest.chatId)) return false
      return verdict === 'closed' || spikeVerdict(latest, 'open', Date.now(), idleMs) === 'idle'
    }
    if (!stillDue()) return undefined
    const marker = `MANOR_VERIFY_SPIKE=${entry.marker}`
    const outcomes = await Promise.all(entry.pgids.map((pgid) => stopMarkedGroup(pgid, (env) => env.includes(marker), stillDue)))
    // A group spared for a turn that started meanwhile keeps the whole entry registered.
    if (outcomes.includes(false) || readEntrySync(file)?.marker !== entry.marker) return undefined
    await unlink(file).catch(() => {})
    return { port: entry.port, chatId: entry.chatId, reason: verdict }
  }))
  return results.filter((spike) => spike !== undefined)
}

/** `[[dd-]hh:]mm:ss` from `ps -o etime` in milliseconds. */
export function parseElapsed(etime: string): number {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime.trim())
  if (match === null) return 0
  const [, days = '0', hours = '0', minutes = '0', seconds = '0'] = match
  return (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000
}

/**
 * Spikes started before the registry existed, or by a branch whose verify-manor has no
 * registry yet, carry no marker and have no Session on record. Only those left from
 * before this server started are stopped, once they are older than `olderThanMs`, since
 * the turns that drove them died with the last server. Called on every sweep, so one
 * still young at boot is stopped once it ages. They are recognised by verify-manor's own
 * run folder and daemon path, never by name.
 */
export async function stopUnregisteredSpikes(options: { startedBefore: number; olderThanMs?: number; now?: number }): Promise<number> {
  const { startedBefore, olderThanMs = SPIKE_IDLE_MS, now = Date.now() } = options
  const { stdout } = await run('ps', ['-axo', 'pid=,pgid=,ppid=,etime=,command='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const groups = new Map<number, (env: string) => boolean>()
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
    if (match === null) continue
    const [, pid, pgid, ppid, etime, command] = match
    const age = parseElapsed(etime!)
    if (age <= olderThanMs || now - age >= startedBefore || !isSignallableGroupPid(Number(pgid)) || groups.has(Number(pgid))) continue
    const server = /@manor\/server start|src\/main\.ts/.test(command!)
    const daemon = command!.includes('/skills/verify-manor/session-daemon.mjs')
    const orphanBrowser = Number(ppid) === 1 && /chrome-headless-shell|Chromium/.test(command!)
    if (!daemon && !server && !orphanBrowser) continue
    const legacy = server ? legacyServer : legacyBrowser
    if (legacy(await environmentOf(pid!))) groups.set(Number(pgid), legacy)
  }
  await Promise.all([...groups].map(([pgid, legacy]) => stopMarkedGroup(pgid, legacy)))
  return groups.size
}

const unregistered = (env: string) => !env.includes('MANOR_VERIFY_SPIKE=')
/** A mock memory-store server serving verify-manor's private dist: never the live one. */
const legacyServer = (env: string) =>
  unregistered(env) && /MANOR_WEB_DIST=\S*\/skills\/verify-manor\/\.run\//.test(env) && env.includes('MANOR_DRIVER=mock')
/** A session daemon and the Chromium it launched both carry the spike origin. */
const legacyBrowser = (env: string) => unregistered(env) && env.includes('MANOR_VERIFY_ORIGIN=')
