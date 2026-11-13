import type { AttachedMcpServer } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import {
  effectCapabilityEnvKey,
  effectProxyAttachment,
  proxySecretEnv,
  type EffectProxyUpstream,
} from '../src/mcp/effectProxyAttachment.js'

const attached: AttachedMcpServer = {
  server: {
    id: 'mcp-composio',
    name: 'composio',
    command: '',
    args: [],
    envKeys: ['COMPOSIO_API_KEY'],
    httpHeaders: [{ name: 'x-api-key', envKey: 'COMPOSIO_API_KEY' }],
    url: 'https://connect.example/mcp',
    description: '',
    writes: true,
    effectPolicy: 'confirm_writes',
    tools: ['COMPOSIO_MULTI_EXECUTE_TOOL'],
    readOnlyTools: [],
    schemaChars: 0,
  },
  disabledTools: [],
  runtimeEnv: { COMPOSIO_API_KEY: 'ak_secret' },
}

describe('effectProxyAttachment', () => {
  it('keeps the model namespace but makes the Manor proxy the only transport', () => {
    const proxied = effectProxyAttachment(attached, 'http://127.0.0.1/effects', 'cap_secret', {
      execPath: '/node',
      execArgv: [],
      entryPath: '/effectProxyMcp.ts',
    })
    expect(proxied.server).toMatchObject({
      id: 'mcp-composio',
      name: 'composio',
      command: '/node',
      url: undefined,
      httpHeaders: undefined,
    })
    expect(proxied.runtimeEnv).toEqual({
      [effectCapabilityEnvKey('mcp-composio')]: 'cap_secret',
    })
    expect(proxied.server.envKeys).toEqual([])
  })

  it('puts only credential names, never values, in the proxy argv', () => {
    const proxied = effectProxyAttachment(attached, 'http://127.0.0.1/effects', 'cap_secret', {
      execPath: '/node',
      execArgv: [],
      entryPath: '/effectProxyMcp.ts',
    })
    const encoded = proxied.server.args.at(-1)
    if (encoded === undefined) throw new Error('missing upstream config')
    const upstream = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as EffectProxyUpstream
    expect(upstream).toMatchObject({
      name: 'composio',
      url: 'https://connect.example/mcp',
      httpHeaders: { 'x-api-key': 'COMPOSIO_API_KEY' },
    })
    expect(proxied.server.args.join(' ')).not.toContain('ak_secret')
    expect(proxied.server.args.join(' ')).not.toContain('cap_secret')
    expect(proxied.server.args.join(' ')).not.toContain('manor-mcp-env')
    expect(proxySecretEnv(attached)).toEqual({ COMPOSIO_API_KEY: 'ak_secret' })
  })

  it('does not let punctuation-equivalent server ids share a capability variable', () => {
    expect(effectCapabilityEnvKey('server-a')).not.toBe(effectCapabilityEnvKey('server_a'))
  })
})
