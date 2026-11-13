import type { McpServerConfig } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import {
  EffectCapabilities,
  InvalidEffectCapabilityError,
  InvalidEffectRequestError,
} from '../src/effectCapability.js'

const server: McpServerConfig = {
  id: 'mcp_1',
  name: 'gmail',
  command: '/bin/true',
  args: [],
  envKeys: [],
  description: '',
  writes: true,
  effectPolicy: 'confirm_writes',
  tools: ['get_message', 'send_message'],
  readOnlyTools: ['get_message'],
  schemaChars: 0,
}

describe('EffectCapabilities', () => {
  it('stays usable until its turn closes', () => {
    const capabilities = new EffectCapabilities()
    capabilities.issue({ chatId: 'chat_1', agentId: 'sage', turnId: 'turn_1', canApprove: true }, server, 'long-turn')
    expect(capabilities.take('long-turn', 'get_message').turnId).toBe('turn_1')
    capabilities.closeTurn('turn_1')
    expect(() => capabilities.take('long-turn', 'get_message')).toThrow(InvalidEffectCapabilityError)
  })

  it('binds actor, turn, connector and policy outside provider arguments', () => {
    const capabilities = new EffectCapabilities()
    capabilities.issue(
      { chatId: 'chat_1', agentId: 'sage', turnId: 'turn_1', canApprove: false, readOnly: true },
      server,
      'capability',
    )
    expect(capabilities.take('capability', 'send_message')).toEqual({
      chatId: 'chat_1',
      agentId: 'sage',
      turnId: 'turn_1',
      canApprove: false,
      readOnly: true,
      connector: { id: 'mcp_1', name: 'gmail' },
      tool: 'send_message',
      effect: 'confirm_write',
    })
  })

  it('rejects unknown tokens and missing tool names', () => {
    const capabilities = new EffectCapabilities()
    expect(() => capabilities.take('unknown', 'send_message')).toThrow(InvalidEffectCapabilityError)
    expect(() => capabilities.take(undefined, '')).toThrow(InvalidEffectCapabilityError)
  })

  it('keeps only Composio action slugs for a useful approval label', () => {
    const capabilities = new EffectCapabilities()
    capabilities.issue(
      { chatId: 'chat_1', agentId: 'sage', turnId: 'turn_1', canApprove: true },
      { ...server, name: 'composio', tools: ['COMPOSIO_MULTI_EXECUTE_TOOL'], readOnlyTools: [] },
      'capability',
    )
    expect(capabilities.take('capability', 'COMPOSIO_MULTI_EXECUTE_TOOL', {
      tools: [{ tool_slug: 'GMAIL_SEND_EMAIL' }],
    })).toMatchObject({ actions: ['GMAIL_SEND_EMAIL'], actionCount: 1 })
  })

  it('classifies a Gmail fetch as read even when an unattended routine calls it', () => {
    const capabilities = new EffectCapabilities()
    capabilities.issue(
      { chatId: 'chat_1', agentId: 'post', turnId: 'turn_1', canApprove: false },
      { ...server, name: 'composio', tools: ['COMPOSIO_MULTI_EXECUTE_TOOL'], readOnlyTools: [] },
      'capability',
    )
    expect(capabilities.take('capability', 'COMPOSIO_MULTI_EXECUTE_TOOL', {
      tools: [{ tool_slug: 'GMAIL_FETCH_EMAILS' }, { tool_slug: 'GMAIL_FETCH_EMAILS' }],
    })).toMatchObject({ effect: 'read', actionCount: 2 })
  })

  it('rejects malformed and oversized Composio batches before they can ask for approval', () => {
    const capabilities = new EffectCapabilities()
    capabilities.issue(
      { chatId: 'chat_1', agentId: 'sage', turnId: 'turn_1', canApprove: true },
      { ...server, name: 'composio', tools: ['COMPOSIO_MULTI_EXECUTE_TOOL'], readOnlyTools: [] },
      'capability',
    )
    expect(() => capabilities.take('capability', 'COMPOSIO_MULTI_EXECUTE_TOOL', {
      tools: [{ not_a_slug: 'LINEAR_CREATE_ISSUE' }],
    })).toThrow(InvalidEffectRequestError)
    expect(() => capabilities.take('capability', 'COMPOSIO_MULTI_EXECUTE_TOOL', {
      tools: Array.from({ length: 51 }, () => ({ tool_slug: 'LINEAR_CREATE_ISSUE' })),
    })).toThrow(InvalidEffectRequestError)
  })

  it('hands connector secrets to the proxy once, then drops them', () => {
    const capabilities = new EffectCapabilities()
    capabilities.issue(
      { chatId: 'chat_1', agentId: 'sage', turnId: 'turn_1', canApprove: true },
      server,
      'capability',
      { MANOR_MAIL_IMAP_PASSWORD: 'imap-secret' },
    )
    expect(capabilities.takeEnv('capability')).toEqual({ MANOR_MAIL_IMAP_PASSWORD: 'imap-secret' })
    expect(capabilities.takeEnv('capability')).toEqual({})
    expect(capabilities.take('capability', 'get_message')).toMatchObject({ tool: 'get_message' })
  })

  it('revokes every connector capability when its turn ends', () => {
    const capabilities = new EffectCapabilities()
    capabilities.issue(
      { chatId: 'chat_1', agentId: 'sage', turnId: 'turn_1', canApprove: true },
      server,
      'capability',
    )
    capabilities.closeTurn('turn_1')
    expect(() => capabilities.take('capability', 'send_message')).toThrow(InvalidEffectCapabilityError)
  })
  it('exposes review input only for probed tools with complete, non-secret arguments', () => {
    const capabilities = new EffectCapabilities()
    capabilities.issue({ chatId: 'chat_1', agentId: 'sage', turnId: 'turn_1', canApprove: true }, server, 'capability')
    expect(capabilities.take('capability', 'send_message', undefined, { body: 'draft' }).reviewArguments)
      .toEqual({ body: 'draft' })
    expect(capabilities.take('capability', 'unknown', undefined, { body: 'draft' }).reviewArguments).toBeUndefined()
    expect(capabilities.take('capability', 'send_message', undefined, { token: 'secret' }).reviewArguments).toBeUndefined()
  })

  it('refuses review arguments for a different Composio action batch', () => {
    const capabilities = new EffectCapabilities()
    capabilities.issue({ chatId: 'chat_1', agentId: 'sage', turnId: 'turn_1', canApprove: true },
      { ...server, name: 'composio', tools: ['COMPOSIO_MULTI_EXECUTE_TOOL'] }, 'capability')
    expect(capabilities.take('capability', 'COMPOSIO_MULTI_EXECUTE_TOOL',
      { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL' }] },
      { tools: [{ tool_slug: 'GMAIL_FETCH_EMAILS' }] }).reviewArguments).toBeUndefined()
  })

})
