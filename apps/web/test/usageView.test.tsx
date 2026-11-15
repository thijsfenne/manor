import type { ProviderUsage, UsageDay, UsageReport } from '@manor/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { UsageView } from '../src/components/usage/UsageView'
import { usagePreferencesStore, type UsageTab } from '../src/components/usage/usagePreferences'

const minute = 60_000

const row = (patch: Partial<UsageDay>): UsageDay => ({
  day: '2026-10-07',
  provider: 'claude',
  model: 'claude-opus-5-5',
  responses: 1,
  inputTokens: 0,
  outputTokens: 0,
  observedInputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  uncachedInputTokens: 0,
  costUsd: 0,
  providerReportedResponses: 0,
  modelPricedResponses: 0,
  unpricedResponses: 0,
  unpricedTokens: 0,
  cacheSavingsUsd: 0,
  ...patch,
})

const report: UsageReport = {
  windowDays: 7,
  timeZone: 'Europe/Amsterdam',
  since: '2026-10-02',
  until: '2026-10-08',
  sessions: 3,
  prices: 'current',
  rows: [
    row({
      responses: 4,
      inputTokens: 900_000,
      outputTokens: 100_000,
      observedInputTokens: 900_000,
      cachedInputTokens: 800_000,
      cacheWriteTokens: 50_000,
      uncachedInputTokens: 50_000,
      costUsd: 85,
      providerReportedResponses: 4,
      cacheSavingsUsd: 12,
    }),
    row({ provider: 'codex', model: 'gpt-5.6-sol', inputTokens: 200_000, outputTokens: 10_000, costUsd: 15, modelPricedResponses: 1 }),
    row({ provider: 'codex', model: 'gpt-mystery', inputTokens: 5_000, outputTokens: 1_000, unpricedResponses: 1, unpricedTokens: 6_000 }),
  ],
}

const limits: ProviderUsage = {
  provider: 'claude',
  status: 'ok',
  plan: 'max',
  fetchedAt: 100 * minute,
  windows: [{ label: 'Session', usedPercent: 70, startsAt: 0, resetsAt: 200 * minute, minutes: 200 }],
}

const render = ({
  tab = 'limits',
  value = null,
  providerUsage = [],
  status = 'live',
}: {
  tab?: UsageTab
  value?: UsageReport | null
  providerUsage?: readonly ProviderUsage[]
  status?: 'connecting' | 'live' | 'offline'
}) => {
  usagePreferencesStore.set({ tab, windowDays: 7 })
  return renderToStaticMarkup(
    <UsageView
      title="Usage"
      report={value}
      providerUsage={providerUsage}
      status={status}
      onLoadReport={() => true}
      onRefreshLimits={() => true}
      now={() => 100 * minute}
    />,
  )
}

describe('UsageView limits', () => {
  it('shows what is left, when it resets and the pace against the clock', () => {
    const html = render({ providerUsage: [limits] })
    expect(html).toContain('30%')
    expect(html).toContain('resets in 1h 40m')
    // 70% spent with half the window gone is ahead of pace.
    expect(html).toContain('aria-label="Using quota faster than time passes. This window may run out before it resets."')
    expect(html).toContain('Session: 30% left, 50% of the window left, resets in 1h 40m')
  })

  it('says a provider is unavailable rather than drawing an empty bar', () => {
    const html = render({ providerUsage: [{ ...limits, status: 'unavailable', windows: [] }] })
    expect(html).toContain('Subscription usage unavailable.')
  })

  it('says so when no provider reports limits', () => {
    expect(render({})).toContain('No provider reports subscription limits yet.')
  })
})

describe('UsageView cost', () => {
  it('leads with the raw token cost and says it is not a bill', () => {
    const html = render({ tab: 'cost', value: report })
    expect(html).toContain('API-rate equivalent')
    expect(html).toContain('$100.00')
    expect(html).toContain('What these tokens would cost at API rates. Not what you were billed.')
    expect(html).toContain('85.0% of cost, 1M tokens')
    expect(html).toContain('Oct 2 to Oct 8')
  })

  it('shows the five totals with their context', () => {
    const html = render({ tab: 'cost', value: report })
    for (const text of ['Processed tokens', 'daily average', '88.9% of observed input', '50K cache writes', 'includes reasoning', '3 sessions']) {
      expect(html).toContain(text)
    }
  })

  it('marks a model nobody could price as unpriced, never as $0', () => {
    const html = render({ tab: 'cost', value: report })
    expect(html).toMatch(/gpt-mystery<\/span>.*?<td[^>]*><span class="text-dim">Unpriced<\/span>/)
    expect(html).not.toContain('$0.00')
    expect(html).toContain('Cost quality')
    expect(html).toContain('Cache savings')
  })

  it('says Unpriced in the headline when no response could be priced, and keeps $0.00 for a real zero', () => {
    const unpriced = render({ tab: 'cost', value: { ...report, rows: [report.rows[2]!] } })
    expect(unpriced).toMatch(/API-rate equivalent<\/h2><p[^>]*><span class="text-dim">Unpriced<\/span><\/p>/)
    expect(unpriced).not.toContain('$0.00')
    expect(render({ tab: 'cost', value: { ...report, rows: [] } })).toMatch(/API-rate equivalent<\/h2><p[^>]*>\$0\.00<\/p>/)
  })

  it('drops the old processed-volume sections', () => {
    const html = render({ tab: 'cost', value: report })
    for (const gone of ['Why it climbs', 'Heaviest turns', 'Per persona', 'Per chat']) expect(html).not.toContain(gone)
  })

  it('says it is reading before the first report lands, and does not claim to when offline', () => {
    expect(render({ tab: 'cost' })).toContain('Reading usage…')
    expect(render({ tab: 'cost', status: 'offline' })).toContain('Not connected, so there is nothing to read yet.')
  })
})

describe('UsageView refresh', () => {
  const mount = (tab: UsageTab, status: 'live' | 'offline') => {
    usagePreferencesStore.set({ tab, windowDays: 7 })
    const onRefreshLimits = vi.fn(() => true)
    let tree: ReactTestRenderer | undefined
    act(() => {
      tree = create(
        <UsageView title="Usage" report={null} providerUsage={[]} status={status}
          onLoadReport={() => true} onRefreshLimits={onRefreshLimits} now={() => 100 * minute} />,
      )
    })
    act(() => tree?.unmount())
    return onRefreshLimits
  }

  it('asks for fresh limits when Limits opens, and only then', () => {
    expect(mount('limits', 'live')).toHaveBeenCalledTimes(1)
    expect(mount('cost', 'live')).not.toHaveBeenCalled()
    expect(mount('limits', 'offline')).not.toHaveBeenCalled()
  })
})
