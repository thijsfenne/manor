import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { codexWindowLabel, providerUsageFromCodex, readCodexProviderUsage } from '../src/drivers/codexUsage.js'

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = new PassThrough()
  killed = false

  kill(): boolean {
    this.killed = true
    return true
  }
}

/** What `account/rateLimits/read` returned live on 2026-08-13: a week window, alone. */
const liveReply = {
  id: 2,
  result: {
    rateLimits: {
      limitId: 'codex',
      primary: { usedPercent: 4, windowDurationMins: 10080, resetsAt: 1_787_209_279 },
      secondary: null,
      credits: { hasCredits: false, unlimited: false, balance: '0' },
      planType: 'plus',
    },
  },
}

describe('codexWindowLabel', () => {
  it('names the two windows Codex actually ships', () => {
    expect(codexWindowLabel(300)).toBe('5-hour limit')
    expect(codexWindowLabel(10080)).toBe('Weekly')
  })

  it('still labels a duration nobody has seen before', () => {
    expect(codexWindowLabel(30)).toBe('30-minute limit')
    expect(codexWindowLabel(180)).toBe('3-hour limit')
    expect(codexWindowLabel(43200)).toBe('30-day limit')
    expect(codexWindowLabel(undefined)).toBe('Limit')
  })
})

describe('providerUsageFromCodex', () => {
  it('maps the live reply, which carries only a primary window', () => {
    const usage = providerUsageFromCodex(liveReply, 1_000)

    expect(usage).toEqual({
      provider: 'codex',
      status: 'ok',
      plan: 'plus',
      fetchedAt: 1_000,
      windows: [{ label: 'Weekly', usedPercent: 4, resetsAt: 1_787_209_279_000, minutes: 10080 }],
    })
  })

  it('maps both windows when a secondary is present', () => {
    const usage = providerUsageFromCodex(
      {
        id: 2,
        result: {
          rateLimits: {
            primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_787_000_000 },
            secondary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: 1_787_209_279 },
            planType: 'pro',
          },
        },
      },
      2_000,
    )

    expect(usage.windows.map((window) => window.label)).toEqual(['5-hour limit', 'Weekly'])
    expect(usage.windows.map((window) => window.usedPercent)).toEqual([12, 61])
  })

  it('is unavailable for an error reply, a missing block, or nonsense', () => {
    expect(providerUsageFromCodex({ id: 2, error: { code: -32601 } }, 1).status).toBe('unavailable')
    expect(providerUsageFromCodex({ id: 2, result: { rateLimits: null } }, 1).status).toBe('unavailable')
    expect(providerUsageFromCodex('{', 1).status).toBe('unavailable')
  })

  it('is unavailable when a window carries no percentage', () => {
    const usage = providerUsageFromCodex(
      { id: 2, result: { rateLimits: { primary: { windowDurationMins: 10080 }, planType: 'plus' } } },
      1,
    )
    expect(usage.status).toBe('unavailable')
  })
})

describe('readCodexProviderUsage', () => {
  it('returns unavailable when child stdin breaks', async () => {
    const child = new FakeChild()
    const usage = readCodexProviderUsage({
      command: 'codex', cwd: '/tmp', codexHome: async () => '/tmp/manor-codex-home', spawnFn: () => child,
    })
    await new Promise((resolve) => setImmediate(resolve))
    child.stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))
    expect((await usage).status).toBe('unavailable')
  })

  it('completes the handshake before asking, then kills the app-server', async () => {
    const child = new FakeChild()
    let written = ''
    child.stdin.on('data', (chunk: Buffer) => {
      written += chunk.toString('utf8')
    })

    let env: NodeJS.ProcessEnv = {}
    const usage = readCodexProviderUsage({
      command: 'codex',
      spawnFn: (_command, _args, options) => {
        env = options.env
        return child
      },
      cwd: '/tmp',
      now: () => 7_000,
      codexHome: async () => '/tmp/manor-codex-home',
    })

    await new Promise((resolve) => setImmediate(resolve))
    expect(env.CODEX_HOME).toBe('/tmp/manor-codex-home')
    expect(written.trim()).toContain('"method":"initialize"')

    child.stdout.write(`${JSON.stringify({ id: 1, result: { codexHome: '/tmp/manor-codex-home' } })}\n`)
    await new Promise((resolve) => setImmediate(resolve))

    const sent = written.trim().split('\n')
    expect(sent[1]).toContain('"method":"initialized"')
    expect(sent[2]).toContain('account/rateLimits/read')

    // An unsolicited notification arrives mid-handshake in real runs; it has no id
    // and must not be mistaken for the answer.
    child.stdout.write(`${JSON.stringify({ method: 'remoteControl/status/changed', params: {} })}\n`)
    child.stdout.write(`${JSON.stringify(liveReply)}\n`)

    expect((await usage).windows).toEqual([
      { label: 'Weekly', usedPercent: 4, resetsAt: 1_787_209_279_000, minutes: 10080 },
    ])
    expect(child.killed).toBe(true)
  })

  it('is unavailable when the Codex home cannot be prepared', async () => {
    const usage = await readCodexProviderUsage({
      command: 'codex',
      spawnFn: () => new FakeChild(),
      cwd: '/tmp',
      now: () => 8_000,
      codexHome: () => Promise.reject(new Error('EACCES')),
    })
    expect(usage).toEqual({ provider: 'codex', status: 'unavailable', fetchedAt: 8_000, windows: [] })
  })

  it('is unavailable when the app-server exits without answering', async () => {
    const child = new FakeChild()
    const usage = readCodexProviderUsage({
      command: 'codex',
      spawnFn: () => child,
      cwd: '/tmp',
      now: () => 9_000,
      codexHome: async () => '/tmp/manor-codex-home',
    })

    await new Promise((resolve) => setImmediate(resolve))
    child.emit('close', 1)

    expect((await usage).status).toBe('unavailable')
  })
})
