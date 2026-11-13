import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { claudeWindowLabel, providerUsageFromClaude, readClaudeProviderUsage } from '../src/drivers/claudeUsage.js'

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

/**
 * The reply Claude Code 2.1.231 actually returned on a Max account, trimmed to the
 * fields Manor reads. Kept verbatim rather than idealised: the legacy flat block
 * sits beside `limits` in the real payload and the mapper has to ignore it.
 */
const liveReply = {
  session: { total_cost_usd: 0, total_api_duration_ms: 0 },
  subscription_type: 'max',
  rate_limits_available: true,
  rate_limits: {
    five_hour: { utilization: 63, resets_at: '2026-08-13T11:29:59.948357+00:00' },
    seven_day: { utilization: 74, resets_at: '2026-08-15T18:59:59.948382+00:00' },
    seven_day_opus: null,
    limits: [
      {
        kind: 'session',
        group: 'session',
        percent: 63,
        severity: 'normal',
        resets_at: '2026-08-13T11:29:59.948357+00:00',
        scope: null,
        is_active: false,
      },
      {
        kind: 'weekly_all',
        group: 'weekly',
        percent: 74,
        severity: 'normal',
        resets_at: '2026-08-15T18:59:59.948382+00:00',
        scope: null,
        is_active: true,
      },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 45,
        severity: 'normal',
        resets_at: '2026-08-15T18:59:59.948600+00:00',
        scope: { model: { id: null, display_name: 'Fable' }, surface: null },
        is_active: false,
      },
    ],
  },
}

describe('claudeWindowLabel', () => {
  it('names the two weekly windows apart, which duration alone cannot', () => {
    expect(claudeWindowLabel('weekly_all')).toBe('Weekly')
    expect(claudeWindowLabel('weekly_scoped', 'Fable')).toBe('Weekly Fable')
  })

  it('keeps an unknown kind rather than dropping the window', () => {
    expect(claudeWindowLabel('monthly_experiment')).toBe('monthly_experiment')
  })
})

describe('providerUsageFromClaude', () => {
  it('maps the live reply, per-model window included', () => {
    const usage = providerUsageFromClaude(liveReply, 1_000)

    expect(usage.status).toBe('ok')
    expect(usage.plan).toBe('max')
    expect(usage.fetchedAt).toBe(1_000)
    expect(usage.windows.map((window) => window.label)).toEqual([
      '5-hour limit',
      'Weekly',
      'Weekly Fable',
    ])
    expect(usage.windows.map((window) => window.usedPercent)).toEqual([63, 74, 45])
    expect(usage.windows.map((window) => window.minutes)).toEqual([300, 10080, 10080])
    expect(usage.windows[1]?.binding).toBe(true)
    expect(usage.windows[2]?.resetsAt).toBe(Date.parse('2026-08-15T18:59:59.948600+00:00'))
    expect(usage.windows.every((window) => window.severity === 'normal')).toBe(true)
  })

  it('is unavailable when plan limits do not apply at all', () => {
    const usage = providerUsageFromClaude(
      { ...liveReply, rate_limits_available: false },
      1_000,
    )
    expect(usage).toEqual({ provider: 'claude', status: 'unavailable', fetchedAt: 1_000, windows: [] })
  })

  it('is unavailable when only the legacy flat keys are present', () => {
    // The shape is experimental. A payload that drops `limits` must land on "we
    // cannot see it" rather than on a panel with no rows and an implied zero.
    const usage = providerUsageFromClaude(
      { subscription_type: 'max', rate_limits_available: true, rate_limits: { five_hour: { utilization: 63 } } },
      1_000,
    )
    expect(usage.status).toBe('unavailable')
    expect(usage.windows).toEqual([])
  })

  it('is unavailable for a reply that is not this shape at all', () => {
    expect(providerUsageFromClaude('nope', 5).status).toBe('unavailable')
    expect(providerUsageFromClaude(undefined, 5).status).toBe('unavailable')
  })

  it('keeps a window whose reset moment is missing, and drops the field', () => {
    const usage = providerUsageFromClaude(
      { rate_limits_available: true, rate_limits: { limits: [{ kind: 'session', percent: 12, resets_at: null }] } },
      1_000,
    )
    expect(usage.status).toBe('ok')
    expect(usage.windows[0]?.resetsAt).toBeUndefined()
    expect(usage.windows[0]?.usedPercent).toBe(12)
  })
})

describe('readClaudeProviderUsage', () => {
  it('returns unavailable when child stdin breaks', async () => {
    const child = new FakeChild()
    const usage = readClaudeProviderUsage({ command: 'claude', cwd: '/tmp', spawnFn: () => child })
    child.stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }))
    expect((await usage).status).toBe('unavailable')
  })

  it('asks once over the control channel and kills the child with the answer', async () => {
    const child = new FakeChild()
    let written = ''
    child.stdin.on('data', (chunk: Buffer) => {
      written += chunk.toString('utf8')
    })

    let args: readonly string[] = []
    const usage = readClaudeProviderUsage({
      command: 'claude',
      spawnFn: (_command, spawnArgs) => {
        args = spawnArgs
        return child
      },
      cwd: '/tmp',
      now: () => 2_000,
    })

    // The request has to be on the wire before the reply can be matched to it.
    await new Promise((resolve) => setImmediate(resolve))
    const request: unknown = JSON.parse(written.trim())
    expect(request).toMatchObject({ type: 'control_request', request: { subtype: 'get_usage' } })
    expect(args).toContain('--input-format')
    expect(args).toContain('stream-json')

    const requestId = (request as { request_id: string }).request_id
    // Real sessions print hook lines first; only one line in the stream is ours.
    child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'hook_started' })}\n`)
    child.stdout.write(
      `${JSON.stringify({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response: liveReply },
      })}\n`,
    )

    expect((await usage).windows).toHaveLength(3)
    expect(child.killed).toBe(true)
  })

  it('ignores a control response belonging to somebody else', async () => {
    const child = new FakeChild()
    const usage = readClaudeProviderUsage({
      command: 'claude',
      spawnFn: () => child,
      cwd: '/tmp',
      now: () => 3_000,
      timeoutMs: 40,
    })

    await new Promise((resolve) => setImmediate(resolve))
    child.stdout.write(
      `${JSON.stringify({
        type: 'control_response',
        response: { subtype: 'success', request_id: 'someone-else', response: liveReply },
      })}\n`,
    )

    expect((await usage).status).toBe('unavailable')
  })

  it('is unavailable on a timeout, and does not leave the child running', async () => {
    const child = new FakeChild()
    const usage = await readClaudeProviderUsage({
      command: 'claude',
      spawnFn: () => child,
      cwd: '/tmp',
      now: () => 4_000,
      timeoutMs: 10,
    })

    expect(usage).toEqual({ provider: 'claude', status: 'unavailable', fetchedAt: 4_000, windows: [] })
    expect(child.killed).toBe(true)
  })

  it('is unavailable when the CLI cannot be spawned at all', async () => {
    const usage = await readClaudeProviderUsage({
      command: 'claude',
      spawnFn: () => {
        throw new Error('ENOENT')
      },
      cwd: '/tmp',
      now: () => 5_000,
    })
    expect(usage.status).toBe('unavailable')
  })

  it('is unavailable when the control request itself fails', async () => {
    const child = new FakeChild()
    const usage = readClaudeProviderUsage({
      command: 'claude',
      spawnFn: () => child,
      cwd: '/tmp',
      now: () => 6_000,
      timeoutMs: 40,
    })

    await new Promise((resolve) => setImmediate(resolve))
    child.stdout.write(
      `${JSON.stringify({
        type: 'control_response',
        response: { subtype: 'error', request_id: 'x', error: 'not supported' },
      })}\n`,
    )
    // Not ours by request_id, so the timeout is what settles it; either way the
    // answer is the same and no error string reaches the caller.
    expect((await usage).status).toBe('unavailable')
  })
})
