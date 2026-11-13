import { describe, expect, it, vi } from 'vitest'
import { EffectBroker } from '../src/effectBroker.js'
import { EffectCapabilities } from '../src/effectCapability.js'
import { EFFECT_REVIEW_INPUT_LIMIT } from '../src/effectReviewInput.js'
import { ExecutorSession } from '../src/mcp/executorSession.js'

const input = { code: 'return await tools.codex_computer_use.org.localComputerUse.get_app_state({app:"Finder"});' }
const interaction = {
  kind: 'form', message: 'Allow Computer Use to use "Finder"?',
  address: 'tools.codex_computer_use.org.localComputerUse.get_app_state', args: { app: 'Finder' },
  requestedSchema: { type: 'object', properties: {} },
  meta: { connector_id: 'computer-use', connector_name: 'Computer Use' },
}
const paused = (overrides = {}) => ({ structuredContent: {
  status: 'waiting_for_interaction', executionId: 'exec_1', interaction: { ...interaction, ...overrides },
} })
const completed = { structuredContent: { status: 'completed', result: { text: 'Finder window' } } }

function capabilities() {
  const caps = new EffectCapabilities()
  for (const token of ['owner', 'other']) caps.issue({
    chatId: token, agentId: 'smith', turnId: token, canApprove: true,
  }, {
    id: 'executor', name: 'executor', command: '', args: [], envKeys: [], description: '',
    writes: true, effectPolicy: 'confirm_writes', tools: ['execute', 'resume'], readOnlyTools: [], schemaChars: 0,
  }, token)
  return caps
}

describe('Executor turn context', () => {
  it('runs repeated Full access scripts and app-access continuations without approval, but honors revocation', async () => {
    const ask = vi.fn()
    const broker = new EffectBroker({ request: ask }, undefined, true)
    const caps = capabilities()
    const call = vi.fn(async (tool) => tool === 'execute' ? paused() : completed)
    const session = new ExecutorSession(
      (tool, arguments_, reviewArguments, continuation) =>
        caps.authorize('owner', { tool, arguments: arguments_, reviewArguments, continuation }, broker),
      call,
    )
    for (let n = 0; n < 4; n += 1) expect(await session.run('execute', input)).toEqual(completed)
    expect(ask).not.toHaveBeenCalled()
    caps.closeTurn('owner')
    await expect(session.run('execute', input)).rejects.toThrow()
    expect(call).toHaveBeenCalledTimes(8)
  })

  it('can run more than three app-access prompts without spending human approvals, while writes still ask', async () => {
    const ask = vi.fn().mockResolvedValue({ allow_effect: 'Deny' })
    const reviewer = vi.fn(async (request) => !JSON.stringify(request.reviewArguments).includes('delete_file'))
    const broker = new EffectBroker({ request: ask }, reviewer)
    const caps = capabilities()
    const authorize = vi.fn(async (tool, _input, reviewArguments, continuation) =>
      caps.authorize('owner', { tool, reviewArguments, continuation }, broker))
    const call = vi.fn(async (tool) => tool === 'execute' ? paused() : completed)
    const session = new ExecutorSession(authorize, call)
    for (let n = 0; n < 4; n += 1) expect(await session.run('execute', input)).toEqual(completed)
    expect(call).toHaveBeenCalledTimes(8)
    expect(ask).not.toHaveBeenCalled()
    expect(reviewer).toHaveBeenCalledTimes(4)
    expect(authorize.mock.calls[1]).toEqual(['resume', {
      executionId: 'exec_1', action: 'accept', content: '{}',
    }, { input: { executionId: 'exec_1', action: 'accept', content: '{}' }, origin: input, interaction },
    { permit: expect.any(String), executionId: 'exec_1', interaction }])
    await expect(session.run('execute', { code: 'delete_file()' })).rejects.toThrow('denied')
    expect(ask).toHaveBeenCalledOnce()
    expect(call).toHaveBeenCalledTimes(8)
  })

  it('resumes an approved script when preceding screen output nearly fills the review limit', async () => {
    const ask = vi.fn()
    const reviewer = vi.fn().mockResolvedValue(true)
    const broker = new EffectBroker({ request: ask }, reviewer)
    const caps = capabilities()
    const authorize = vi.fn(async (tool, _input, reviewArguments, continuation) =>
      caps.authorize('owner', { tool, reviewArguments, continuation }, broker))
    const screen = { structuredContent: { status: 'completed', result: { text: '' } } }
    const overhead = JSON.stringify({ input, previous: {
      input, result: screen.structuredContent, capturedAt: Date.now(),
    } }).length
    screen.structuredContent.result.text = 'x'.repeat(EFFECT_REVIEW_INPUT_LIMIT - overhead - 1)
    const call = vi.fn().mockResolvedValueOnce(screen).mockResolvedValueOnce(paused()).mockResolvedValue(completed)
    const session = new ExecutorSession(authorize, call)
    await session.run('execute', input)
    expect(await session.run('execute', input)).toEqual(completed)
    const reviewed = reviewer.mock.calls[1]?.[0].reviewArguments
    expect(JSON.stringify(reviewed).length).toBe(EFFECT_REVIEW_INPUT_LIMIT - 1)
    expect(reviewed).toHaveProperty('previous.result', screen.structuredContent)
    expect(authorize.mock.calls[2]?.[2]).not.toHaveProperty('previous')
    expect(authorize.mock.calls[2]?.[3]).toHaveProperty('permit', expect.any(String))
    expect(call).toHaveBeenLastCalledWith('resume', { executionId: 'exec_1', action: 'accept', content: '{}' })
    expect(reviewer).toHaveBeenCalledTimes(2)
    expect(ask).not.toHaveBeenCalled()
  })

  it('checks the broker again before a continuation, so denial or revocation leaves it paused', async () => {
    const authorize = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Turn revoked'))
    const call = vi.fn().mockResolvedValue(paused())
    const result = await new ExecutorSession(authorize, call).run('execute', input)
    expect(result).toMatchObject({ isError: true, structuredContent: { executionId: 'exec_1' } })
    expect(JSON.stringify(result.content)).toContain('Turn revoked')
    expect(call).toHaveBeenCalledOnce()
  })

  it.each([
    { meta: { ...interaction.meta, persist: 'always' } },
    { meta: { connector_id: 'browser-use' } },
    { requestedSchema: { type: 'object', properties: { scope: { type: 'string' } } } },
    { message: 'Approve sending this message?' },
    { address: 'tools.google_mail.org.default.send' },
  ])('leaves other consent forms to the caller: %j', async (overrides) => {
    const call = vi.fn().mockResolvedValue(paused(overrides))
    const authorize = vi.fn().mockResolvedValue(undefined)
    expect(await new ExecutorSession(authorize, call).run('execute', input)).toEqual(paused(overrides))
    expect(call).toHaveBeenCalledOnce()
    expect(authorize).toHaveBeenCalledOnce()
  })

  it('keeps a manual resume bound to its original script and actual answer', async () => {
    const authorize = vi.fn().mockResolvedValue(undefined)
    const call = vi.fn().mockResolvedValueOnce(paused({ message: 'Choose scope' })).mockResolvedValue(completed)
    const session = new ExecutorSession(authorize, call)
    await session.run('execute', input)
    const answer = { executionId: 'exec_1', action: 'accept', content: '{"scope":"always"}' }
    await session.run('resume', answer)
    expect(authorize.mock.calls[1]?.[2]).toMatchObject({
      input: answer, origin: input, interaction: { message: 'Choose scope' },
    })
    await new ExecutorSession(authorize, call).run('resume', answer)
    expect(authorize.mock.calls[2]?.[2]).not.toHaveProperty('origin')
  })

  it('passes the preceding output to review without treating it as a current screen', async () => {
    const authorize = vi.fn().mockResolvedValue(undefined)
    const call = vi.fn().mockResolvedValue(completed)
    const session = new ExecutorSession(authorize, call)
    await session.run('execute', input)
    await session.run('execute', { code: 'next()' })
    expect(authorize.mock.calls[1]?.[2]).toMatchObject({
      input: { code: 'next()' }, previous: { input, result: completed.structuredContent, capturedAt: expect.any(Number) },
    })
  })

  it.each([{ password: 'sensitive' }, { text: 'x'.repeat(16_001) }])('does not retain unsafe output for review', async (result) => {
    const authorize = vi.fn().mockResolvedValue(undefined)
    const call = vi.fn().mockResolvedValue({ structuredContent: result })
    const session = new ExecutorSession(authorize, call)
    await session.run('execute', input)
    await session.run('execute', input)
    expect(authorize.mock.calls[1]?.[2]).not.toHaveProperty('previous')
  })

  it('bounds automatic resumes when the gateway repeats the same consent', async () => {
    const authorize = vi.fn().mockResolvedValue(undefined)
    const call = vi.fn().mockResolvedValue(paused())
    expect(await new ExecutorSession(authorize, call).run('execute', input)).toEqual(paused())
    expect(call).toHaveBeenCalledTimes(4)
    expect(authorize).toHaveBeenCalledTimes(4)
  })

  it('does not resume an error response even if it contains an app-access form', async () => {
    const call = vi.fn().mockResolvedValue({ ...paused(), isError: true })
    const authorize = vi.fn().mockResolvedValue(undefined)
    expect(await new ExecutorSession(authorize, call).run('execute', input)).toHaveProperty('isError', true)
    expect(call).toHaveBeenCalledOnce()
  })

  it.each(['other-turn', 'forged', 'origin', 'scope', 'answer', 'execution', 'exhausted', 'closed'])('refuses a %s continuation before reaching the broker', async (kind) => {
    const caps = capabilities()
    const broker = { authorize: vi.fn().mockResolvedValue(undefined) }
    const permit = await caps.authorize('owner', { tool: 'execute', reviewArguments: { input } }, broker)
    const resume = {
      tool: 'resume',
      reviewArguments: { input: { executionId: 'exec_1', action: 'accept', content: '{}' }, origin: input, interaction },
      continuation: { permit, executionId: 'exec_1', interaction },
    }
    await caps.authorize('owner', resume, broker)
    expect(broker.authorize.mock.calls[1]?.[0]).toHaveProperty('continuedExecution', true)
    if (kind === 'forged') resume.continuation.permit = 'invented'
    if (kind === 'origin') resume.reviewArguments.origin = { code: 'delete_file()' }
    if (kind === 'scope') {
      const persistent = { ...interaction, meta: { ...interaction.meta, persist: 'always' } }
      resume.continuation.interaction = persistent
      resume.reviewArguments.interaction = resume.continuation.interaction
    }
    if (kind === 'answer') resume.reviewArguments.input.content = '{"scope":"always"}'
    if (kind === 'execution') {
      resume.continuation.executionId = 'exec_other'
      resume.reviewArguments.input.executionId = 'exec_other'
    }
    if (kind === 'exhausted') {
      await caps.authorize('owner', resume, broker)
      await caps.authorize('owner', resume, broker)
    }
    if (kind === 'closed') caps.closeTurn('owner')
    broker.authorize.mockClear()
    await expect(caps.authorize(kind === 'other-turn' ? 'other' : 'owner', resume, broker)).rejects.toThrow()
    expect(broker.authorize).not.toHaveBeenCalled()
  })

  it('cannot obtain a permit for a script the broker refused', async () => {
    const caps = capabilities()
    await expect(caps.authorize('owner', { tool: 'execute', reviewArguments: { input } }, {
      authorize: async () => { throw new Error('Denied') },
    })).rejects.toThrow('Denied')
  })
})
