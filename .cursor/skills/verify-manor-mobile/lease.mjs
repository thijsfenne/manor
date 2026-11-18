/**
 * One machine-wide lease on the phone verify run: every run shares one iOS simulator and
 * fixed ports, so only the run that holds the lease may use them, and the others queue in
 * arrival order. A run outlives the command that launched it, so the lease names a run id
 * plus the pids that keep it alive (the launcher while it runs, then the detached fixture
 * and Metro processes). A holder whose pids have all gone, or whose checkout was removed,
 * is taken over by the next in line. A waiter waits as long as the queue moves or the holder
 * is used, and gives up only after DEFAULT_STALL_MS with neither. This file never
 * signals a process; a caller that wants a stale-but-alive holder stopped does so itself
 * through `blocked`.
 *
 *   node --test .cursor/skills/verify-manor-mobile/lease.test.mjs
 */
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { describeAge } from '../verify-manor/stale-run.mjs'

export const DEFAULT_LEASE_PATH = join(homedir(), '.manor', 'verify-mobile.lease.json')
/**
 * How long a launch waits behind a holder that neither drives the simulator nor hands it over
 * before it gives up. A holder undriven for DEFAULT_IDLE_MS is stopped, a running command counting
 * as use for up to ACTIVE_MAX_MS, and this is longer than both together, so a healthy holder never
 * reaches it: giving up means something is broken.
 */
export const DEFAULT_STALL_MS = 40 * 60 * 1000
/** How long a holder may leave the simulator undriven before a waiting launch has it stopped. */
export const DEFAULT_IDLE_MS = 5 * 60 * 1000
/**
 * How long a run may sit undriven with nobody queued before its own idle watch shuts the
 * simulator, Metro and the fixture down. Longer than DEFAULT_IDLE_MS: a waiting launch takes the
 * simulator at 5 minutes, and this only frees the RAM when nobody wants it.
 */
export const DEFAULT_SHUTDOWN_IDLE_MS = 10 * 60 * 1000
/** How often an idle watch looks again while a queue or a handover keeps it from shutting down. */
const WATCH_POLL_MS = 30_000

/** Longer than the longest honest command, a launch that builds the dev client; a command running longer no longer counts as use. */
export const ACTIVE_MAX_MS = 30 * 60 * 1000

/** A lock file older than this belongs to a process that hung or died mid-update. */
const LOCK_STALE_MS = 10_000
/** How long one update waits for the lock before it throws. */
const LOCK_WAIT_MS = 5_000
/** onWait is called on the first refusal and on every change of holder, and otherwise no more often than this. */
const REPORT_EVERY_MS = 60_000

/**
 * When a process started, as `ps` prints it; '' when the process is gone. Stored next to
 * every pid so a pid the system has handed to a new process never counts as the old one.
 * Throws when `ps` itself could not run, so a busy machine never makes a live holder look dead.
 */
export function processStart(pid) {
  try {
    return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch (error) {
    // ps exits 1 when no such process exists.
    if (error.status === 1) return ''
    throw error
  }
}

/** The lease as stored, or an empty one when the file is missing or unreadable. */
export function readLease(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    return {
      holder: parsed?.holder && typeof parsed.holder === 'object' ? parsed.holder : null,
      waiters: Array.isArray(parsed?.waiters) ? parsed.waiters : [],
    }
  } catch {
    return { holder: null, waiters: [] }
  }
}

/** Whether a recorded `{ pid, start }` is still that same process. */
export const alive = ({ pid, start }, startOf = processStart) => Boolean(start) && startOf(pid) === start

/**
 * Why a holder no longer owns the simulator: 'checkout-gone' when the folder it was started
 * from is removed, 'dead' when none of its recorded processes is alive. Undefined while it
 * is still in use.
 */
export function holderStale(holder, { startOf = processStart, exists = existsSync } = {}) {
  if (!exists(holder.checkout)) return 'checkout-gone'
  if (!(holder.pids ?? []).some((entry) => alive(entry, startOf))) return 'dead'
  return undefined
}

/**
 * One attempt to take the lease for `me` ({ runId, checkout, chatId, pid }). A second
 * launch of the run that already holds it joins at once. Otherwise the lease is taken only
 * when it is free or stale and nobody alive queued earlier; a refused caller is queued and
 * told its place; a queue entry is only `{ pid, start }`, enough to tell a waiter that died.
 */
export function tryAcquire(path, me, { startOf = processStart, exists = existsSync, now = Date.now } = {}) {
  const pid = me.pid ?? process.pid
  return withLock(path, () => {
    const lease = readLease(path)
    lease.waiters = lease.waiters.filter((waiter) => alive(waiter, startOf))
    const old = lease.holder
    if (old?.runId === me.runId) {
      lease.waiters = lease.waiters.filter((waiter) => waiter.pid !== pid)
      old.pids = withPid(old.pids ?? [], pid, startOf)
      // A handover whose cleanup died is over: the run's own relaunch may use it again.
      if (old.yielding && !alive(old.yielding, startOf)) delete old.yielding
      writeLease(path, lease)
      return { acquired: true, lease: old }
    }
    const reason = old === null ? undefined : holderStale(old, { startOf, exists })
    const takeable = old === null || reason !== undefined
    const first = lease.waiters[0]
    if (takeable && (first === undefined || first.pid === pid)) {
      lease.waiters = lease.waiters.filter((waiter) => waiter.pid !== pid)
      const start = startOf(pid)
      lease.holder = { runId: me.runId, checkout: me.checkout, chatId: me.chatId ?? null, acquiredAt: now(), usedAt: now(), pids: start ? [{ pid, start }] : [] }
      writeLease(path, lease)
      return reason === undefined
        ? { acquired: true, lease: lease.holder }
        : { acquired: true, lease: lease.holder, reclaimed: { holder: old, reason } }
    }
    if (!lease.waiters.some((waiter) => waiter.pid === pid)) {
      lease.waiters.push({ pid, start: startOf(pid) })
    }
    writeLease(path, lease)
    const position = lease.waiters.findIndex((waiter) => waiter.pid === pid) + 1
    return { acquired: false, holder: lease.holder, position }
  })
}

/**
 * Records the detached processes that keep a run alive once its launcher exits. Only the
 * holder may add them; gone pids are skipped. False when `runId` does not hold the lease.
 */
export function addPids(path, runId, pids, { startOf = processStart } = {}) {
  return withLock(path, () => {
    const lease = readLease(path)
    if (lease.holder?.runId !== runId) return false
    let recorded = lease.holder.pids ?? []
    for (const pid of pids) recorded = withPid(recorded, pid, startOf)
    lease.holder.pids = recorded
    writeLease(path, lease)
    return true
  })
}

/**
 * Records that `runId` drives the simulator now: launch and every drive command call it when
 * they start and again when they exit, so `usedAt` is when the run was last driven and
 * `active` the process driving it. False when `runId` does not hold the lease, or is being
 * handed to a waiting run (see yieldIfIdle), so its drive commands stop at once.
 */
export function markUse(path, runId, { pid = process.pid, startOf = processStart, now = Date.now } = {}) {
  return withLock(path, () => {
    const lease = readLease(path)
    if (lease.holder?.runId !== runId || lease.holder.yielding) return false
    lease.holder.usedAt = now()
    lease.holder.active = { pid, start: startOf(pid) }
    writeLease(path, lease)
    return true
  })
}

/**
 * How long a holder has left the simulator undriven: 0 while a command of that run is
 * running, such as a long `launch` or a Maestro call, for up to ACTIVE_MAX_MS; otherwise since
 * its last use, or since it took the lease when it never recorded one.
 */
export function holderIdleMs(holder, { startOf = processStart, now = Date.now } = {}) {
  const usedAt = holder.usedAt ?? holder.acquiredAt
  if (holder.active && now() - usedAt < ACTIVE_MAX_MS && alive(holder.active, startOf)) return 0
  return Math.max(0, now() - usedAt)
}

/**
 * The idle verdict and the end of the run's drives as one locked step, for a cleanup asked to
 * stop an idle holder. True when `runId` holds the lease, has been idle longer than `idleMs`
 * and no other live process is already handing it over; it then records the caller as
 * `holder.yielding`, after which markUse refuses that run, so no drive command starts under the
 * cleanup. A yielding process that died (a cleanup that crashed) is taken over without asking
 * the idle question again. With `ifUnqueued` (the idle watch's shutdown, which frees RAM for nobody)
 * a live waiter also refuses it: the queue gets the simulator through its own launch instead.
 */
export function yieldIfIdle(path, runId, idleMs, { pid = process.pid, startOf = processStart, now = Date.now, ifUnqueued = false } = {}) {
  return withLock(path, () => {
    const lease = readLease(path)
    const holder = lease.holder
    if (holder?.runId !== runId) return false
    if (ifUnqueued && lease.waiters.some((waiter) => alive(waiter, startOf))) return false
    if (holder.yielding) {
      if (holder.yielding.pid !== pid && alive(holder.yielding, startOf)) return false
    } else if (holderIdleMs(holder, { startOf, now }) <= idleMs) {
      return false
    }
    holder.yielding = { pid, start: startOf(pid) }
    writeLease(path, lease)
    return true
  })
}

/**
 * What the idle watch of run `runId` does next, from the lease as stored:
 * `stop` when the run no longer holds the lease (cleaned up, handed over or reclaimed), so nothing
 * of it is left to watch; `shutdown` once it has been undriven longer than `idleMs` with nobody
 * queued; otherwise `wait` for `ms`. A live waiter or a live handover never shuts it down.
 */
export function idleWatchVerdict(lease, runId, idleMs, { startOf = processStart, now = Date.now } = {}) {
  const holder = lease.holder
  if (holder?.runId !== runId) return { action: 'stop' }
  // A handover whose cleanup died is no handover: yieldIfIdle takes it over once the run is idle.
  if ((holder.yielding && alive(holder.yielding, startOf)) || lease.waiters.some((waiter) => alive(waiter, startOf))) return { action: 'wait', ms: WATCH_POLL_MS }
  const idle = holderIdleMs(holder, { startOf, now })
  if (idle > idleMs) return { action: 'shutdown' }
  return { action: 'wait', ms: Math.max(1000, idleMs - idle + 1) }
}

/** Frees the lease at cleanup. Only the run that holds it can; the queue stays. */
export function release(path, runId) {
  return withLock(path, () => {
    const lease = readLease(path)
    if (lease.holder?.runId !== runId) return false
    lease.holder = null
    writeLease(path, lease)
    return true
  })
}

/** Takes a waiter out of the queue, when it gives up. */
export function leaveQueue(path, pid) {
  withLock(path, () => {
    const lease = readLease(path)
    const waiters = lease.waiters.filter((waiter) => waiter.pid !== pid)
    if (waiters.length === lease.waiters.length) return
    writeLease(path, { ...lease, waiters })
  })
}

/**
 * Who holds the lease, as a noun phrase for the callers' "held by …" lines:
 * `chat 1a2b3c4d, checkout /path, since 14:02 (12 minutes)` or `a run started by hand, checkout …`.
 */
export function describeHolder(holder, now = Date.now()) {
  if (!holder) return 'nobody, behind an earlier waiter'
  const since = new Date(holder.acquiredAt)
  const clock = `${String(since.getHours()).padStart(2, '0')}:${String(since.getMinutes()).padStart(2, '0')}`
  const who = holder.chatId ? `chat ${holder.chatId.slice(0, 8)}` : 'a run started by hand'
  return `${who}, checkout ${holder.checkout}, since ${clock} (${describeAge(now - since.getTime())})`
}

/**
 * Queues for the lease until it is ours, with no limit on the total wait: it gives up only after
 * `stallMs` without progress. The standstill clock restarts whenever the holder changes or was
 * used (its `usedAt` moved) since the last look; "no holder", behind an earlier waiter, is a state
 * of its own. After each refusal with a holder, `blocked(holder)` is awaited so the caller may stop
 * a holder its own rules call stale; `onWait({ holder, position, waitedMs })` reports progress on
 * the first refusal, on every change of holder and otherwise at most once a minute. On a
 * standstill the caller leaves the queue and gets
 * `{ acquired: false, timedOut: true, holder, waitedMs, stalledMs }`, with `waitedMs` the whole
 * wait and `stalledMs` the part without progress.
 */
export async function waitForLease(path, me, { stallMs = DEFAULT_STALL_MS, pollMs = 5000, onWait, blocked, deps = {} } = {}) {
  const now = deps.now ?? Date.now
  const pid = me.pid ?? process.pid
  const started = now()
  let behind
  let usedBefore
  let stalledSince
  let reportedAt
  try {
    for (;;) {
      const result = tryAcquire(path, me, deps)
      if (result.acquired) return result
      const runId = result.holder?.runId ?? null
      const usedAt = result.holder?.usedAt
      const changed = stalledSince === undefined || runId !== behind
      // A holder that drives the simulator is progress too, though not worth a line of its own.
      if (changed || usedAt !== usedBefore) stalledSince = now()
      behind = runId
      usedBefore = usedAt
      const waitedMs = now() - started
      const stalledMs = now() - stalledSince
      if (stalledMs >= stallMs) {
        leaveQueue(path, pid)
        return { acquired: false, timedOut: true, holder: result.holder, waitedMs, stalledMs }
      }
      if (result.holder) await blocked?.(result.holder)
      if (changed || now() - reportedAt >= REPORT_EVERY_MS) {
        reportedAt = now()
        onWait?.({ holder: result.holder, position: result.position, waitedMs })
      }
      await sleep(Math.max(0, Math.min(pollMs, stallMs - (now() - stalledSince))))
    }
  } catch (error) {
    // A caller that stops waiting on an error must not hold up the queue behind it.
    try { leaveQueue(path, pid) } catch { /* the lock itself is what failed */ }
    throw error
  }
}

/** The pid list with `pid` added, when it is alive and not already recorded as itself. */
function withPid(pids, pid, startOf) {
  const start = startOf(pid)
  if (!start || pids.some((entry) => entry.pid === pid && entry.start === start)) return pids
  return [...pids.filter((entry) => entry.pid !== pid), { pid, start }]
}

/**
 * Only called under the lock. Refuses when the lock was broken as abandoned and taken by
 * another process meanwhile, so a stalled update cannot overwrite a newer one.
 */
function writeLease(path, lease) {
  let owner = ''
  try { owner = readFileSync(`${path}.lock`, 'utf8') } catch { /* broken and not retaken */ }
  if (owner !== String(process.pid)) throw new Error(`lost the lease lock ${path}.lock during an update`)
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(lease, null, 2)}\n`)
  renameSync(temp, path)
}

/** A synchronous pause, so a lock retry needs no async plumbing in its callers. */
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

/**
 * Runs one read-modify-write of the lease while holding `${path}.lock`, so two processes
 * can never both see the lease free and take it.
 */
function withLock(path, work) {
  mkdirSync(dirname(path), { recursive: true })
  const lock = `${path}.lock`
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      const fd = openSync(lock, 'wx')
      try { writeSync(fd, String(process.pid)) } finally { closeSync(fd) }
      break
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    breakAbandoned(lock)
    if (Date.now() > deadline) throw new Error(`the lease lock ${lock} stayed taken for ${LOCK_WAIT_MS / 1000} s`)
    pause(5 + Math.random() * 20)
  }
  try {
    return work()
  } finally {
    // Only our own lock: one broken as abandoned may already belong to someone else.
    try { if (readFileSync(lock, 'utf8') === String(process.pid)) unlinkSync(lock) } catch { /* already gone */ }
  }
}

/**
 * Removes a lock whose owner died or that is too old to be a live update. A lock just
 * created and not yet written has no pid, so only its age counts.
 */
function breakAbandoned(lock) {
  let seen
  let owner
  try {
    seen = statSync(lock)
    owner = Number(readFileSync(lock, 'utf8'))
  } catch {
    return
  }
  const abandoned = Date.now() - seen.mtimeMs > LOCK_STALE_MS || (owner > 0 && !pidAlive(owner))
  if (!abandoned) return
  try {
    // Another waiter may have broken it and taken a fresh one meanwhile; leave that one alone.
    if (statSync(lock).ino === seen.ino) unlinkSync(lock)
  } catch { /* already gone */ }
}
