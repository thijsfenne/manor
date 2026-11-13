import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parseElapsed, SPIKE_IDLE_MS, sweepSpikes } from '../src/spikeSweep.js'

const started: ChildProcess[] = []
let dir = ''

/** A stand-in spike process: its own group, carrying the registry marker like a real one. */
function fakeSpike(marker: string): number {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, MANOR_VERIFY_SPIKE: marker },
  })
  started.push(child)
  return child.pid!
}

function register(port: number, chatId: string, pid: number, marker: string, lastUsedAt: number): string {
  const file = path.join(dir, `${port}.json`)
  writeFileSync(file, JSON.stringify({ port, chatId, marker, pgids: [pid], lastUsedAt }))
  return file
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

afterEach(() => {
  for (const child of started.splice(0)) if (child.pid !== undefined && alive(child.pid)) process.kill(-child.pid, 'SIGKILL')
  if (dir !== '') rmSync(dir, { recursive: true, force: true })
})

describe('sweepSpikes', () => {
  it('stops an idle spike and keeps the spike of a Session running a turn', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'manor-spikes-'))
    const stale = Date.now() - SPIKE_IDLE_MS - 60_000
    const idlePid = fakeSpike('43181-idle')
    const busyPid = fakeSpike('43183-busy')
    const idleFile = register(43181, 'chat-idle', idlePid, '43181-idle', stale)
    const busyFile = register(43183, 'chat-busy', busyPid, '43183-busy', stale)

    const stopped = await sweepSpikes({ dir, chatState: async () => 'open', turnRunning: (chatId) => chatId === 'chat-busy' })

    expect(stopped).toEqual([{ port: 43181, chatId: 'chat-idle', reason: 'idle' }])
    expect(alive(idlePid)).toBe(false)
    expect(existsSync(idleFile)).toBe(false)
    expect(alive(busyPid)).toBe(true)
    expect(existsSync(busyFile)).toBe(true)
  }, 20_000)

  it('stops a settled Session\'s spike at once and leaves a recently used open one', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'manor-spikes-'))
    const settledPid = fakeSpike('43184-settled')
    const freshPid = fakeSpike('43185-fresh')
    register(43184, 'chat-settled', settledPid, '43184-settled', Date.now())
    register(43185, 'chat-fresh', freshPid, '43185-fresh', Date.now())
    const states: Record<string, 'open' | 'closed'> = { 'chat-settled': 'closed', 'chat-fresh': 'open' }

    const stopped = await sweepSpikes({ dir, chatState: async (chatId) => states[chatId]!, turnRunning: () => false })

    expect(stopped.map((spike) => spike.reason)).toEqual(['closed'])
    expect(alive(settledPid)).toBe(false)
    expect(alive(freshPid)).toBe(true)
  }, 20_000)

  it('never signals a group that does not carry the entry\'s marker', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'manor-spikes-'))
    // The registry names a pid the system has since given to another process.
    const otherPid = fakeSpike('43186-someone-else')
    register(43186, 'chat-gone', otherPid, '43186-original', 0)

    await sweepSpikes({ dir, chatState: async () => 'closed', turnRunning: () => false })

    expect(alive(otherPid)).toBe(true)
  }, 20_000)

  it('keeps the spike and its entry when a turn starts while the pass inspects it', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'manor-spikes-'))
    const pid = fakeSpike('43187-late')
    const file = register(43187, 'chat-late', pid, '43187-late', 0)
    // Idle at the first two asks (entry read, due check); running by the one before SIGTERM.
    let asked = 0

    expect(await sweepSpikes({ dir, chatState: async () => 'closed', turnRunning: () => ++asked >= 3 })).toEqual([])
    expect(asked).toBeGreaterThanOrEqual(3)
    expect(alive(pid)).toBe(true)
    expect(existsSync(file)).toBe(true)
  }, 20_000)

  it('leaves a port another Session claimed while the pass read the store', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'manor-spikes-'))
    const oldPid = fakeSpike('43188-old')
    const newPid = fakeSpike('43188-new')
    register(43188, 'chat-old', oldPid, '43188-old', 0)
    const chatState = async () => {
      register(43188, 'chat-new', newPid, '43188-new', Date.now())
      return 'closed' as const
    }

    expect(await sweepSpikes({ dir, chatState, turnRunning: () => false })).toEqual([])
    expect(alive(newPid)).toBe(true)
  }, 20_000)
})

describe('parseElapsed', () => {
  it('reads every ps etime shape', () => {
    expect(parseElapsed('05:07')).toBe(307_000)
    expect(parseElapsed('02:05:07')).toBe(7_507_000)
    expect(parseElapsed('7-02:05:07')).toBe(612_307_000)
  })
})
