import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  grokWindowLabel,
  providerUsageFromGrok,
  readGrokProviderUsage,
} from '../src/drivers/grokUsage.js'

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

const liveReply = {
  jsonrpc: '2.0',
  id: 2,
  result: {
    config: {
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-08-23T17:50:34.207953+00:00',
        end: '2026-08-30T17:50:34.207953+00:00',
      },
      onDemandCap: { val: 0 },
      onDemandUsed: { val: 0 },
    },
    subscription_tier: 'SuperGrok Heavy',
  },
}

describe('providerUsageFromGrok', () => {
  it('maps the live weekly response and mirrors the CLI\'s omitted-zero behaviour', () => {
    expect(providerUsageFromGrok(liveReply, 1_000)).toEqual({
      provider: 'grok',
      status: 'ok',
      plan: 'SuperGrok Heavy',
      fetchedAt: 1_000,
      windows: [{
        label: 'Weekly limit',
        usedPercent: 0,
        startsAt: Date.parse('2026-08-23T17:50:34.207953+00:00'),
        resetsAt: Date.parse('2026-08-30T17:50:34.207953+00:00'),
        minutes: 10_080,
      }],
    })
  })

  it('keeps a reported percentage and labels monthly windows', () => {
    const usage = providerUsageFromGrok({
      id: 2,
      result: {
        config: {
          creditUsagePercent: 42,
          currentPeriod: { type: 'USAGE_PERIOD_TYPE_MONTHLY', start: '2026-08-01', end: '2026-09-01' },
        },
      },
    }, 2_000)
    expect(usage.windows[0]).toMatchObject({ label: 'Monthly limit', usedPercent: 42 })
    expect(grokWindowLabel('FUTURE_WINDOW')).toBe('FUTURE_WINDOW')
  })

  it('is unavailable for a missing or invalid period', () => {
    expect(providerUsageFromGrok({}, 1).status).toBe('unavailable')
    expect(providerUsageFromGrok({ id: 2, result: { config: {
      currentPeriod: { type: 'WEEKLY', start: 'bad', end: 'also bad' },
    } } }, 1).status).toBe('unavailable')
  })
})

describe('readGrokProviderUsage', () => {
  it('returns unavailable when child stdin breaks', async () => {
    const child = new FakeChild()
    let spawned = false
    const usage = readGrokProviderUsage({
      command: 'grok', cwd: '/tmp', usageHome: '/tmp/manor-grok-usage',
      grokHome: '/tmp/real-grok-home', spawnFn: () => { spawned = true; return child },
    })
    await vi.waitFor(() => expect(spawned).toBe(true))
    child.stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))
    expect((await usage).status).toBe('unavailable')
  })

  it('initializes ACP, asks billing directly, and kills the child', async () => {
    const child = new FakeChild()
    let written = ''
    child.stdin.on('data', (chunk: Buffer) => {
      written += chunk.toString('utf8')
    })
    let args: readonly string[] = []
    let env: NodeJS.ProcessEnv = {}

    const usage = readGrokProviderUsage({
      command: 'grok',
      cwd: '/tmp',
      usageHome: '/tmp/manor-grok-usage',
      grokHome: '/tmp/real-grok-home',
      now: () => 3_000,
      spawnFn: (_command, spawnArgs, options) => {
        args = spawnArgs
        env = options.env
        return child
      },
    })

    await vi.waitFor(() => expect(args).toEqual(['agent', '--no-leader', 'stdio']))
    expect(env.HOME).toBe('/tmp/manor-grok-usage')
    expect(env.GROK_HOME).toBe('/tmp/real-grok-home')
    expect(written).toContain('"method":"initialize"')

    child.stdout.write(`${JSON.stringify({ id: 1, result: { protocolVersion: 1 } })}\n`)
    await new Promise((resolve) => setImmediate(resolve))
    expect(written).toContain('"method":"_x.ai/billing"')

    child.stdout.write(`${JSON.stringify({ method: '_x.ai/settings/update', params: {} })}\n`)
    child.stdout.write(`${JSON.stringify(liveReply)}\n`)
    expect((await usage).windows[0]?.label).toBe('Weekly limit')
    expect(child.killed).toBe(true)
  })

  it('is unavailable when ACP exits without a billing reply', async () => {
    const child = new FakeChild()
    let spawned = false
    const usage = readGrokProviderUsage({
      command: 'grok',
      cwd: '/tmp',
      usageHome: '/tmp/manor-grok-usage',
      grokHome: '/tmp/real-grok-home',
      now: () => 4_000,
      spawnFn: () => {
        spawned = true
        return child
      },
    })
    await vi.waitFor(() => expect(spawned).toBe(true))
    child.emit('close', 1)
    expect((await usage).status).toBe('unavailable')
  })
})
