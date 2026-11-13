/**
 * Which leftover verify run may be stopped to free a port, shared by verify-manor and
 * verify-manor-mobile (no dependencies, so both can import it). The maintainer's standing rule:
 * a run is stale when it is over a day old, or when the chat that owns it no longer has a
 * running turn. A run whose owner has a turn right now is never stale, and live Manor
 * (43179) is never a run at all. Only the caller decides what to signal; this file only
 * judges and describes.
 *
 *   node --test .cursor/skills/verify-manor/stale-run.test.mjs
 */
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

export const STALE_AFTER_MS = 24 * 60 * 60 * 1000
/**
 * An owner without a running turn must also have left the run alone this long, the same
 * grace the live server's sweep gives a spike (SPIKE_IDLE_MS), so a Session between two
 * turns does not lose its warm run to a neighbour.
 */
export const OWNER_IDLE_MS = 15 * 60 * 1000

/**
 * `ageMs`: since the run started. `idleMs`: since anyone last used it. `ownerRunning`:
 * true or false for a known chat, null when the run has no chat (started by hand).
 * Returns why the run is stale, or undefined when it must be left alone.
 */
export function staleVerdict({ ageMs, idleMs, ownerRunning }) {
  if (ownerRunning === true) return undefined
  if (ageMs > STALE_AFTER_MS) return 'old'
  if (ownerRunning === false && idleMs > OWNER_IDLE_MS) return 'owner-gone'
  return undefined
}

/** Working directories of every process, from lsof's -Fn output. */
export function listCwds() {
  let listing = ''
  try {
    listing = execFileSync('lsof', ['-d', 'cwd', '-Fn'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (error) {
    // lsof exits 1 when one process vanished mid-scan, and still prints the rest.
    listing = String(error?.stdout ?? '')
  }
  return listing.split('\n').filter((line) => line.startsWith('n')).map((line) => line.slice(1))
}

/**
 * Whether a chat has a turn running: a provider CLI runs in `<data>/scratch/<chatId>` (or
 * a persona folder inside it) for as long as its turn lasts. When the process list cannot
 * be read at all the answer is true, since an unknown owner is never fair game.
 */
export function chatRunning(chatId, dataDir, cwds = listCwds()) {
  if (cwds.length === 0) return true
  const home = `${dataDir}/scratch/${chatId}`
  return cwds.some((cwd) => cwd === home || cwd.startsWith(`${home}/`))
}

/** `1 day 19 hours`, `3 hours 5 minutes`, `12 minutes`: how long a run has been there. */
export function describeAge(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`
  if (days > 0) return hours > 0 ? `${plural(days, 'day')} ${plural(hours, 'hour')}` : plural(days, 'day')
  if (hours > 0) return `${plural(hours, 'hour')} ${plural(minutes % 60, 'minute')}`
  return plural(minutes, 'minute')
}

/** `[[dd-]hh:]mm:ss` from `ps -o etime` in milliseconds; 0 when it does not parse. */
export function parseElapsed(etime) {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(etime).trim())
  if (match === null) return 0
  const [, days = '0', hours = '0', minutes = '0', seconds = '0'] = match
  return (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000
}

/** Why the verdict makes a run fair game, for the line the skill prints. */
export const staleReason = (verdict, ageMs, chatId) =>
  verdict === 'old'
    ? `it is ${describeAge(ageMs)} old`
    : `its owner${chatId ? ` (chat ${chatId.slice(0, 8)})` : ''} has no running turn`

/**
 * The Session this spike belongs to. A Manor turn's provider CLI runs in the chat's
 * scratch folder, `<data>/scratch/<chatId>` or a persona folder inside it, so walking up the process tree to it names
 * the chat, and `<data>/spikes` is where the live server's sweep reads. Run by hand
 * outside Manor, there is no chat and the spike stops on idle only.
 */
export function resolveOwner() {
  const parents = new Map()
  for (const line of execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    parents.set(pid, ppid)
  }
  const chain = []
  for (let pid = process.ppid; pid > 1 && chain.length < 32; pid = parents.get(pid) ?? 0) chain.push(pid)
  let listing = ''
  try {
    listing = execFileSync('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', chain.join(',')], { encoding: 'utf8' })
  } catch (error) {
    // lsof exits 1 when one listed pid has already gone, and still prints the rest.
    listing = String(error?.stdout ?? '')
  }
  const cwds = new Map()
  let current = 0
  for (const line of listing.split('\n')) {
    if (line.startsWith('p')) current = Number(line.slice(1))
    else if (line.startsWith('n')) cwds.set(current, line.slice(1))
  }
  for (const pid of chain) {
    // Claude Code runs in the scratch folder itself; Codex, Cursor and Grok in a persona folder inside it.
    const match = /^(.+)\/scratch\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/[^/]+)?$/.exec(cwds.get(pid) ?? '')
    if (match) return { chatId: match[2], registryDir: join(match[1], 'spikes') }
  }
  return { chatId: null, registryDir: join(homedir(), '.manor', 'spikes') }
}

/** `ps eww` output of a process: its command line and environment (empty when it is gone or hidden). */
export function envOf(pid) {
  try {
    return execFileSync('ps', ['eww', '-p', String(pid)], { encoding: 'utf8' })
  } catch {
    return ''
  }
}

export function groupMembers(pgid) {
  const rows = execFileSync('ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' }).trim().split('\n')
  return rows.map((row) => row.trim().split(/\s+/).map(Number)).filter(([, group]) => group === pgid).map(([pid]) => pid)
}

/**
 * Signals a process group only while one of its members still passes `ours` (the run's
 * marker in its environment), so a pid the system has handed to something else is never
 * touched. `allowed` is asked again right before SIGTERM and before SIGKILL: a stale
 * verdict taken seconds ago does not cover a Session that has resumed since. Answers false
 * only when `allowed` refused.
 */
export async function stopGroup(pgid, ours, allowed = () => true) {
  if (!Number.isInteger(pgid) || pgid <= 1) return true
  const marked = () => groupMembers(pgid).some((pid) => ours(envOf(pid)))
  if (!marked()) return true
  if (!allowed()) return false
  try { process.kill(-pgid, 'SIGTERM') } catch { return true }
  for (let waited = 0; waited < 5_000; waited += 100) {
    if (groupMembers(pgid).length === 0) return true
    await sleep(100)
  }
  if (!marked()) return true
  if (!allowed()) return false
  try { process.kill(-pgid, 'SIGKILL') } catch { /* already gone */ }
  return true
}
