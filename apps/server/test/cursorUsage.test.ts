import { describe, expect, it } from 'vitest'
import { providerUsageFromCursor, readCursorProviderUsage } from '../src/drivers/cursorUsage.js'

const liveCurrentPeriod = {
  billingCycleStart: '1786902819000',
  billingCycleEnd: '1789581219000',
  planUsage: {
    totalSpend: 1500,
    includedSpend: 1500,
    remaining: 38500,
    limit: 40000,
    autoPercentUsed: 0.22033333333333333,
    apiPercentUsed: 1.678,
    totalPercentUsed: 0.4285714285714286,
  },
}

const livePlanInfo = { planInfo: { planName: 'Ultra', includedAmountCents: 40000 } }

describe('providerUsageFromCursor', () => {
  it('maps the live Connect replies without replacing Cursor\'s own percentage', () => {
    expect(providerUsageFromCursor(liveCurrentPeriod, livePlanInfo, 1_000)).toEqual({
      provider: 'cursor',
      status: 'ok',
      plan: 'Ultra',
      fetchedAt: 1_000,
      windows: [
        {
          label: 'Cursor Models',
          usedPercent: 0.22033333333333333,
          startsAt: 1_786_902_819_000,
          resetsAt: 1_789_581_219_000,
          minutes: 44_640,
        },
        {
          label: 'Other Models',
          usedPercent: 1.678,
          startsAt: 1_786_902_819_000,
          resetsAt: 1_789_581_219_000,
          minutes: 44_640,
        },
      ],
    })
  })

  it('keeps Cursor percentages in percent units instead of treating them as fractions', () => {
    const usage = providerUsageFromCursor(liveCurrentPeriod, livePlanInfo, 1_000)
    expect(usage.windows.map(({ usedPercent }) => usedPercent)).toEqual([
      0.22033333333333333,
      1.678,
    ])
  })

  it('keeps both dashboard meters at zero for a fresh billing cycle', () => {
    const usage = providerUsageFromCursor({ planUsage: {} }, livePlanInfo, 2_000)
    expect(usage).toMatchObject({
      status: 'ok',
      windows: [
        { label: 'Cursor Models', usedPercent: 0 },
        { label: 'Other Models', usedPercent: 0 },
      ],
    })
  })

  it('is unavailable when the response carries no plan usage object', () => {
    expect(providerUsageFromCursor({}, livePlanInfo, 1).status).toBe('unavailable')
  })
})

describe('readCursorProviderUsage', () => {
  it('calls Cursor\'s two dashboard RPCs with the CLI token', async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = []
    const usage = await readCursorProviderUsage({
      now: () => 3_000,
      endpoint: 'https://cursor.test/',
      authToken: async () => 'test-token',
      fetchFn: async (input, init) => {
        const url = input.toString()
        requests.push({ url, init })
        const payload = url.endsWith('/GetPlanInfo') ? livePlanInfo : liveCurrentPeriod
        return new Response(JSON.stringify(payload), { status: 200 })
      },
    })

    expect(usage.status).toBe('ok')
    expect(requests.map(({ url }) => url)).toEqual([
      'https://cursor.test/aiserver.v1.DashboardService/GetCurrentPeriodUsage',
      'https://cursor.test/aiserver.v1.DashboardService/GetPlanInfo',
    ])
    expect(new Headers(requests[0]?.init?.headers).get('Authorization')).toBe('Bearer test-token')
    expect(new Headers(requests[0]?.init?.headers).get('Connect-Protocol-Version')).toBe('1')
  })

  it('never rejects when auth or the endpoint is unavailable', async () => {
    const withoutAuth = await readCursorProviderUsage({ now: () => 4_000, authToken: async () => undefined })
    expect(withoutAuth).toEqual({ provider: 'cursor', status: 'unavailable', fetchedAt: 4_000, windows: [] })

    const failed = await readCursorProviderUsage({
      now: () => 5_000,
      authToken: async () => 'test-token',
      fetchFn: () => Promise.reject(new Error('offline')),
    })
    expect(failed.status).toBe('unavailable')
  })
})
