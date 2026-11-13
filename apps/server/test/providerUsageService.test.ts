import type { Driver, ProviderUsage, ServerMessage, TurnHandle } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { ProviderUsageService } from '../src/providerUsage.js'

const never: Driver['startTurn'] = (): TurnHandle => {
  throw new Error('this driver exists to be probed, not to run turns')
}

const ok = (provider: ProviderUsage['provider'], usedPercent: number, fetchedAt: number): ProviderUsage => ({
  provider,
  status: 'ok',
  plan: 'max',
  fetchedAt,
  windows: [{ label: 'Weekly', usedPercent }],
})

const down = (provider: ProviderUsage['provider'], fetchedAt: number): ProviderUsage => ({
  provider,
  status: 'unavailable',
  fetchedAt,
  windows: [],
})

/** A driver whose probe returns whatever the test queues, and counts the calls. */
function stubDriver(replies: (() => Promise<ProviderUsage>)[]) {
  const state = { calls: 0 }
  const driver: Driver = {
    startTurn: never,
    readProviderUsage: async () => {
      const reply = replies[Math.min(state.calls, replies.length - 1)]
      state.calls += 1
      if (reply === undefined) throw new Error('no reply queued')
      return await reply()
    },
  }
  return { driver, state }
}

const settle = async () => {
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
}

describe('ProviderUsageService', () => {
  it('reports nothing at all when no driver can answer', () => {
    const service = new ProviderUsageService({
      // The mock driver's shape: a runtime with no subscription behind it.
      drivers: { claude: { startTurn: never } },
      broadcast: () => undefined,
    })

    expect(service.enabled).toBe(false)
    expect(service.message().perProvider).toEqual([])
  })

  it('probes on the zero-to-one client edge and broadcasts the reading', async () => {
    const { driver, state } = stubDriver([async () => ok('codex', 41, 100)])
    const sent: ServerMessage[] = []
    const service = new ProviderUsageService({
      drivers: { codex: driver },
      broadcast: (message) => sent.push(message),
      now: () => 100,
    })

    // Before anything connects the panel still has an answer, and it is honest.
    expect(service.message().perProvider).toEqual([down('codex', 100)])

    service.setClientCount(1)
    await settle()

    expect(state.calls).toBe(1)
    expect(sent).toHaveLength(1)
    expect(service.message().perProvider).toEqual([ok('codex', 41, 100)])

    // A second client is not a new edge; the reading it gets is the one in hand.
    service.setClientCount(2)
    await settle()
    expect(state.calls).toBe(1)
  })

  it('debounces every terminal turn down to one probe per window', async () => {
    const { driver, state } = stubDriver([async () => ok('claude', 12, 0)])
    let clock = 0
    const service = new ProviderUsageService({
      drivers: { claude: driver },
      broadcast: () => undefined,
      now: () => clock,
      debounceMs: 1_000,
    })

    clock = 5_000
    service.noteTurnEnded('claude')
    await settle()
    expect(state.calls).toBe(1)

    // Three turns end inside the window. None of them may spawn a CLI.
    clock = 5_100
    service.noteTurnEnded('claude')
    service.noteTurnEnded('claude')
    clock = 5_500
    service.noteTurnEnded('claude')
    await settle()
    expect(state.calls).toBe(1)

    clock = 7_000
    service.noteTurnEnded('claude')
    await settle()
    expect(state.calls).toBe(2)
  })

  it('refreshes on request past the turn debounce, and still answers a request it skips', async () => {
    const { driver, state } = stubDriver([async () => ok('claude', 12, 0)])
    let clock = 0
    const sent: ServerMessage[] = []
    const service = new ProviderUsageService({
      drivers: { claude: driver },
      broadcast: (message) => sent.push(message),
      now: () => clock,
      debounceMs: 60_000,
    })

    clock = 5_000
    service.noteTurnEnded('claude')
    await settle()
    // Inside the turn debounce, but past the refresh floor: The user asked, so it probes.
    clock = 20_000
    service.refreshNow()
    await settle()
    expect(state.calls).toBe(2)

    // Moments later nothing is probed, yet the current reading goes out again.
    const before = sent.length
    clock = 21_000
    service.refreshNow()
    await settle()
    expect(state.calls).toBe(2)
    expect(sent.length).toBe(before + 1)
  })

  it('keeps the last good reading through a failure, and gives up after three', async () => {
    let clock = 1_000
    const { driver } = stubDriver([
      async () => ok('claude', 30, 1_000),
      async () => down('claude', 2_000),
      async () => down('claude', 3_000),
      async () => down('claude', 4_000),
    ])
    const service = new ProviderUsageService({
      drivers: { claude: driver },
      broadcast: () => undefined,
      now: () => clock,
      debounceMs: 0,
      failureLimit: 3,
    })

    service.noteTurnEnded('claude')
    await settle()
    expect(service.message().perProvider[0]).toEqual(ok('claude', 30, 1_000))

    // One and two: a blip. The number on screen is still true, still stamped with
    // the moment it was read, and better than blanking a working panel.
    clock = 2_000
    service.noteTurnEnded('claude')
    await settle()
    expect(service.message().perProvider[0]?.status).toBe('ok')

    clock = 3_000
    service.noteTurnEnded('claude')
    await settle()
    expect(service.message().perProvider[0]?.status).toBe('ok')

    // Three in a row is not a blip.
    clock = 4_000
    service.noteTurnEnded('claude')
    await settle()
    expect(service.message().perProvider[0]).toEqual(down('claude', 4_000))
  })

  it('shows unavailable straight away when there has never been a good reading', async () => {
    let clock = 0
    const { driver } = stubDriver([async () => down('codex', 500)])
    const service = new ProviderUsageService({
      drivers: { codex: driver },
      broadcast: () => undefined,
      now: () => clock,
      debounceMs: 0,
    })

    clock = 500
    service.noteTurnEnded('codex')
    await settle()

    expect(service.message().perProvider[0]?.status).toBe('unavailable')
  })

  it('survives a driver that breaks its contract and rejects', async () => {
    const driver: Driver = {
      startTurn: never,
      readProviderUsage: () => Promise.reject(new Error('boom')),
    }
    const sent: ServerMessage[] = []
    const service = new ProviderUsageService({
      drivers: { claude: driver },
      broadcast: (message) => sent.push(message),
      now: () => 10,
      debounceMs: 0,
    })

    service.noteTurnEnded('claude')
    await settle()

    expect(sent).toHaveLength(1)
    expect(service.message().perProvider[0]?.status).toBe('unavailable')
  })

  it('never runs two probes at once for one provider', async () => {
    let release: (usage: ProviderUsage) => void = () => undefined
    const { driver, state } = stubDriver([
      async () => await new Promise<ProviderUsage>((resolve) => (release = resolve)),
    ])
    let clock = 0
    const service = new ProviderUsageService({
      drivers: { claude: driver },
      broadcast: () => undefined,
      now: () => clock,
      debounceMs: 0,
    })

    service.noteTurnEnded('claude')
    await settle()
    clock = 60_000
    service.noteTurnEnded('claude')
    await settle()
    expect(state.calls).toBe(1)

    release(ok('claude', 5, 60_000))
    await settle()
    expect(service.message().perProvider[0]?.status).toBe('ok')
  })
})
