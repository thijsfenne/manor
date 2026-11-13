import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ProviderUsageSchema, type ProviderUsage } from '@manor/contracts'
import { ProviderUsageHistory } from '../src/providerUsageHistory.js'
import { ProviderUsageService } from '../src/providerUsage.js'
import { createSqliteStore } from '../src/stores/sqliteStore.js'

const minute = 60_000
const reading = (at: number, usedPercent = 20, resetsAt = 300 * minute): ProviderUsage => ({
  provider: 'codex', status: 'ok', plan: 'plus', fetchedAt: at,
  windows: [{ label: '5-hour limit', minutes: 300, resetsAt, usedPercent }],
})
const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }) })

describe('subscription observation history', () => {
  it('starts with an actual reading, retains the first and latest per quarter hour, and deduplicates', () => {
    const history = new ProviderUsageHistory()
    expect(history.record(reading(10 * minute)).windows[0]?.history).toEqual([{ at: 10 * minute, usedPercent: 20 }])
    history.record(reading(11 * minute, 21))
    history.record(reading(12 * minute, 22))
    history.record(reading(30 * minute, 25))
    const saved = history.record(reading(30 * minute, 25))
    expect(saved.windows[0]?.history).toEqual([
      { at: 10 * minute, usedPercent: 20 }, { at: 12 * minute, usedPercent: 22 }, { at: 30 * minute, usedPercent: 25 },
    ])
    expect(ProviderUsageSchema.parse(saved)).toEqual(saved)
  })

  it('separates reset periods, plans and window scopes', () => {
    const history = new ProviderUsageHistory()
    history.record(reading(10 * minute))
    const next = history.record(reading(310 * minute, 2, 600 * minute))
    expect(next.windows[0]?.history).toEqual([{ at: 310 * minute, usedPercent: 2 }])
    const changedPlan = history.record({ ...reading(320 * minute, 3, 600 * minute), plan: 'pro' })
    expect(changedPlan.windows[0]?.history).toHaveLength(1)
    const scoped: ProviderUsage = { ...reading(330 * minute, 4, 600 * minute), plan: 'pro' }
    scoped.windows.push({ ...scoped.windows[0]!, label: 'Scoped', usedPercent: 9 })
    const result = history.record(scoped)
    expect(result.windows[0]?.history).toHaveLength(2)
    expect(result.windows[1]?.history).toEqual([{ at: 330 * minute, usedPercent: 9 }])
  })

  it('does not collect invalid, ambiguous, missing-reset or expired readings', () => {
    const history = new ProviderUsageHistory()
    for (const at of [-1, 300 * minute, 301 * minute]) {
      expect(history.record(reading(at)).windows[0]?.history).toEqual([])
    }
    for (const percent of [-1, Number.NaN, Infinity]) {
      expect(history.record(reading(minute, percent)).windows[0]?.history).toEqual([])
    }
    const unknown = reading(minute)
    delete unknown.windows[0]!.resetsAt
    expect(history.record(unknown).windows[0]?.history).toEqual([])
    const ambiguous = reading(minute)
    ambiguous.windows.push({ ...ambiguous.windows[0]! })
    expect(history.record(ambiguous).windows.every((window) => window.history?.length === 0)).toBe(true)
  })

  it('survives SQLite reopen and failed probes without inventing observations', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'manor-subscription-'))
    directories.push(directory)
    const filename = path.join(directory, 'test.db')
    const store = createSqliteStore({ filename })
    try { new ProviderUsageHistory(store.db).record(reading(10 * minute)) } finally { store.close() }
    const reopened = createSqliteStore({ filename })
    try {
      const history = new ProviderUsageHistory(reopened.db)
      const unavailable: ProviderUsage = { provider: 'codex', status: 'unavailable', fetchedAt: 20 * minute, windows: [] }
      expect(history.record(unavailable)).toEqual(unavailable)
      expect(history.record(reading(30 * minute, 30)).windows[0]?.history).toEqual([
        { at: 10 * minute, usedPercent: 20 }, { at: 30 * minute, usedPercent: 30 },
      ])
    } finally { reopened.close() }
  })

  it('preserves existing samples through expired or invalid observations and SQLite reopen', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'manor-subscription-reset-'))
    directories.push(directory)
    const filename = path.join(directory, 'test.db')
    const store = createSqliteStore({ filename })
    const expected = [
      { at: 10 * minute, usedPercent: 20 },
      { at: 30 * minute, usedPercent: 25 },
      { at: 60 * minute, usedPercent: 30 },
    ]
    try {
      const history = new ProviderUsageHistory(store.db)
      for (const sample of expected) history.record(reading(sample.at, sample.usedPercent))
      for (const observation of [
        reading(300 * minute, 30), reading(301 * minute, 30),
        reading(90 * minute, -1), reading(90 * minute, Number.NaN), reading(90 * minute, Infinity),
        reading(Number.NaN), reading(-1),
      ]) {
        expect(history.record(observation).windows[0]?.history).toEqual(expected)
      }
    } finally { store.close() }
    const reopened = createSqliteStore({ filename })
    try {
      const history = new ProviderUsageHistory(reopened.db)
      expect(history.record(reading(302 * minute, 30)).windows[0]?.history).toEqual(expected)
      expect(history.record(reading(310 * minute, 2, 600 * minute)).windows[0]?.history).toEqual([
        { at: 310 * minute, usedPercent: 2 },
      ])
    } finally { reopened.close() }
  })

  it('broadcasts collected history to every client and preserves a reading if storage fails', async () => {
    const history = new ProviderUsageHistory()
    const service = new ProviderUsageService({
      drivers: { codex: { startTurn: () => { throw new Error('no turns') }, readProviderUsage: async () => reading(minute) } },
      broadcast: () => undefined, debounceMs: 0, history,
    })
    service.noteTurnEnded('codex')
    await new Promise((resolve) => setImmediate(resolve))
    expect(service.message().perProvider[0]?.windows[0]?.history).toHaveLength(1)
    history.record = () => { throw new Error('disk failure') }
    service.noteTurnEnded('codex')
    await new Promise((resolve) => setImmediate(resolve))
    expect(service.message().perProvider[0]).toEqual(reading(minute))
  })
})
