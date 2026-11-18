import { mkdtempSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DELEGATION_CAP,
  DEFAULT_DEV_ORIGINS,
  DEFAULT_RELAY_CAP,
  DEFAULT_RELAY_DEPTH,
  resolveAllowedOrigins,
  resolveAuthConfig,
  resolveDelegationCap,
  resolveListenHost,
  resolveMyMindConfig,
  resolveRelayLimits,
  resolveRoutinesMode,
  resolveStoreConfig,
  resolveUnauthenticatedBind,
  resolveRemindersMode,
  resolveVaultDir,
  type StoreConfig,
} from '../src/config.js'

describe('resolveAllowedOrigins', () => {
  it('allows the fixed Vite development origins by default', () => {
    expect(resolveAllowedOrigins({})).toEqual({ ok: true, origins: [...DEFAULT_DEV_ORIGINS] })
  })

  it('adds configured origins, normalises trailing slashes and removes duplicates', () => {
    expect(
      resolveAllowedOrigins({
        MANOR_ALLOWED_ORIGINS: 'https://manor.example/, http://localhost:5173',
      }),
    ).toEqual({ ok: true, origins: [...DEFAULT_DEV_ORIGINS, 'https://manor.example'] })
  })

  it('refuses a URL with a path or a non-http protocol', () => {
    for (const value of ['https://manor.example/chat', 'file:///tmp/manor']) {
      const result = resolveAllowedOrigins({ MANOR_ALLOWED_ORIGINS: value })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected a failure')
      expect(result.message).toContain(value)
    }
  })
})

describe('resolveStoreConfig', () => {
  it('runs on local SQLite when MANOR_STORE is unset', () => {
    const env = { MANOR_SQLITE_PATH: '/private/manor.db' }
    const sqlite = { ok: true, config: { kind: 'sqlite', filename: '/private/manor.db' } }
    expect(resolveStoreConfig(env)).toEqual(sqlite)
    expect(resolveStoreConfig({ ...env, MANOR_STORE: '' })).toEqual(sqlite)
  })

  it('refuses the mock driver on the live database, and allows it on a copy', () => {
    const live = path.join(os.userInfo().homedir, '.manor', 'sqlite', 'manor.db')
    for (const env of [{ MANOR_DRIVER: 'mock', MANOR_DATA_DIR: path.dirname(path.dirname(live)) }, { MANOR_DRIVER: 'mock', MANOR_SQLITE_PATH: live }]) {
      const result = resolveStoreConfig(env)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected a failure')
      expect(result.message).toContain('MANOR_DRIVER=mock')
    }
    const link = path.join(mkdtempSync(path.join(os.tmpdir(), 'manor-live-link-')), 'manor.db')
    symlinkSync(live, link)
    expect(resolveStoreConfig({ MANOR_DRIVER: 'mock', MANOR_SQLITE_PATH: link }).ok).toBe(false)
    expect(resolveStoreConfig({ MANOR_DRIVER: 'mock', MANOR_SQLITE_PATH: '/tmp/spike/manor.db' }).ok).toBe(true)
    expect(resolveStoreConfig({}).ok).toBe(true)
  })

  it('refuses an unknown store instead of falling through to another one', () => {
    const result = resolveStoreConfig({ MANOR_STORE: 'sqlit' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.message).toContain('MANOR_STORE=sqlit')
    for (const allowed of ['"sqlite"', '"memory"']) expect(result.message).toContain(allowed)
    expect(result.message).not.toContain('supabase')
  })

  it('refuses the removed Supabase store like any other unknown value', () => {
    const result = resolveStoreConfig({ MANOR_STORE: 'supabase', SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SECRET_KEY: 'sb_secret_x' })

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.message).toContain('MANOR_STORE=supabase is not a store')
    expect(result.message.split('\n')).toHaveLength(1)
  })

  it('takes the memory escape hatch without any credentials', () => {
    const result = resolveStoreConfig({ MANOR_STORE: 'memory' })

    expect(result).toEqual({ ok: true, config: { kind: 'memory' } })
  })

})

const memory: StoreConfig = { kind: 'memory' }
const sqlite: StoreConfig = { kind: 'sqlite', filename: '/private/manor.db' }

describe('resolveAuthConfig', () => {
  it('is off by default over the memory store, so the tests and local runs need nothing', () => {
    expect(resolveAuthConfig({}, memory)).toEqual({ ok: true, config: { mode: 'off' } })
  })

  it('is on by default over the SQLite store', () => {
    expect(resolveAuthConfig({}, sqlite)).toEqual({ ok: true, config: { mode: 'on', filename: '/private/manor.db' } })
  })

  it('takes MANOR_AUTH=off over the store default', () => {
    expect(resolveAuthConfig({ MANOR_AUTH: 'off' }, sqlite)).toEqual({ ok: true, config: { mode: 'off' } })
  })

  it('fails fast when auth is asked for over the memory store, which has no account to check', () => {
    const result = resolveAuthConfig({ MANOR_AUTH: 'on' }, memory)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.message).toContain('MANOR_AUTH=off')
    expect(result.message.split('\n')).toHaveLength(1)
  })

  it('refuses a MANOR_AUTH it does not understand rather than guessing', () => {
    const result = resolveAuthConfig({ MANOR_AUTH: 'true' }, sqlite)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.message).toContain('MANOR_AUTH=true')
  })
})

describe('resolveListenHost', () => {
  it('binds loopback when nothing is set, so a memory store is not LAN-open', () => {
    expect(resolveListenHost({})).toBe('127.0.0.1')
    expect(resolveListenHost({ MANOR_HOST: '   ' })).toBe('127.0.0.1')
  })

  it('takes an explicit host, including the VPS tailnet address', () => {
    expect(resolveListenHost({ MANOR_HOST: '100.64.0.2' })).toBe('100.64.0.2')
  })
})

describe('resolveUnauthenticatedBind', () => {
  const off = { mode: 'off' } as const
  const on = { mode: 'on', filename: '/private/manor.db' } as const

  it('allows auth-off on loopback and auth-on anywhere', () => {
    expect(resolveUnauthenticatedBind({}, off, '127.0.0.1')).toEqual({ ok: true })
    expect(resolveUnauthenticatedBind({}, off, 'localhost')).toEqual({ ok: true })
    expect(resolveUnauthenticatedBind({}, off, '::1')).toEqual({ ok: true })
    expect(resolveUnauthenticatedBind({}, on, '0.0.0.0')).toEqual({ ok: true })
  })

  it('refuses auth-off on a non-loopback host', () => {
    const result = resolveUnauthenticatedBind({}, off, '0.0.0.0')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.message).toContain('MANOR_HOST=0.0.0.0')
    expect(result.message.split('\n')).toHaveLength(1)
  })

  it('allows that bind only when the escape hatch is exactly true', () => {
    expect(
      resolveUnauthenticatedBind({ MANOR_ALLOW_UNAUTHENTICATED_NETWORK: 'true' }, off, '0.0.0.0'),
    ).toEqual({ ok: true })
    const result = resolveUnauthenticatedBind({ MANOR_ALLOW_UNAUTHENTICATED_NETWORK: 'yes' }, off, '0.0.0.0')
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.message).toContain('MANOR_ALLOW_UNAUTHENTICATED_NETWORK=yes')
  })
})

describe('resolveDelegationCap', () => {
  it('defaults to three delegated turns per message', () => {
    expect(resolveDelegationCap({})).toEqual({ ok: true, cap: DEFAULT_DELEGATION_CAP })
    expect(resolveDelegationCap({ MANOR_DELEGATION_CAP: '' })).toEqual({ ok: true, cap: 5 })
  })

  it('takes a whole number, including zero as "no delegation"', () => {
    expect(resolveDelegationCap({ MANOR_DELEGATION_CAP: '2' })).toEqual({ ok: true, cap: 2 })
    expect(resolveDelegationCap({ MANOR_DELEGATION_CAP: '0' })).toEqual({ ok: true, cap: 0 })
  })

  it('fails fast on a cap it cannot use rather than quietly defaulting', () => {
    for (const value of ['two', '-1', '1.5', 'NaN']) {
      const result = resolveDelegationCap({ MANOR_DELEGATION_CAP: value })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected a failure')
      expect(result.message).toContain(`MANOR_DELEGATION_CAP=${value}`)
      expect(result.message.split('\n')).toHaveLength(1)
    }
  })
})

describe('resolveRelayLimits', () => {
  it('defaults to a two-hop chain and four agent turns', () => {
    expect(resolveRelayLimits({})).toEqual({ ok: true, depth: DEFAULT_RELAY_DEPTH, cap: DEFAULT_RELAY_CAP })
  })

  it('accepts explicit whole-number limits, including zero', () => {
    expect(resolveRelayLimits({ MANOR_RELAY_DEPTH: '0', MANOR_RELAY_CAP: '7' }))
      .toEqual({ ok: true, depth: 0, cap: 7 })
  })

  it('fails fast on unusable depth and cap settings', () => {
    for (const env of [
      { MANOR_RELAY_DEPTH: '-1' },
      { MANOR_RELAY_DEPTH: '1.5' },
      { MANOR_RELAY_CAP: 'four' },
      { MANOR_RELAY_CAP: '-1' },
    ]) {
      const result = resolveRelayLimits(env)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected a failure')
      expect(result.message.split('\n')).toHaveLength(1)
    }
  })
})

describe('resolveRemindersMode', () => {
  it('is off until asked for, follows the tool in a mock run, and refuses a typo', () => {
    expect(resolveRemindersMode({}, false)).toEqual({ ok: true, on: false })
    expect(resolveRemindersMode({ MANOR_REMINDERS: 'on' }, false)).toEqual({ ok: true, on: true })
    expect(resolveRemindersMode({}, true)).toEqual({ ok: true, on: true })
    expect(resolveRemindersMode({ MANOR_REMINDERS: 'off' }, true)).toEqual({ ok: true, on: false })
    expect(resolveRemindersMode({ MANOR_REMINDERS: 'yes' }, false)).toMatchObject({ ok: false })
  })
})

describe('resolveVaultDir', () => {
  const HOME = '/Users/someone'

  it('defaults to a folder beside the database, wherever the data directory is', () => {
    expect(resolveVaultDir({}, HOME)).toEqual({ ok: true, dir: `${HOME}/.manor/knowledge`, source: 'default' })
    expect(resolveVaultDir({ MANOR_VAULT_DIR: '   ', MANOR_DATA_DIR: '/tmp/spike/' }, HOME))
      .toEqual({ ok: true, dir: '/tmp/spike/knowledge', source: 'default' })
  })

  it('takes the folder picked in Settings, and lets the environment win over it', () => {
    expect(resolveVaultDir({}, HOME, '~/Notes/')).toEqual({ ok: true, dir: `${HOME}/Notes`, source: 'setting' })
    expect(resolveVaultDir({ MANOR_VAULT_DIR: '/vault' }, HOME, '~/Notes')).toEqual({ ok: true, dir: '/vault', source: 'env' })
  })

  it('expands a leading tilde, because that is how the path gets typed', () => {
    expect(resolveVaultDir({ MANOR_VAULT_DIR: '~/Notes/Notes' }, HOME)).toEqual({
      ok: true,
      dir: `${HOME}/Notes/Notes`,
      source: 'env',
    })
    expect(resolveVaultDir({ MANOR_VAULT_DIR: '~' }, HOME)).toEqual({ ok: true, dir: HOME, source: 'env' })
  })

  it('keeps an absolute path as it stands', () => {
    const dir = '/Users/someone/Library/Mobile Documents/iCloud~md~obsidian/Documents/Notes'
    expect(resolveVaultDir({ MANOR_VAULT_DIR: dir }, HOME)).toEqual({ ok: true, dir, source: 'env' })
  })

  // A relative path would resolve against the server's cwd, which is not a place
  // anybody means. Saying so beats silently reading a folder nobody pointed at.
  it('refuses a relative path and says what to give instead', () => {
    const result = resolveVaultDir({ MANOR_VAULT_DIR: 'Documents/Notes' }, HOME)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure')
    expect(result.message).toContain('MANOR_VAULT_DIR=Documents/Notes')
    expect(result.message.split('\n')).toHaveLength(1)
  })
})

describe('resolveMyMindConfig', () => {
  const secret128 = Buffer.from('0123456789abcdef').toString('base64')
  const secret256 = Buffer.from('0123456789abcdef0123456789abcdef').toString('base64')

  it('keeps Artifacts absent when no credentials are configured', () => {
    expect(resolveMyMindConfig({})).toEqual({ ok: true, config: undefined })
  })

  it('accepts the key id and issued 128-bit private key as one pair', () => {
    expect(resolveMyMindConfig({ MANOR_MYMIND_KEY_ID: 'key_123', MANOR_MYMIND_SECRET: secret128 })).toEqual({
      ok: true,
      config: { keyId: 'key_123', secret: secret128 },
    })
  })

  it('accepts the 256-bit private key currently issued by mymind too', () => {
    expect(resolveMyMindConfig({ MANOR_MYMIND_KEY_ID: 'key_123', MANOR_MYMIND_SECRET: secret256 })).toEqual({
      ok: true,
      config: { keyId: 'key_123', secret: secret256 },
    })
  })

  it('refuses a half pair or a value that is not the issued base64 secret', () => {
    expect(resolveMyMindConfig({ MANOR_MYMIND_KEY_ID: 'key_123' }).ok).toBe(false)
    expect(resolveMyMindConfig({ MANOR_MYMIND_SECRET: secret128 }).ok).toBe(false)
    expect(resolveMyMindConfig({ MANOR_MYMIND_KEY_ID: 'key_123', MANOR_MYMIND_SECRET: 'private-key' }).ok).toBe(false)
  })
})

describe('resolveRoutinesMode', () => {
  // Off unless a server says otherwise: `pnpm dev` on 8787 and the stable server on
  // 43179 hit the same SQLite database, so a scheduler that ran everywhere would fire every
  // routine twice, on whichever tree happened to be half-edited.
  it('is off when unset, and off is a setting you can say out loud', () => {
    expect(resolveRoutinesMode({})).toEqual({ ok: true, on: false })
    expect(resolveRoutinesMode({ MANOR_ROUTINES: '' })).toEqual({ ok: true, on: false })
    expect(resolveRoutinesMode({ MANOR_ROUTINES: 'off' })).toEqual({ ok: true, on: false })
    expect(resolveRoutinesMode({ MANOR_ROUTINES: 'on' })).toEqual({ ok: true, on: true })
  })

  it('is fatal on anything else, because nothing running would show it was ignored', () => {
    for (const value of ['yes', 'true', '1', 'ON']) {
      const result = resolveRoutinesMode({ MANOR_ROUTINES: value })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected a failure')
      expect(result.message).toContain(value)
    }
  })
})

it('resolves local SQLite auth', () => {
  const store = resolveStoreConfig({ MANOR_STORE: 'sqlite', MANOR_SQLITE_PATH: '/private/manor.db' })
  expect(store).toEqual({ ok: true, config: { kind: 'sqlite', filename: '/private/manor.db' } })
  if (!store.ok) throw new Error('expected SQLite config')
  expect(resolveAuthConfig({}, store.config)).toEqual({ ok: true, config: { mode: 'on', filename: '/private/manor.db' } })
})
