import type { Driver, ProviderVersionCheck, ServerMessage, TurnHandle } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { compareVersions, failureLine } from '../src/drivers/providerUpdate.js'
import { ProviderUpdateService } from '../src/providerUpdates.js'

const never: Driver['startTurn'] = (): TurnHandle => {
  throw new Error('probed, never run')
}

function driver(checks: (ProviderVersionCheck | null)[], install?: Driver['installUpdate']): Driver {
  let calls = 0
  return {
    startTurn: never,
    checkForUpdate: async () => checks[Math.min(calls++, checks.length - 1)] ?? null,
    ...(install === undefined ? {} : { installUpdate: install }),
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

describe('ProviderUpdateService', () => {
  it('lists only providers behind their latest and keeps pinned ones buttonless', async () => {
    const sent: ServerMessage[] = []
    const service = new ProviderUpdateService({
      drivers: {
        claude: driver([{ currentVersion: '2.1.281', latestVersion: '2.1.281', canUpdate: true }]),
        codex: driver([{ currentVersion: '0.155.1', latestVersion: '0.156.1', canUpdate: false }]),
        cursor: { startTurn: never },
      },
      broadcast: (message) => sent.push(message),
    })
    await service.checkAll()
    expect(service.message().updates).toEqual([
      { provider: 'codex', currentVersion: '0.155.1', latestVersion: '0.156.1', canUpdate: false, state: 'available' },
    ])
    await service.install()
    expect(service.message().updates[0]?.state).toBe('available')
    expect(sent).toHaveLength(1)
  })

  it('updates, verifies the new version, then drops the entry', async () => {
    const sent: ServerMessage[] = []
    const service = new ProviderUpdateService({
      drivers: {
        grok: driver(
          [{ currentVersion: '1.0.41', latestVersion: '1.0.42', canUpdate: true }, { currentVersion: '1.0.42', latestVersion: '1.0.42', canUpdate: true }],
          async () => ({ ok: true }),
        ),
      },
      broadcast: (message) => sent.push(message),
      updatedLingerMs: 0,
    })
    await service.checkAll()
    await service.install('grok')
    const states = sent.flatMap((message) => (message.type === 'provider_updates' ? [message.updates[0]?.state] : []))
    expect(states).toEqual(['available', 'updating', 'updated'])
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(service.message().updates).toEqual([])
  })

  it('reports a failed updater, and one that exits clean but leaves the old version', async () => {
    const service = new ProviderUpdateService({
      drivers: {
        claude: driver([{ currentVersion: '2.1.280', latestVersion: '2.1.281', canUpdate: true }], async () => ({ ok: false, reason: 'EACCES' })),
        grok: driver([{ currentVersion: '1.0.41', latestVersion: '1.0.42', canUpdate: true }], async () => ({ ok: true })),
      },
      broadcast: () => undefined,
    })
    await service.checkAll()
    await service.install()
    await settle()
    const byProvider = Object.fromEntries(service.message().updates.map((entry) => [entry.provider, entry]))
    expect(byProvider['claude']).toMatchObject({ state: 'failed', error: 'EACCES' })
    expect(byProvider['grok']).toMatchObject({ state: 'failed', error: 'Still on 1.0.41 after the update.' })
  })

  it('does not let a check that was in flight reopen a running update', async () => {
    let releaseCheck: (value: ProviderVersionCheck) => void = () => undefined
    let calls = 0
    let installs = 0
    const behind = { currentVersion: '1.0.41', latestVersion: '1.0.42', canUpdate: true }
    const service = new ProviderUpdateService({
      drivers: {
        grok: {
          startTurn: never,
          checkForUpdate: () => (calls++ === 1 ? new Promise((resolve) => { releaseCheck = resolve }) : Promise.resolve(behind)),
          installUpdate: () => { installs += 1; return new Promise(() => undefined) },
        },
      },
      broadcast: () => undefined,
    })
    await service.checkAll()
    const slowCheck = service.checkAll()
    void service.install()
    releaseCheck(behind)
    await slowCheck
    expect(service.message().updates[0]?.state).toBe('updating')
    void service.install()
    expect(installs).toBe(1)
  })

  it('ignores a check that began before an update, even after the update finished and dropped', async () => {
    let releaseCheck: (value: ProviderVersionCheck) => void = () => undefined
    let calls = 0
    const behind = { currentVersion: '1.0.41', latestVersion: '1.0.42', canUpdate: true }
    const current = { currentVersion: '1.0.42', latestVersion: '1.0.42', canUpdate: true }
    const service = new ProviderUpdateService({
      drivers: {
        grok: {
          startTurn: never,
          checkForUpdate: () => {
            calls += 1
            if (calls === 1) return Promise.resolve(behind)
            if (calls === 2) return new Promise((resolve) => { releaseCheck = resolve })
            return Promise.resolve(current)
          },
          installUpdate: async () => ({ ok: true }),
        },
      },
      broadcast: () => undefined,
      updatedLingerMs: 0,
    })
    await service.checkAll()
    const staleCheck = service.checkAll()
    await service.install()
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(service.message().updates).toEqual([])
    releaseCheck(behind)
    await staleCheck
    expect(service.message().updates).toEqual([])
  })

  it('does not claim success when the new version cannot be confirmed', async () => {
    const service = new ProviderUpdateService({
      drivers: { claude: driver([{ currentVersion: '2.1.280', latestVersion: '2.1.281', canUpdate: true }, null], async () => ({ ok: true })) },
      broadcast: () => undefined,
    })
    await service.checkAll()
    await service.install()
    expect(service.message().updates[0]).toMatchObject({ state: 'failed', error: 'The updater finished, but the new version could not be confirmed.' })
  })

  it("reports pnpm's error line, not the auth hint printed after it", () => {
    const stdout = [
      'Progress: resolved 1, reused 0',
      ' ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/@openai%2Fcodex/-/codex-0.159.0-darwin-arm64.tgz: Not Found - 404',
      '',
      'No authorization header was set for the request.',
    ].join('\n')
    expect(failureLine(stdout, '')).toBe('FETCH_404 GET https://registry.npmjs.org/@openai%2Fcodex/-/codex-0.159.0-darwin-arm64.tgz: Not Found - 404')
    expect(failureLine('', 'first\nlast line\n')).toBe('last line')
  })

  it('shows a first install as it runs and settles it like an update', async () => {
    const sent: ServerMessage[] = []
    let finish: (result: { ok: true } | { ok: false; reason: string }) => void = () => undefined
    const done = new Promise<{ ok: true } | { ok: false; reason: string }>((resolve) => { finish = resolve })
    const service = new ProviderUpdateService({
      drivers: { codex: { startTurn: never, prepareRuntime: async () => ({ version: '0.164.0', done }) }, claude: { startTurn: never, prepareRuntime: async () => null } },
      broadcast: (message) => sent.push(message),
      updatedLingerMs: 5,
    })
    service.start()
    await settle()
    expect(service.message().updates).toEqual([{ provider: 'codex', currentVersion: '', latestVersion: '0.164.0', canUpdate: true, state: 'updating' }])
    finish({ ok: false, reason: 'Codex 0.164.0 could not be downloaded.' })
    await settle()
    expect(service.message().updates[0]).toMatchObject({ state: 'failed', error: 'Codex 0.164.0 could not be downloaded.' })
    service.stop()
  })

  it('compares dotted versions numerically', () => {
    expect(compareVersions('0.155.1', '0.156.1')).toBeLessThan(0)
    expect(compareVersions('2.1.10', '2.1.9')).toBeGreaterThan(0)
    expect(compareVersions('2026.09.23-86fc751', '2026.09.23')).toBe(0)
  })
})
