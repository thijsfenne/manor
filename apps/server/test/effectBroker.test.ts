import { describe, expect, it, vi } from 'vitest'
import {
  EFFECT_APPROVAL_LIMIT,
  EFFECT_CALL_LIMIT,
  EffectApprovalDeniedError,
  EffectBroker,
  EffectBudgetExceededError,
} from '../src/effectBroker.js'
import type { EffectRequest } from '../src/effectCapability.js'
import { connectorEffect } from '../src/effectPolicy.js'

const server = (name: string, tools: string[]) => ({
  id: `mcp_${name}`, name, command: '/bin/true', args: [], envKeys: [], description: '',
  writes: true, effectPolicy: 'confirm_writes' as const, readOnlyTools: [], schemaChars: 0, tools,
})

const request = (overrides: Partial<EffectRequest> = {}): EffectRequest => ({
  chatId: 'chat_1',
  agentId: 'sage',
  turnId: 'turn_1',
  canApprove: true,
  connector: { id: 'mcp_1', name: 'gmail' },
  tool: 'send_message',
  effect: 'confirm_write',
  ...overrides,
})

describe('EffectBroker', () => {
  it('allows repeated connector and browser writes in Full access without review or questions', async () => {
    const ask = vi.fn()
    const review = vi.fn()
    const snapshot = vi.fn()
    const waitForHuman = vi.fn()
    const broker = new EffectBroker({ request: ask }, review, true)
    for (let call = 0; call < EFFECT_CALL_LIMIT; call += 1) {
      await broker.authorize(request(call % 2 === 0 ? {} : {
        agentId: 'smith',
        connector: { id: 'builtin_browser', name: 'browser' },
        tool: 'browser_click',
        loadReviewArguments: snapshot,
      }), { waitForHuman })
    }
    expect(ask).not.toHaveBeenCalled()
    expect(review).not.toHaveBeenCalled()
    expect(snapshot).not.toHaveBeenCalled()
    expect(waitForHuman).not.toHaveBeenCalled()
    await expect(broker.authorize(request())).rejects.toBeInstanceOf(EffectBudgetExceededError)
  })

  it('keeps read-only consultations and unattended writes restricted in Full access', async () => {
    const ask = vi.fn()
    const broker = new EffectBroker({ request: ask }, undefined, true)
    await expect(broker.authorize(request({ readOnly: true }))).rejects.toBeInstanceOf(EffectApprovalDeniedError)
    await expect(broker.authorize(request({ readOnly: true, effect: 'trusted_write' })))
      .rejects.toBeInstanceOf(EffectApprovalDeniedError)
    await expect(broker.authorize(request({ canApprove: false }))).rejects.toBeInstanceOf(EffectApprovalDeniedError)
    expect(ask).not.toHaveBeenCalled()
  })

  it('keeps restrictions and the call budget on validated continuations', async () => {
    const ask = vi.fn()
    const broker = new EffectBroker({ request: ask })
    const continued = request({ connector: { id: 'executor', name: 'executor' }, tool: 'resume', continuedExecution: true })
    await expect(broker.authorize({ ...continued, canApprove: false })).rejects.toBeInstanceOf(EffectApprovalDeniedError)
    await expect(broker.authorize({ ...continued, readOnly: true })).rejects.toBeInstanceOf(EffectApprovalDeniedError)
    for (let n = 2; n < EFFECT_CALL_LIMIT; n += 1) await broker.authorize(continued)
    await expect(broker.authorize(continued)).rejects.toBeInstanceOf(EffectBudgetExceededError)
    expect(ask).not.toHaveBeenCalled()
  })

  it('does not let an earlier continuation permit override a subsequent denial', async () => {
    const ask = vi.fn().mockResolvedValue({ allow_effect: 'Deny' })
    const broker = new EffectBroker({ request: ask })
    await expect(broker.authorize(request())).rejects.toBeInstanceOf(EffectApprovalDeniedError)
    await expect(broker.authorize(request({ continuedExecution: true }))).rejects.toBeInstanceOf(EffectApprovalDeniedError)
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('records one durable question before allowing exactly one call', async () => {
    const ask = vi.fn().mockResolvedValue({ allow_effect: 'Allow once' })
    const broker = new EffectBroker({ request: ask })
    await expect(broker.authorize(request())).resolves.toBeUndefined()
    expect(ask).toHaveBeenCalledOnce()
    expect(ask.mock.calls[0]?.[1]).toMatchObject([{
      id: 'allow_effect',
      question: 'gmail.send_message may change external state. Allow this call?',
      options: [{ label: 'Allow once', description: 'Run this call once, then ask again for the next write.' }, { label: 'Deny' }],
    }])
  })

  it('describes script approval on Executor execute cards and asks again for new scripts and other forms', async () => {
    const ask = vi.fn().mockResolvedValue({ allow_effect: 'Allow once' })
    const broker = new EffectBroker({ request: ask })
    const execute = request({ connector: { id: 'executor', name: 'executor' }, tool: 'execute' })
    await broker.authorize(execute)
    await broker.authorize({ ...execute, tool: 'resume', continuedExecution: true })
    expect(ask).toHaveBeenCalledOnce()
    expect(ask.mock.calls[0]?.[1]?.[0]?.options[0]).toEqual({
      label: 'Allow once',
      description: 'Approve this script, including up to three Computer Use app-access prompts with empty forms. New scripts and other forms ask again.',
    })
    await broker.authorize(execute)
    await broker.authorize({ ...execute, tool: 'resume' })
    expect(ask).toHaveBeenCalledTimes(3)
    expect(ask.mock.calls[2]?.[1]?.[0]?.options[0].description)
      .toBe('Run this call once, then ask again for the next write.')
  })

  // The card offers no free line here, because a typed answer is not an approval:
  // `approved` only reads the exact allow label, so a third row could only deny.
  it('marks the approval question as one its own options answer', async () => {
    const ask = vi.fn().mockResolvedValue({ allow_effect: 'Allow once' })
    await new EffectBroker({ request: ask }).authorize(request())
    expect(ask.mock.calls[0]?.[1]?.[0]?.optionsOnly).toBe(true)
  })

  it('does not let free-form or model-shaped answers impersonate approval', async () => {
    const broker = new EffectBroker({ request: vi.fn().mockResolvedValue({ allow_effect: 'yes' }) })
    await expect(broker.authorize(request())).rejects.toBeInstanceOf(EffectApprovalDeniedError)
  })

  it('blocks unattended writes immediately and never creates an unanswerable ask', async () => {
    const ask = vi.fn()
    const broker = new EffectBroker({ request: ask })
    await expect(broker.authorize(request({ canApprove: false }))).rejects.toBeInstanceOf(EffectApprovalDeniedError)
    expect(ask).not.toHaveBeenCalled()
  })

  it('does not ask for reads or trusted connector writes', async () => {
    const ask = vi.fn()
    const broker = new EffectBroker({ request: ask })
    await broker.authorize(request({ effect: 'read' }))
    await broker.authorize(request({ effect: 'trusted_write' }))
    expect(ask).not.toHaveBeenCalled()
  })

  it('blocks both write classes for relay receivers but leaves reads, relays and routine trusted writes alone', async () => {
    const ask = vi.fn()
    const broker = new EffectBroker({ request: ask })

    await expect(broker.authorize(request({ effect: 'trusted_write', readOnly: true })))
      .rejects.toBeInstanceOf(EffectApprovalDeniedError)
    await expect(broker.authorize(request({ effect: 'confirm_write', readOnly: true })))
      .rejects.toBeInstanceOf(EffectApprovalDeniedError)
    await expect(broker.authorize(request({ effect: 'read', readOnly: true }))).resolves.toBeUndefined()
    await expect(broker.authorize(request({ effect: 'agent_message', readOnly: true }))).resolves.toBeUndefined()
    await expect(broker.authorize(request({ effect: 'trusted_write', canApprove: false }))).resolves.toBeUndefined()
    expect(ask).not.toHaveBeenCalled()
  })

  it('treats agent messages as brokered calls without prompting for approval', async () => {
    const ask = vi.fn()
    const broker = new EffectBroker({ request: ask })
    for (let call = 0; call < EFFECT_CALL_LIMIT; call += 1) {
      await broker.authorize(request({
        connector: { id: 'builtin_manor', name: 'manor' },
        tool: 'message_agent',
        effect: 'agent_message',
      }))
    }

    expect(ask).not.toHaveBeenCalled()
    await expect(broker.authorize(request({ effect: 'agent_message' })))
      .rejects.toBeInstanceOf(EffectBudgetExceededError)
  })

  it('shares one call budget across connectors and the browser', async () => {
    const broker = new EffectBroker({ request: vi.fn() })
    for (let call = 0; call < EFFECT_CALL_LIMIT - 1; call += 1) {
      await broker.authorize(request({
        connector: { id: `linear_${call}`, name: 'linear' },
        effect: 'trusted_write',
      }))
    }
    await broker.authorize(request({
      connector: { id: 'builtin_browser', name: 'browser' },
      tool: 'browser_snapshot',
      effect: 'read',
    }))
    await expect(broker.authorize(request({ effect: 'trusted_write' })))
      .rejects.toBeInstanceOf(EffectBudgetExceededError)
  })

  it('caps repeated approval prompts after denials', async () => {
    const ask = vi.fn().mockResolvedValue({ allow_effect: 'Deny' })
    const broker = new EffectBroker({ request: ask })
    for (let attempt = 0; attempt < EFFECT_APPROVAL_LIMIT; attempt += 1) {
      await expect(broker.authorize(request())).rejects.toBeInstanceOf(EffectApprovalDeniedError)
    }
    await expect(broker.authorize(request())).rejects.toBeInstanceOf(EffectBudgetExceededError)
    expect(ask).toHaveBeenCalledTimes(EFFECT_APPROVAL_LIMIT)
  })

  it('counts every logical action in a trusted Composio batch', async () => {
    const broker = new EffectBroker({ request: vi.fn() })
    await broker.authorize(request({
      connector: { id: 'mcp_composio', name: 'composio' },
      tool: 'COMPOSIO_MULTI_EXECUTE_TOOL',
      effect: 'trusted_write',
      actions: Array.from({ length: EFFECT_CALL_LIMIT }, (_, index) => `LINEAR_ACTION_${index}`),
      actionCount: EFFECT_CALL_LIMIT,
    }))
    await expect(broker.authorize(request({ effect: 'trusted_write' })))
      .rejects.toBeInstanceOf(EffectBudgetExceededError)
  })

  it('rejects a claimed action count that does not match the sanitised batch', async () => {
    const broker = new EffectBroker({ request: vi.fn() })
    await expect(broker.authorize(request({
      actions: ['LINEAR_CREATE_ISSUE'],
      actionCount: 51,
    }))).rejects.toBeInstanceOf(EffectBudgetExceededError)
  })

  it('drops turn usage at the terminal boundary', async () => {
    const broker = new EffectBroker({ request: vi.fn() })
    for (let call = 0; call < EFFECT_CALL_LIMIT; call += 1) {
      await broker.authorize(request({ effect: 'trusted_write' }))
    }
    broker.closeTurn('turn_1')
    await expect(broker.authorize(request({ effect: 'trusted_write' }))).resolves.toBeUndefined()
  })
  it('auto-approves routine calls across personas without spending the human prompt budget', async () => {
    const ask = vi.fn().mockResolvedValue({ allow_effect: 'Allow once' })
    const review = vi.fn().mockResolvedValue(true)
    const broker = new EffectBroker({ request: ask }, review)
    for (let call = 0; call < EFFECT_CALL_LIMIT; call += 1) {
      await broker.authorize(request({ agentId: call % 2 === 0 ? 'sage' : 'smith' }))
    }
    expect(ask).not.toHaveBeenCalled()
    expect(review).toHaveBeenCalledTimes(EFFECT_CALL_LIMIT)
    await expect(broker.authorize(request())).rejects.toBeInstanceOf(EffectBudgetExceededError)
    await broker.authorize(request({ turnId: 'turn_2' }))
  })

  it.each([false, new Error('unavailable')])('falls back to the human on uncertainty or failure: %s', async (verdict) => {
    const ask = vi.fn().mockResolvedValue({ allow_effect: 'Deny' })
    const review = vi.fn(() => verdict instanceof Error ? Promise.reject(verdict) : Promise.resolve(verdict))
    const broker = new EffectBroker({ request: ask }, review)
    await expect(broker.authorize(request({ reviewArguments: { body: 'private' } })))
      .rejects.toBeInstanceOf(EffectApprovalDeniedError)
    expect(ask).toHaveBeenCalledOnce()
    expect(JSON.stringify(ask.mock.calls)).not.toContain('private')
  })

  it('keeps consultation and unattended boundaries ahead of Auto', async () => {
    const review = vi.fn().mockResolvedValue(true)
    const broker = new EffectBroker({ request: vi.fn() }, review)
    await expect(broker.authorize(request({ readOnly: true }))).rejects.toBeInstanceOf(EffectApprovalDeniedError)
    await expect(broker.authorize(request({ canApprove: false }))).rejects.toBeInstanceOf(EffectApprovalDeniedError)
    await broker.authorize(request({ effect: 'read' }))
    expect(review).not.toHaveBeenCalled()
  })

  it('rejects a late automatic approval after its turn closes', async () => {
    let approve: (value: boolean) => void = () => {}
    const review = vi.fn((_request, _signal: AbortSignal) => new Promise<boolean>((resolve) => { approve = resolve }))
    const ask = vi.fn()
    const broker = new EffectBroker({ request: ask }, review)
    const pending = broker.authorize(request())
    broker.closeTurn('turn_1')
    expect(review.mock.calls[0]?.[1].aborted).toBe(true)
    approve(true)
    await expect(pending).rejects.toBeInstanceOf(EffectApprovalDeniedError)
    expect(ask).not.toHaveBeenCalled()
  })

  it('does not give a denied retry a second chance at automatic approval', async () => {
    const ask = vi.fn().mockResolvedValue({ allow_effect: 'Deny' })
    const review = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true)
    const broker = new EffectBroker({ request: ask }, review)
    await expect(broker.authorize(request())).rejects.toBeInstanceOf(EffectApprovalDeniedError)
    await expect(broker.authorize(request())).rejects.toBeInstanceOf(EffectApprovalDeniedError)
    expect(review).toHaveBeenCalledOnce()
  })

  it('creates an iCloud calendar event without a card in an attended Full access turn, and blocks it unattended', async () => {
    const ask = vi.fn()
    const review = vi.fn()
    const broker = new EffectBroker({ request: ask }, review, true)
    const calendar = server('icloud-calendar', ['list_events', 'create_event'])
    const event = { title: 'Etentje', calendar: 'Thuis', start: '2026-10-03T19:00', durationMinutes: 120 }
    const create = (overrides: Partial<EffectRequest> = {}) => request({
      connector: { id: calendar.id, name: calendar.name },
      tool: 'create_event',
      effect: connectorEffect(calendar, 'create_event', event),
      reviewArguments: event,
      ...overrides,
    })
    await broker.authorize(create())
    expect(ask).not.toHaveBeenCalled()
    expect(review).not.toHaveBeenCalled()
    await expect(broker.authorize(create({ turnId: 'routine', canApprove: false })))
      .rejects.toThrow(/unattended turn has no approval surface/)
    // A row edited to trusted does not lift the unattended block.
    const trusted = { ...calendar, effectPolicy: 'trusted' as const }
    await expect(broker.authorize(create({ turnId: 'routine', canApprove: false, effect: connectorEffect(trusted, 'create_event', event) })))
      .rejects.toBeInstanceOf(EffectApprovalDeniedError)
    expect(ask).not.toHaveBeenCalled()
  })

  it('lets Auto approve an iCloud calendar create, and shows the event when it falls back to the card', async () => {
    const ask = vi.fn().mockResolvedValue({ allow_effect: 'Allow once' })
    const review = vi.fn().mockResolvedValueOnce(true).mockResolvedValue(false)
    const broker = new EffectBroker({ request: ask }, review)
    const create = request({
      connector: { id: 'mcp_cal', name: 'icloud-calendar' },
      tool: 'create_event',
      reviewArguments: { title: 'Etentje', calendar: 'Thuis', start: '2026-10-03T19:00', durationMinutes: 120 },
    })
    await broker.authorize(create)
    expect(ask).not.toHaveBeenCalled()
    await broker.authorize(create)
    expect(review).toHaveBeenCalledTimes(2)
    expect(ask).toHaveBeenCalledOnce()
    expect(ask.mock.calls[0]?.[1][0].question)
      .toBe('Add “Etentje” to the iCloud calendar “Thuis” on Sat 3 Oct 2026, 19:00–21:00?')
    expect(ask.mock.calls[0]?.[1][0].options[0].label).toBe('Allow once')
  })

  it('still asks for the human-only writes in Full access with Auto', async () => {
    const ask = vi.fn().mockResolvedValue({ allow_effect: 'Allow once' })
    const review = vi.fn().mockResolvedValue(true)
    const broker = new EffectBroker({ request: ask }, review, true)
    const target = { id: '0A1B2C3D-0000-0000-0000-000000000000', title: 'Melk', list: 'To do' }
    await broker.authorize(request({ connector: { id: 'mcp_rem', name: 'apple-reminders' }, tool: 'complete_reminder', reviewArguments: target }))
    await broker.authorize(request({ connector: { id: 'mcp_rem', name: 'apple-reminders' }, tool: 'delete_reminder', reviewArguments: target }))
    ask.mockResolvedValueOnce({ allow_effect: 'Fill' })
    await broker.authorize(request({
      connector: { id: 'builtin_browser', name: 'browser' },
      tool: 'browser_fill_login',
      reviewArguments: { origin: 'https://github.com', username: 'me' },
    }))
    expect(review).not.toHaveBeenCalled()
    expect(ask.mock.calls.map((call) => call[1][0].question)).toEqual([
      'Mark the reminder “Melk” in the Reminders list “To do” as done?',
      expect.stringContaining('Melk'),
      'Sign in to github.com as me?',
    ])
  })

  it('creates a reminder without a card, while complete still asks with its card', async () => {
    const ask = vi.fn().mockResolvedValue({ allow_effect: 'Allow once' })
    const review = vi.fn().mockResolvedValue(true)
    const broker = new EffectBroker({ request: ask }, review)
    const reminders = {
      id: 'mcp_rem', name: 'apple-reminders', command: '/bin/true', args: [], envKeys: [], description: '',
      writes: true, effectPolicy: 'confirm_writes' as const, readOnlyTools: [], schemaChars: 0,
      tools: ['list_reminders', 'create_reminder', 'complete_reminder', 'delete_reminder'],
    }
    const call = (tool: string, reviewArguments: unknown, overrides: Partial<EffectRequest> = {}) => request({
      connector: { id: reminders.id, name: reminders.name },
      tool,
      effect: connectorEffect(reminders, tool, reviewArguments),
      reviewArguments,
      ...overrides,
    })
    for (const list of ['To do', 'Groceries', 'Open loops']) {
      await broker.authorize(call('create_reminder', { title: 'Melk', list }))
    }
    await broker.authorize(call('create_reminder', { title: 'Melk', list: 'Open loops' }, { turnId: 'routine', canApprove: false }))
    expect(ask).not.toHaveBeenCalled()
    expect(review).not.toHaveBeenCalled()

    const target = { id: '0A1B2C3D-0000-0000-0000-000000000000', title: 'Melk', list: 'To do' }
    await broker.authorize(call('complete_reminder', target))
    expect(review).not.toHaveBeenCalled()
    expect(ask.mock.calls[0]?.[1][0].question).toBe('Mark the reminder “Melk” in the Reminders list “To do” as done?')
    await expect(broker.authorize(call('delete_reminder', target, { turnId: 'routine', canApprove: false })))
      .rejects.toBeInstanceOf(EffectApprovalDeniedError)
  })

  it('blocks a calendar create whose arguments cannot be shown, without asking', async () => {
    const ask = vi.fn()
    const broker = new EffectBroker({ request: ask })
    await expect(broker.authorize(request({
      connector: { id: 'mcp_cal', name: 'icloud-calendar' },
      tool: 'create_event',
    }))).rejects.toBeInstanceOf(EffectApprovalDeniedError)
    await expect(broker.authorize(request({
      turnId: 'turn_2',
      connector: { id: 'mcp_cal', name: 'icloud-calendar' },
      tool: 'create_event',
      reviewArguments: { title: 'x', calendar: 'Thuis', start: '2026-10-03T19:00+02:00', durationMinutes: 30 },
    }))).rejects.toThrow(/wall-clock/)
    expect(ask).not.toHaveBeenCalled()
  })
})
