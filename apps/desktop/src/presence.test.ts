import { describe, expect, it } from 'vitest'
import { createPresenceMonitor, PRESENCE_IDLE_SECONDS, type PresencePower } from './presence'

type Event = Parameters<PresencePower['on']>[0]

function rig() {
  let idle = 0
  let system: ReturnType<PresencePower['getSystemIdleState']> | null = null
  const listeners = new Map<Event, () => void>()
  const asked: number[] = []
  const reports: boolean[] = []
  let beat: () => void = () => undefined
  let stopped = false
  const power: PresencePower = {
    getSystemIdleState: (threshold) => {
      asked.push(threshold)
      return system ?? (idle >= threshold ? 'idle' : 'active')
    },
    on: (event, listener) => void listeners.set(event, listener),
    off: (event) => void listeners.delete(event),
  }
  const monitor = createPresenceMonitor({
    power,
    report: (active) => void reports.push(active),
    setInterval: (run) => {
      beat = run
      return () => { stopped = true }
    },
  })
  return {
    monitor, reports, asked, listeners,
    beat: () => beat(),
    stopped: () => stopped,
    idleFor: (seconds: number) => { idle = seconds },
    system: (value: typeof system) => { system = value },
    fire: (event: Event) => listeners.get(event)?.(),
  }
}

describe('desktop presence', () => {
  it('reports active at once and repeats it every beat', () => {
    const { reports, beat } = rig()
    beat()
    beat()
    expect(reports).toEqual([true, true, true])
  })

  it('goes away at the idle threshold, not before, and comes back on input', () => {
    const { reports, beat, idleFor, asked, monitor } = rig()
    idleFor(PRESENCE_IDLE_SECONDS - 1)
    beat()
    idleFor(PRESENCE_IDLE_SECONDS)
    beat()
    beat()
    idleFor(3)
    beat()
    expect(reports).toEqual([true, true, false, true])
    expect(new Set(asked)).toEqual(new Set([PRESENCE_IDLE_SECONDS]))
    expect(monitor.current()).toBe(true)
  })

  it('goes away on lock and returns on unlock without waiting for a beat', () => {
    const { reports, fire, monitor } = rig()
    fire('lock-screen')
    expect(monitor.current()).toBe(false)
    fire('unlock-screen')
    expect(reports).toEqual([true, false, true])
  })

  it('stays away across beats while locked, even if the idle clock reads active', () => {
    const { reports, fire, beat } = rig()
    fire('lock-screen')
    beat()
    beat()
    expect(reports).toEqual([true, false])
  })

  it('goes away on suspend and returns on resume', () => {
    const { reports, fire, beat } = rig()
    fire('suspend')
    beat()
    fire('resume')
    expect(reports).toEqual([true, false, true])
  })

  it('counts a system lock or an unknown state as away', () => {
    const { reports, beat, system } = rig()
    system('locked')
    beat()
    system('unknown')
    beat()
    expect(reports).toEqual([true, false])
  })

  it('lets go of its timer and listeners on stop', () => {
    const { monitor, listeners, stopped } = rig()
    monitor.stop()
    expect(stopped()).toBe(true)
    expect(listeners.size).toBe(0)
  })
})
