import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import { scaleLines, UsageChart } from '../src/components/usage/UsageChart'
import type { DayTotals } from '../src/components/usage/usageSummary'

describe('the scale of the daily chart', () => {
  it('counts in round steps and always reaches the tallest bar', () => {
    expect(scaleLines(0)).toEqual([0])
    expect(scaleLines(7)).toEqual([0, 2, 4, 6, 8])
    expect(scaleLines(8)).toEqual([0, 2, 4, 6, 8])
    expect(scaleLines(9)).toEqual([0, 2.5, 5, 7.5, 10])
    expect(scaleLines(0.03)).toEqual([0, 0.01, 0.02, 0.03])
    expect(scaleLines(1_250_000).at(-1)).toBeGreaterThanOrEqual(1_250_000)
    for (const peak of [1, 3.3, 41, 999, 12_345]) {
      const lines = scaleLines(peak)
      expect(lines.at(-1)).toBeGreaterThanOrEqual(peak)
      expect(lines.length).toBeLessThanOrEqual(5)
    }
  })
})

const totals = (costUsd: number, totalTokens: number, costUnknown = false) =>
  ({ costUsd, totalTokens, costUnknown }) as DayTotals['byProvider'] extends ReadonlyMap<string, infer Entry> ? Entry : never
const day = (claude: number, codex: number, costUnknown = false): DayTotals =>
  ({ costUsd: claude + codex, totalTokens: 0, costUnknown, byProvider: new Map([['claude', totals(claude, 1_000)], ['codex', totals(codex, 2_000, costUnknown)]]) }) as unknown as DayTotals

describe('the daily chart', () => {
  const daily = new Map([['2026-11-08', day(1, 3)], ['2026-11-09', day(2, 0, true)]])
  const render = () => {
    let chart!: ReactTestRenderer
    act(() => { chart = create(<UsageChart providers={['claude', 'codex']} days={['2026-11-08', '2026-11-09']} daily={daily} metric="cost" />) })
    const plot = chart.root.findByProps({ role: 'group' })
    return { chart, plot, text: () => JSON.stringify(chart.toJSON()) }
  }

  it('stacks each day by provider against one scale, and draws nothing for a provider that spent nothing', () => {
    const { chart } = render()
    const heights = chart.root.findAll((node) => node.type === 'span' && typeof node.props.style?.height === 'string').map((node) => node.props.style.height)
    // 4 is the top of the scale: 1 is a quarter of it, 3 three quarters, 2 a half.
    expect(heights).toEqual(['25%', '75%', '50%'])
  })

  it('reads a day out by arrow key, says Unpriced where a price is unknown, and lets go on Escape', () => {
    const { plot, text } = render()
    const press = (key: string) => act(() => plot.props.onKeyDown({ key, preventDefault: () => undefined }))
    expect(text()).not.toContain('Total')

    press('ArrowRight')
    expect(text()).toContain('$1.00')
    expect(text()).toContain('$4.00')

    press('End')
    expect(text()).toContain('Unpriced')
    press('ArrowRight')
    expect(text()).toContain('Unpriced')

    press('Escape')
    expect(text()).not.toContain('Total')
  })
})
