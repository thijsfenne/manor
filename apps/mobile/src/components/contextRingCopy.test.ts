import { contextProvenance, readContextMeter } from '@manor/client-runtime/context-meter'
import type { ContextEstimate } from '@manor/contracts'
import { describe, expect, it } from 'vitest'

import { compactCopy, sourceWord, usageCopy, windowCopy } from './contextRingCopy'

const estimate = (over: Partial<ContextEstimate> = {}): ContextEstimate => ({
  instructions: 0,
  memory: 0,
  skills: 0,
  mcpCatalog: 0,
  unmeasuredMcpServers: 0,
  ...over,
})

describe('usageCopy', () => {
  it('reads a reported fill as a percentage', () => {
    const source = contextProvenance(estimate({ used: { source: 'measured', tokens: 44_000 } }))
    expect(usageCopy(readContextMeter(44_000, 200_000), source.used)).toBe('22%, 44k/200k')
  })

  it('names a provider that reports no fill', () => {
    const source = contextProvenance(estimate({ used: { source: 'unknown' } }))
    expect(usageCopy(readContextMeter(undefined, 200_000), source.used)).toBe('This provider reports no fill')
  })

  it('falls back to not-yet-reported when provenance is absent', () => {
    expect(usageCopy(readContextMeter(undefined, 200_000), undefined)).toBe('Not reported yet')
  })
})

describe('windowCopy', () => {
  it('prints the figure’s own window, not the client catalog', () => {
    const source = contextProvenance(estimate({ window: { source: 'measured', tokens: 272_000 } }))
    expect(windowCopy(readContextMeter(undefined, 200_000), source.window)).toBe('Model window: 272k tokens')
  })

  it('keeps the catalog value when the figure is unknown', () => {
    const source = contextProvenance(estimate({ window: { source: 'unknown' } }))
    expect(windowCopy(readContextMeter(undefined, 200_000), source.window)).toBe('Model window: 200k tokens')
  })
})

describe('sourceWord', () => {
  it('marks each source in English', () => {
    const source = contextProvenance(estimate({
      used: { source: 'measured', tokens: 1 },
      window: { source: 'estimated', tokens: 2 },
      autoCompactAt: { source: 'unknown' },
    }))
    expect([sourceWord(source.used), sourceWord(source.window), sourceWord(source.autoCompactAt)])
      .toEqual(['measured', 'estimated', 'not reported'])
  })

  it('shows no mark for a turn written before provenance existed', () => {
    expect(sourceWord(undefined)).toBeNull()
  })
})

describe('compactCopy', () => {
  it('names the threshold the driver reported', () => {
    const source = contextProvenance(estimate({ autoCompactAt: { source: 'measured', tokens: 160_000 } }))
    expect(compactCopy(source.autoCompactAt)).toBe('Compacts at 160k tokens.')
  })

  it('stays vague when nothing was reported', () => {
    const source = contextProvenance(estimate({ autoCompactAt: { source: 'unknown' } }))
    expect(compactCopy(source.autoCompactAt)).toBe('Compacts automatically when needed.')
    expect(compactCopy(undefined)).toBe('Compacts automatically when needed.')
  })
})

describe('readContextMeter', () => {
  it('separates an unreported dial from an empty one', () => {
    expect(readContextMeter(undefined, 200_000).reported).toBe(false)
    expect(readContextMeter(0, 200_000).reported).toBe(true)
  })
})
