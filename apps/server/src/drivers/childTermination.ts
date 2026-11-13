import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

interface ProcessIdentity {
  pid: number
  ppid: number
  pgid: number
  started: string
}

interface KillableChild {
  readonly pid?: number
  kill(signal?: NodeJS.Signals): boolean
  on(event: 'close' | 'exit', listener: () => void): void
}

/**
 * Whether a child pid is safe to signal as a process group. `kill(-1)` reaches every
 * process the user owns and `kill(-0)` the server's own group, and a fake child in a
 * test can report pid 1, so anything at or below 1 only ever gets `child.kill`.
 */
export const isSignallableGroupPid = (pid: number | undefined): pid is number =>
  typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 1

async function processSnapshot(): Promise<Map<number, ProcessIdentity>> {
  try {
    const { stdout } = await run('ps', ['-A', '-o', 'pid=,ppid=,pgid=,lstart='], { encoding: 'utf8' })
    const processes = new Map<number, ProcessIdentity>()
    for (const line of stdout.split('\n')) {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
      if (!match) continue
      const pid = Number(match[1])
      const ppid = Number(match[2])
      const pgid = Number(match[3])
      if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(ppid) || !Number.isInteger(pgid) || pgid <= 0) continue
      processes.set(pid, { pid, ppid, pgid, started: match[4]! })
    }
    return processes
  } catch {
    return new Map()
  }
}

const sameProcess = (expected: ProcessIdentity, processes: Map<number, ProcessIdentity>): boolean => {
  const current = processes.get(expected.pid)
  return current !== undefined && current.pgid === expected.pgid && current.started === expected.started
}

function collectDescendants(pid: number, processes: Map<number, ProcessIdentity>): ProcessIdentity[] {
  const byParent = new Map<number, ProcessIdentity[]>()
  for (const process of processes.values()) {
    const children = byParent.get(process.ppid) ?? []
    children.push(process)
    byParent.set(process.ppid, children)
  }
  const descendants: ProcessIdentity[] = []
  const seen = new Set([pid])
  const queue = [pid]
  for (let index = 0; index < queue.length; index++) {
    for (const child of byParent.get(queue[index]!) ?? []) {
      if (seen.has(child.pid)) continue
      seen.add(child.pid)
      descendants.push(child)
      queue.push(child.pid)
    }
  }
  return descendants
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    // Already gone.
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const KILL_AFTER_MS = 1500
const REAP_POLL_MS = 100
/** Work that keeps spawning past the KILL is given up on here rather than chased forever. */
const REAP_GIVE_UP_MS = KILL_AFTER_MS + 1000

const terminating = new WeakMap<KillableChild, { signalled: Promise<void>; gone: Promise<boolean> }>()
const activeChildren = new Set<KillableChild>()
let shuttingDown = false

export const cliShutdownStarted = (): boolean => shuttingDown

/** Keep infrastructure turns in the shutdown path as well as visible turns. */
export function trackCliChild(child: KillableChild): void {
  const pid = child.pid
  if (!isSignallableGroupPid(pid)) return
  activeChildren.add(child)
  child.on('close', () => activeChildren.delete(child))
  // A CLI that exits on its own leaves what it started in its group, reparented
  // away: MCP servers behind an `npx` or `npm exec` wrapper, background jobs. Nothing
  // can wake the chat for them any more. A Stop or shutdown reaps the group itself.
  child.on('exit', () => { if (!terminating.has(child)) signalPid(-pid, 'SIGKILL') })
  if (shuttingDown) void terminateCliTree(child)
}

export async function stopAllCliChildren(): Promise<number> {
  shuttingDown = true
  const children = [...activeChildren]
  await Promise.all(children.map(terminateCliTree))
  return children.length
}

/**
 * TERM the detached group and descendants, then KILL identities that survived.
 * Resolves once TERM is sent; `cliTreeGone` waits for the processes themselves.
 */
export function terminateCliTree(child: KillableChild | undefined): Promise<void> {
  if (child === undefined) return Promise.resolve()
  return stoppingTree(child).signalled
}

/**
 * Stops the tree like `terminateCliTree`, KILLing what outlives the grace, and tells
 * whether every process it reached is confirmed gone. Check it before claiming work
 * stopped: false means something outlived the KILL or the process list was unreadable.
 */
export function cliTreeGone(child: KillableChild | undefined): Promise<boolean> {
  if (child === undefined) return Promise.resolve(true)
  return stoppingTree(child).gone
}

function stoppingTree(child: KillableChild): { signalled: Promise<void>; gone: Promise<boolean> } {
  const pending = terminating.get(child)
  if (pending !== undefined) return pending
  const reached = stopCliTree(child)
  const stopping = {
    signalled: reached.then(() => undefined),
    gone: reached.then(reap),
  }
  terminating.set(child, stopping)
  return stopping
}

interface ReachedTree {
  targets: ProcessIdentity[]
  /** False when `ps` gave nothing, so neither the targets nor their end are known. */
  listed: boolean
  /** The CLI's own process group, while it has members. */
  groupId?: number
  /** The CLI itself while it still leads that group. */
  leader?: ProcessIdentity
}

async function stopCliTree(child: KillableChild): Promise<ReachedTree> {
  const pid = child.pid
  if (!isSignallableGroupPid(pid)) {
    try { child.kill('SIGTERM') } catch { /* Already gone. */ }
    return { targets: [], listed: true }
  }
  const processes = await processSnapshot()
  const root = processes.get(pid)
  const leadsGroup = root?.pgid === pid
  // A detached CLI leads its own group. Background work it started stays in that
  // group after the CLI exits, reparented away, so it is no longer a descendant.
  const targets = [...new Map([
    ...(root === undefined ? [] : [root]),
    ...collectDescendants(pid, processes),
    ...[...processes.values()].filter((process) => process.pgid === pid),
  ].map((process) => [process.pid, process])).values()]
  if (leadsGroup) {
    try {
      process.kill(-pid, 'SIGTERM')
    } catch {
      try { child.kill('SIGTERM') } catch { /* Already gone. */ }
    }
  } else {
    try { child.kill('SIGTERM') } catch { /* Already gone. */ }
  }
  for (const target of targets) if (target.pid !== pid) signalPid(target.pid, 'SIGTERM')
  return {
    targets,
    listed: processes.size > 0,
    ...(targets.some((target) => target.pgid === pid) ? { groupId: pid } : {}),
    ...(leadsGroup ? { leader: root } : {}),
  }
}

/**
 * Waits for the reached processes to exit and KILLs the ones still there after the
 * grace. Once all are gone it looks at the group again, because a TERM handler can
 * start new work there on its way out, and reaches that too.
 */
async function reap({ targets, listed, groupId, leader }: ReachedTree): Promise<boolean> {
  if (!listed) return false
  const reached = new Map(targets.map((target) => [target.pid, target]))
  const startedAt = Date.now()
  let killing = false
  for (;;) {
    const elapsed = Date.now() - startedAt
    if (!killing && elapsed >= KILL_AFTER_MS) {
      killing = true
      const current = await processSnapshot()
      if (leader !== undefined && sameProcess(leader, current)) signalPid(-leader.pid, 'SIGKILL')
      for (const target of reached.values()) {
        if (sameProcess(target, current)) signalPid(target.pid, 'SIGKILL')
      }
    }
    if (![...reached.values()].some((target) => alive(target.pid))) {
      if (groupId === undefined) return true
      const current = await processSnapshot()
      if (current.size === 0) return false
      const joined = [...current.values()]
        .filter((process) => process.pgid === groupId && reached.get(process.pid)?.started !== process.started)
      if (joined.length === 0) return true
      for (const process of joined) {
        reached.set(process.pid, process)
        signalPid(process.pid, killing ? 'SIGKILL' : 'SIGTERM')
      }
    }
    if (elapsed >= REAP_GIVE_UP_MS) return false
    await new Promise<void>((resolve) => setTimeout(resolve, REAP_POLL_MS).unref?.())
  }
}
