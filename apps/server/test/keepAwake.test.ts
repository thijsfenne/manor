import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createKeepAwake, KEEP_AWAKE_GRACE_MS, KEEP_AWAKE_RESPAWN_GAP_MS } from '../src/keepAwake.js'

/** A controller on fake timers whose children are records, so no process ever starts. */
function setup(platform: NodeJS.Platform = 'darwin') {
  type Child = { args: string[]; killed: boolean; end: (error?: Error) => void }
  const children: Child[] = []
  const warn = vi.fn()
  const keepAwake = createKeepAwake({
    platform,
    pid: 4242,
    spawn: (command, args) => {
      const child: Child = { args: [command, ...args], killed: false, end: () => undefined }
      children.push(child)
      return {
        kill: () => { child.killed = true },
        onEnd: (listener) => { child.end = listener },
      }
    },
    schedule: (run, ms) => {
      const timer = setTimeout(run, ms)
      return () => { clearTimeout(timer) }
    },
    now: () => Date.now(),
    warn,
  })
  const held = () => children.filter((child) => !child.killed)
  return { keepAwake, children, held, warn }
}

describe('keep awake', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('never spawns while off', () => {
    const { keepAwake, children } = setup()
    keepAwake.sync('off', 3)
    expect(children).toHaveLength(0)
  })

  it('holds one caffeinate tied to the server while work runs, and lets go only after the grace', () => {
    const { keepAwake, children, held } = setup()
    keepAwake.sync('working', 0)
    expect(children).toHaveLength(0)
    keepAwake.sync('working', 1)
    keepAwake.sync('working', 2)
    expect(children.map((child) => child.args)).toEqual([['/usr/bin/caffeinate', '-i', '-w', '4242']])
    keepAwake.sync('working', 0)
    vi.advanceTimersByTime(KEEP_AWAKE_GRACE_MS - 1)
    expect(held()).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(held()).toHaveLength(0)
  })

  it('keeps the same child when work starts again inside the grace', () => {
    const { keepAwake, children, held } = setup()
    keepAwake.sync('working', 1)
    keepAwake.sync('working', 0)
    vi.advanceTimersByTime(KEEP_AWAKE_GRACE_MS / 2)
    keepAwake.sync('working', 1)
    vi.advanceTimersByTime(KEEP_AWAKE_GRACE_MS * 2)
    expect(children).toHaveLength(1)
    expect(held()).toHaveLength(1)
  })

  it('holds with no work while always, and lets go at once on a switch to off', () => {
    const { keepAwake, children, held } = setup()
    keepAwake.sync('always', 0)
    expect(held()).toHaveLength(1)
    keepAwake.sync('off', 0)
    expect(held()).toHaveLength(0)
    expect(children).toHaveLength(1)
  })

  it('holds again at once when turned back on right after off', () => {
    const { keepAwake, children } = setup()
    keepAwake.sync('always', 0)
    keepAwake.sync('off', 0)
    keepAwake.sync('always', 0)
    expect(children).toHaveLength(2)
    expect(children[1]?.killed).toBe(false)
  })

  it('survives a spawn that throws and tries again after the gap', () => {
    let fail = true
    const warn = vi.fn()
    const spawned: string[][] = []
    const keepAwake = createKeepAwake({
      platform: 'darwin', pid: 1, now: () => Date.now(), warn,
      schedule: (run, ms) => { const timer = setTimeout(run, ms); return () => { clearTimeout(timer) } },
      spawn: (_command, args) => {
        if (fail) throw new Error('spawn ENOMEM')
        spawned.push(args)
        return { kill: () => undefined, onEnd: () => undefined }
      },
    })
    expect(() => keepAwake.sync('always', 0)).not.toThrow()
    expect(warn).toHaveBeenCalledOnce()
    fail = false
    vi.advanceTimersByTime(KEEP_AWAKE_RESPAWN_GAP_MS)
    keepAwake.sync('always', 0)
    expect(spawned).toHaveLength(1)
  })

  it('does nothing off macOS', () => {
    const { keepAwake, children } = setup('linux')
    expect(keepAwake.supported).toBe(false)
    keepAwake.sync('always', 1)
    expect(children).toHaveLength(0)
  })

  it('replaces a child that exited on its own at a later sync, without a respawn burst', () => {
    const { keepAwake, children } = setup()
    keepAwake.sync('always', 0)
    children[0]?.end()
    keepAwake.sync('always', 0)
    expect(children).toHaveLength(1)
    vi.advanceTimersByTime(KEEP_AWAKE_RESPAWN_GAP_MS)
    expect(children).toHaveLength(1)
    keepAwake.sync('always', 0)
    expect(children).toHaveLength(2)
    expect(children[1]?.killed).toBe(false)
  })

  it('stops trying when caffeinate cannot start', () => {
    const { keepAwake, children, warn } = setup()
    keepAwake.sync('always', 0)
    children[0]?.end(new Error('spawn ENOENT'))
    vi.advanceTimersByTime(KEEP_AWAKE_RESPAWN_GAP_MS)
    keepAwake.sync('always', 0)
    expect(children).toHaveLength(1)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('releases at stop and ignores syncs after it', () => {
    const { keepAwake, children, held } = setup()
    keepAwake.sync('working', 1)
    keepAwake.stop()
    expect(held()).toHaveLength(0)
    keepAwake.sync('always', 1)
    expect(children).toHaveLength(1)
  })
})
