import type { AttachedMcpServer, RuntimeEvent, TurnInput } from '@manor/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createMockDriver } from '../src/drivers/mockDriver.js'
import { marlow, sage } from './helpers.js'

const interaction: AttachedMcpServer = {
  server: {
    id: 'builtin_manor',
    name: 'manor',
    command: '',
    args: ['--relay-url', 'http://127.0.0.1:8787/internal/agent-relay'],
    envKeys: [],
    description: '',
    writes: false,
    effectPolicy: 'trusted',
    tools: ['message_agent'],
    readOnlyTools: [],
    schemaChars: 0,
  },
  disabledTools: [],
  runtimeEnv: { MANOR_USER_INPUT_CAPABILITY: 'turn-secret' },
}

describe('mock driver agent relay script', () => {
  it('uses the real broker for a roster persona outside the allowlist', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ reply: 'Use the small change.' })))
    const driver = createMockDriver({
      agents: () => [{ ...marlow, mentionAllowlist: [] }, sage],
      deltaDelayMs: 0,
      request,
    })
    const input: TurnInput = {
      agent: { ...marlow, mentionAllowlist: [] },
      threadId: 'dm_1',
      cwd: '/tmp/manor-test/dm_1',
      repoPaths: [],
      catchUp: [{
        id: 'message_1', ts: 1, type: 'user_message', text: 'Ask Sage which change is smallest.', mentions: [],
      }],
      isFullCatchUp: true,
      mcpServers: [interaction],
    }

    const events: RuntimeEvent[] = []
    for await (const event of driver.startTurn(input).events) events.push(event)

    expect(request).toHaveBeenCalledOnce()
    expect(request.mock.calls[0]?.[1]?.headers).toMatchObject({
      'x-manor-user-input-capability': 'turn-secret',
    })
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toMatchObject({ to: 'sage' })
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_use', tool: 'message_agent' }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'tool_result', outcome: 'success' }))
    // The sentence for the user precedes the call: an accepted call ends the DM turn.
    const ask = events.findIndex((event) => event.type === 'message' && event.text === 'Asking Sage; their reply follows.')
    expect(ask).toBeGreaterThanOrEqual(0)
    expect(ask).toBeLessThan(events.findIndex((event) => event.type === 'tool_use'))
  })

  it('does not recurse when the prompt itself arrived through an agent relay', async () => {
    const request = vi.fn<typeof fetch>()
    const driver = createMockDriver({ agents: () => [{ ...marlow, mentionAllowlist: ['sage'] }, sage], deltaDelayMs: 0, request })
    const input: TurnInput = {
      agent: { ...marlow, mentionAllowlist: ['sage'] },
      threadId: 'pair_1',
      cwd: '/tmp/manor-test/pair_1',
      repoPaths: [],
      catchUp: [{
        id: 'message_1', ts: 1, type: 'user_message', source: 'agent_relay', text: 'Ask Sage for a view.', mentions: [],
        authorAgentId: 'smith', originChatId: 'dm_1', originTurnId: 'turn_1', relayId: 'relay_1', relayDepth: 1,
      }],
      isFullCatchUp: true,
      mcpServers: [interaction],
    }

    for await (const _event of driver.startTurn(input).events) {
      // Drain the deterministic script.
    }

    expect(request).not.toHaveBeenCalled()
  })

  it('raises the lease card for the named connector and reports a denial', async () => {
    const desktopCard = vi.fn<(capability: string, connector: string) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('codex-computer.js was denied before it ran.'))
    const driver = createMockDriver({ agents: () => [marlow], deltaDelayMs: 0, desktopCard })
    const turn = async (text: string) => {
      const events: RuntimeEvent[] = []
      for await (const event of driver.startTurn({
        agent: marlow, threadId: 'dm_1', cwd: '/tmp/manor-test/dm_1', repoPaths: [], isFullCatchUp: true,
        catchUp: [{ id: 'message_1', ts: 1, type: 'user_message', text, mentions: [] }],
        mcpServers: [interaction],
      }).events) events.push(event)
      return events.find((event) => event.type === 'result')
    }

    expect(await turn('mock lease card computer')).toMatchObject({ text: expect.stringMatching(/^Allowed: computer /) })
    expect(await turn('mock lease card codex-computer')).toMatchObject({ text: expect.stringContaining('was denied') })
    expect(desktopCard.mock.calls).toEqual([['turn-secret', 'computer'], ['turn-secret', 'codex-computer']])
  })
})
