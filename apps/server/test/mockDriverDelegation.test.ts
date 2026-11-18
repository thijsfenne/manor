import type { AttachedMcpServer, RuntimeEvent, TurnInput } from '@manor/contracts'
import { describe, expect, it, vi } from 'vitest'
import { createMockDriver } from '../src/drivers/mockDriver.js'
import { marlow } from './helpers.js'

const interaction: AttachedMcpServer = {
  server: {
    id: 'builtin_manor',
    name: 'manor',
    command: '',
    args: ['--subagent-url', 'http://127.0.0.1:8787/internal/subagent'],
    envKeys: [],
    description: '',
    writes: false,
    effectPolicy: 'trusted',
    tools: ['delegate_task'],
    readOnlyTools: [],
    schemaChars: 0,
  },
  disabledTools: [],
  runtimeEnv: { MANOR_USER_INPUT_CAPABILITY: 'turn-secret' },
}

/** The body the mock sends to the delegate broker for one user line. */
async function brokerBody(text: string) {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ report: { status: 'done', result: 'ok' } })))
  const driver = createMockDriver({ agents: () => [marlow], deltaDelayMs: 0, request })
  const input: TurnInput = {
    agent: marlow,
    threadId: 'dm_1',
    cwd: '/tmp/manor-test/dm_1',
    repoPaths: [],
    catchUp: [{ id: 'message_1', ts: 1, type: 'user_message', text, mentions: [] }],
    isFullCatchUp: true,
    mcpServers: [interaction],
  }
  const events: RuntimeEvent[] = []
  for await (const event of driver.startTurn(input).events) events.push(event)
  return JSON.parse(String(request.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
}

describe('mock driver delegation form', () => {
  it('passes a quoted role to the broker and keeps the task after the colon', async () => {
    const body = await brokerBody('subagent gpt-6.1-sol high role "You are a skeptical reviewer.": read the notes')
    expect(body).toMatchObject({ action: 'delegate_task', model: 'gpt-6.1-sol', effort: 'high', task: 'read the notes', role: 'You are a skeptical reviewer.' })
  })

  it('leaves the role out of the legacy forms', async () => {
    const body = await brokerBody('review subagent gpt-6.1-sol low: check the diff')
    expect(body).toMatchObject({ task: 'check the diff', review: true })
    expect(body).not.toHaveProperty('role')
  })
})
