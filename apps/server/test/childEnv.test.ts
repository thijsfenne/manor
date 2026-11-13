import { describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  appendChildErrorTail,
  attachedMcpEnvironment,
  CHILD_ERROR_TAIL_CHARS,
  childProcessEnv,
  redactGrantedEnvValues,
  resolveCliCommand,
  upstreamProcessEnv,
} from '../src/childEnv.js'

it('resolves provider executables to absolute paths without running them', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'manor-cli-command-'))
  try {
    const home = path.join(root, 'home')
    const pathDir = path.join(root, 'path')
    const localDir = path.join(home, '.local', 'bin')
    mkdirSync(pathDir, { recursive: true })
    mkdirSync(localDir, { recursive: true })
    const fromPath = path.join(pathDir, 'claude')
    const fromHome = path.join(localDir, 'grok')
    for (const file of [fromPath, fromHome]) {
      writeFileSync(file, '')
      chmodSync(file, 0o755)
    }

    expect(resolveCliCommand('claude', { HOME: home, PATH: pathDir })).toBe(fromPath)
    expect(resolveCliCommand('grok', { HOME: home, PATH: '' })).toBe(fromHome)
    expect(resolveCliCommand('agent', { HOME: home, PATH: '' })).toBe('agent')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('childProcessEnv', () => {
  it('keeps runtime essentials and strips application credentials', () => {
    const env = childProcessEnv({
      PATH: '/usr/bin',
      HOME: '/home/manor',
      SUPABASE_SECRET_KEY: 'database-secret',
      MANOR_GITHUB_TOKEN: 'repository-secret',
    })

    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/manor' })
  })

  it('keeps the account name a provider CLI resolves its keychain login with', () => {
    const env = childProcessEnv({ PATH: '/usr/bin', USER: 'manor', LOGNAME: 'manor' })

    expect(env).toEqual({ PATH: '/usr/bin', USER: 'manor', LOGNAME: 'manor' })
  })

  it('passes only capability keys that were explicitly granted', () => {
    const env = childProcessEnv(
      { PATH: '/usr/bin', MCP_TOKEN: 'allowed', OTHER_TOKEN: 'blocked' },
      ['MCP_TOKEN'],
      { CODEX_HOME: '/tmp/codex-home' },
    )

    expect(env).toEqual({ PATH: '/usr/bin', MCP_TOKEN: 'allowed', CODEX_HOME: '/tmp/codex-home' })
  })

  it('keeps per-turn MCP values out of the server env while granting them to one child', () => {
    const resolved = attachedMcpEnvironment([{
      server: {
        id: 'browser',
        name: 'browser',
        command: 'node',
        args: [],
        envKeys: [],
        description: '',
        writes: true,
        effectPolicy: 'confirm_writes' as const,
        tools: [],
        readOnlyTools: [],
        schemaChars: 0,
      },
      disabledTools: [],
      runtimeEnv: { MANOR_BROWSER_BROKER_CAPABILITY: 'turn-token' },
    }], { PATH: '/usr/bin' })

    expect(resolved.grantedKeys).toEqual(['MANOR_BROWSER_BROKER_CAPABILITY'])
    expect(resolved.sourceEnv).toEqual({
      PATH: '/usr/bin',
      MANOR_BROWSER_BROKER_CAPABILITY: 'turn-token',
    })
  })

  it('does not grant connector secrets to the provider CLI', () => {
    const resolved = attachedMcpEnvironment([{
      server: {
        id: 'mail',
        name: 'mail',
        command: 'node',
        args: [],
        envKeys: ['MANOR_MAIL_IMAP_PASSWORD'],
        description: '',
        writes: true,
        effectPolicy: 'confirm_writes' as const,
        tools: [],
        readOnlyTools: [],
        schemaChars: 0,
      },
      disabledTools: [],
      runtimeEnv: {
        MANOR_MAIL_IMAP_PASSWORD: 'imap-secret',
        MANOR_EFFECT_BROKER_CAPABILITY_MAIL: 'turn-token',
      },
    }], { PATH: '/usr/bin', MANOR_MAIL_IMAP_PASSWORD: 'host-secret' })

    expect(resolved.grantedKeys).toEqual(['MANOR_EFFECT_BROKER_CAPABILITY_MAIL'])
    expect(childProcessEnv(resolved.sourceEnv, resolved.grantedKeys)).toEqual({
      PATH: '/usr/bin',
      MANOR_EFFECT_BROKER_CAPABILITY_MAIL: 'turn-token',
    })
  })

  it('keeps HOME and sibling secrets out of an upstream MCP env', () => {
    const env = upstreamProcessEnv(
      {
        PATH: '/usr/bin',
        HOME: '/Users/sam',
        SIBLING_SECRET: 'other-mailbox',
        MANOR_MAIL_IMAP_PASSWORD: 'imap-secret',
      },
      ['MANOR_MAIL_IMAP_PASSWORD'],
    )

    expect(env).toEqual({ PATH: '/usr/bin', MANOR_MAIL_IMAP_PASSWORD: 'imap-secret' })
  })

  it('redacts granted capability values from child output, longest first', () => {
    const output = redactGrantedEnvValues(
      'token=secret-long and short=secret',
      { LONG_TOKEN: 'secret-long', SHORT_TOKEN: 'secret', UNRELATED: 'visible' },
      ['SHORT_TOKEN', 'LONG_TOKEN'],
    )

    expect(output).toBe('token=[redacted] and short=[redacted]')
  })

  it('keeps a bounded stderr tail instead of a process-lifetime buffer', () => {
    const stderr = appendChildErrorTail('discard me\n', 'x'.repeat(CHILD_ERROR_TAIL_CHARS) + 'last line')

    expect(stderr).toHaveLength(CHILD_ERROR_TAIL_CHARS)
    expect(stderr).not.toContain('discard me')
    expect(stderr.endsWith('last line')).toBe(true)
  })

  it('redacts a complete secret before truncation can expose its suffix', () => {
    const redact = (text: string) =>
      redactGrantedEnvValues(text, { MCP_TOKEN: 'capability-secret' }, ['MCP_TOKEN'])
    const stderr = appendChildErrorTail('', 'xcapability-secret', redact, 16)

    expect(stderr).toBe('x[redacted]')
    expect(stderr).not.toContain('apability-secret')
  })
})
