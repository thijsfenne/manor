import type { Driver } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { liveAttempts, type SideAttempt } from '../src/sideAttempts.js'

const driver = {} as Driver
const attempt = (runtime: SideAttempt['runtime'], model: string): SideAttempt => ({ driver, runtime, model })
const standIn = (provider: SideAttempt['runtime']) =>
  provider === 'grok' || provider === 'cursor' ? attempt(provider, `${provider}-default`) : undefined
const runtimes = (attempts: Iterable<SideAttempt>) => [...attempts].map((entry) => `${entry.runtime}:${entry.model}`)

describe('liveAttempts', () => {
  const preferred = [attempt('codex', 'small'), attempt('claude', 'haiku')]

  it("keeps the job's own order and lets the other signed-in providers stand in after it", () => {
    const attempts = liveAttempts(preferred, () => ['claude', 'codex', 'grok', 'cursor'], standIn)
    expect(runtimes(attempts)).toEqual(['codex:small', 'claude:haiku', 'grok:grok-default', 'cursor:cursor-default'])
  })

  it('skips a provider that cannot answer, so a Grok-only install still gets the job done', () => {
    expect(runtimes(liveAttempts(preferred, () => ['grok'], standIn))).toEqual(['grok:grok-default'])
    expect(runtimes(liveAttempts(preferred, () => [], standIn))).toEqual([])
  })

  it('reads who can answer on every walk, not once', () => {
    let able: SideAttempt['runtime'][] = ['claude']
    const attempts = liveAttempts(preferred, () => able, standIn)
    expect(runtimes(attempts)).toEqual(['claude:haiku'])
    able = ['codex', 'cursor']
    expect(runtimes(attempts)).toEqual(['codex:small', 'cursor:cursor-default'])
  })
})
