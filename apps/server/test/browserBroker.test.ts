import { describe, expect, it, vi } from 'vitest'
import { BrowserBroker, type BrowserHostSocket } from '../src/browserBroker.js'
import { EffectBroker } from '../src/effectBroker.js'
import type { UserInputAnswers } from '@manor/contracts'

const host = (): BrowserHostSocket & { sent: string[] } => ({
  sent: [],
  send(payload) {
    this.sent.push(payload)
  },
})

const sage = { id: 'sage', name: 'Sage' }
const smith = { id: 'smith', name: 'Smith' }

const requestOf = (socket: { sent: string[] }, index = 0) =>
  JSON.parse(socket.sent[index] ?? '{}') as { requestId: string; actor?: { name: string }; turnId?: string }

describe('BrowserBroker', () => {
  it('fails clearly when Electron is not connected', async () => {
    await expect(new BrowserBroker().request('chat_1', 'browser_snapshot', {}, sage)).rejects.toThrow(
      'No Manor desktop browser host is connected.',
    )
  })

  it('routes a result back only from the registered host', async () => {
    const broker = new BrowserBroker()
    const desktop = host()
    const stranger = host()
    broker.register(desktop)

    const result = broker.request('chat_1', 'browser_navigate', { url: 'https://example.com' }, sage)
    const request = requestOf(desktop)
    broker.settle(stranger, { requestId: request.requestId, ok: true, result: 'wrong' })
    broker.settle(desktop, { requestId: request.requestId, ok: true, result: { title: 'Example Domain' } })

    await expect(result).resolves.toEqual({ title: 'Example Domain' })
  })

  it('names the driver on the request, so the panel can say who has the page', async () => {
    const broker = new BrowserBroker()
    const desktop = host()
    broker.register(desktop)
    void broker.request('chat_1', 'browser_snapshot', {}, sage)
    await Promise.resolve()
    expect(requestOf(desktop).actor).toEqual(sage)
    expect(requestOf(desktop).turnId).toBeUndefined()
  })

  it('carries the calling turn apart from the actor, so stopping that turn cancels it', async () => {
    const broker = new BrowserBroker()
    const desktop = host()
    broker.register(desktop)
    void broker.request('chat_1', 'browser_snapshot', {}, { ...sage, turnId: 'turn_1' })
    await Promise.resolve()
    expect(requestOf(desktop)).toMatchObject({ actor: sage, turnId: 'turn_1' })
  })

  it('rejects in-flight work when the desktop disconnects', async () => {
    const broker = new BrowserBroker()
    const desktop = host()
    broker.register(desktop)
    const result = broker.request('chat_1', 'browser_snapshot', {}, sage)
    broker.unregister(desktop)
    await expect(result).rejects.toThrow('closed before the browser action finished')
  })

  it('times out a silent host', async () => {
    vi.useFakeTimers()
    const broker = new BrowserBroker(25)
    const desktop = host()
    broker.register(desktop)
    const result = broker.request('chat_1', 'browser_snapshot', {}, sage)
    const assertion = expect(result).rejects.toThrow('did not answer in time')
    await vi.advanceTimersByTimeAsync(25)
    await assertion
    vi.useRealTimers()
  })
})

describe('the per-chat session lock', () => {
  it('holds a second persona back until the first action settles', async () => {
    const broker = new BrowserBroker()
    const desktop = host()
    broker.register(desktop)

    const first = broker.request('chat_1', 'browser_click', { selector: 'a' }, sage)
    const second = broker.request('chat_1', 'browser_click', { selector: 'b' }, smith)
    await Promise.resolve()
    // One request on the wire, not two: the page is one surface and only one action
    // is ever pointed at it.
    expect(desktop.sent).toHaveLength(1)

    broker.settle(desktop, { requestId: requestOf(desktop).requestId, ok: true, result: { selector: 'a' } })
    await expect(first).resolves.toEqual({ selector: 'a' })
    await Promise.resolve()
    expect(desktop.sent).toHaveLength(2)

    broker.settle(desktop, { requestId: requestOf(desktop, 1).requestId, ok: true, result: { selector: 'b' } })
    await expect(second).resolves.toEqual({ selector: 'b' })
  })

  it('keeps snapshot, approval and action under one lock across personas', async () => {
    const broker = new BrowserBroker()
    const desktop = host()
    broker.register(desktop)
    let allow: () => void = () => {}
    const approved = new Promise<void>((resolve) => { allow = resolve })
    const first = broker.request('chat_1', 'browser_click', { selector: '#filter' }, sage, async (snapshot) => {
      expect(await snapshot()).toEqual({ title: 'Search' })
      await approved
    })
    const second = broker.request('chat_1', 'browser_navigate', { url: 'https://example.com' }, smith)
    expect(desktop.sent).toHaveLength(1)
    expect(JSON.parse(desktop.sent[0]!).tool).toBe('browser_snapshot')
    broker.settle(desktop, { requestId: requestOf(desktop).requestId, ok: true, result: { title: 'Search' } })
    await Promise.resolve()
    expect(desktop.sent).toHaveLength(1)
    allow()
    await vi.waitFor(() => expect(desktop.sent).toHaveLength(2))
    expect(JSON.parse(desktop.sent[1]!).tool).toBe('browser_click')
    broker.settle(desktop, { requestId: requestOf(desktop, 1).requestId, ok: true, result: 'clicked' })
    await expect(first).resolves.toBe('clicked')
    await vi.waitFor(() => expect(desktop.sent).toHaveLength(3))
    broker.settle(desktop, { requestId: requestOf(desktop, 2).requestId, ok: true, result: 'navigated' })
    await expect(second).resolves.toBe('navigated')
  })

  it('does not dispatch a refused action and releases the lock for the next persona', async () => {
    const broker = new BrowserBroker()
    const desktop = host()
    broker.register(desktop)
    await expect(broker.request('chat_1', 'browser_click', { selector: '#send' }, sage,
      async () => { throw new Error('Denied') })).rejects.toThrow('Denied')
    expect(desktop.sent).toHaveLength(0)
    const next = broker.request('chat_1', 'browser_snapshot', {}, smith)
    expect(desktop.sent).toHaveLength(1)
    broker.settle(desktop, { requestId: requestOf(desktop).requestId, ok: true, result: 'page' })
    await expect(next).resolves.toBe('page')
  })

  it('rejects a late approval after the browser session was closed', async () => {
    const broker = new BrowserBroker()
    const desktop = host()
    broker.register(desktop)
    let allow: () => void = () => {}
    const pending = broker.request('chat_1', 'browser_click', { selector: '#filter' }, sage,
      () => new Promise((resolve) => { allow = resolve }))
    broker.closeChat('chat_1')
    allow()
    await expect(pending).rejects.toThrow('browser session changed')
    expect(desktop.sent.map((line) => JSON.parse(line).type)).toEqual(['browser_session_close'])
  })

  it('lets a different chat act at the same moment', async () => {
    const broker = new BrowserBroker()
    const desktop = host()
    broker.register(desktop)

    void broker.request('chat_1', 'browser_snapshot', {}, sage)
    void broker.request('chat_2', 'browser_snapshot', {}, smith)
    await Promise.resolve()
    expect(desktop.sent).toHaveLength(2)
  })

  it('fails the waiting persona by name rather than queueing forever', async () => {
    vi.useFakeTimers()
    const broker = new BrowserBroker(60_000, 25)
    const desktop = host()
    broker.register(desktop)

    void broker.request('chat_1', 'browser_snapshot', {}, sage)
    const second = broker.request('chat_1', 'browser_snapshot', {}, smith)
    const assertion = expect(second).rejects.toThrow("Sage is using this chat's browser")
    await vi.advanceTimersByTimeAsync(25)
    await assertion
    vi.useRealTimers()
  })

  it('releases the lock when the action failed, not only when it worked', async () => {
    const broker = new BrowserBroker()
    const desktop = host()
    broker.register(desktop)

    const first = broker.request('chat_1', 'browser_click', { selector: 'a' }, sage)
    broker.settle(desktop, { requestId: requestOf(desktop).requestId, ok: false, error: 'No such element.' })
    await expect(first).rejects.toThrow('No such element.')

    void broker.request('chat_1', 'browser_snapshot', {}, smith)
    await Promise.resolve()
    expect(desktop.sent).toHaveLength(2)
  })

  it('lets go of a chat that was closed underneath it', async () => {
    const broker = new BrowserBroker()
    const desktop = host()
    broker.register(desktop)

    void broker.request('chat_1', 'browser_snapshot', {}, sage)
    const waiting = broker.request('chat_1', 'browser_snapshot', {}, smith)
    broker.closeChat('chat_1')
    await expect(waiting).rejects.toThrow('browser session were closed')
  })
})


const reviewPage = {
  url: 'https://example.com', title: 'Search', visibleText: 'Search',
  interactiveElements: [{ selector: '#search', tag: 'input', type: 'search' }],
}

function answeringHost(broker: BrowserBroker) {
  const calls: string[] = []
  const desktop: BrowserHostSocket = {
    send(payload) {
      const message = JSON.parse(payload) as { type: string; requestId: string; tool: string }
      if (message.type !== 'browser_tool_request') return
      calls.push(message.tool)
      broker.settle(desktop, { requestId: message.requestId, ok: true, result: reviewPage })
    },
  }
  broker.register(desktop)
  return calls
}

function pendingHumanAction(broker: BrowserBroker) {
  let answer: (value: UserInputAnswers) => void = () => {}
  const ask = vi.fn(() => new Promise<UserInputAnswers>((resolve) => { answer = resolve }))
  const effects = new EffectBroker({ request: ask })
  const pending = broker.request('chat_1', 'browser_click', { selector: '#search' }, sage,
    (_snapshot, waitForHuman) => effects.authorize({
      chatId: 'chat_1', agentId: sage.id, turnId: 'turn_1', canApprove: true,
      connector: { id: 'builtin_browser', name: 'browser' }, tool: 'browser_click', effect: 'confirm_write',
    }, { waitForHuman }))
  return { ask, pending, allow: () => answer({ allow_effect: 'Allow once' }), deny: () => answer({ allow_effect: 'Deny' }) }
}

describe('browser approval waits', () => {
  it('lets the next persona wait through the entire Auto review budget', async () => {
    vi.useFakeTimers()
    try {
      const broker = new BrowserBroker()
      const calls = answeringHost(broker)
      const first = broker.request('chat_1', 'browser_click', { selector: '#search' }, sage,
        () => new Promise((resolve) => setTimeout(resolve, 60_000)))
      const second = broker.request('chat_1', 'browser_snapshot', {}, smith)
      await vi.advanceTimersByTimeAsync(16_000)
      expect(calls).toEqual([])
      await vi.advanceTimersByTimeAsync(44_000)
      await expect(first).resolves.toEqual(reviewPage)
      await expect(second).resolves.toEqual(reviewPage)
      expect(calls).toEqual(['browser_click', 'browser_snapshot'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('lets another persona read while a human question is pending, then resumes safely', async () => {
    const broker = new BrowserBroker()
    const calls = answeringHost(broker)
    const action = pendingHumanAction(broker)
    await vi.waitFor(() => expect(action.ask).toHaveBeenCalledOnce())
    await expect(broker.request('chat_1', 'browser_snapshot', {}, smith)).resolves.toEqual(reviewPage)
    expect(calls).toEqual(['browser_snapshot', 'browser_snapshot'])
    action.allow()
    await expect(action.pending).resolves.toEqual(reviewPage)
    expect(calls).toEqual(['browser_snapshot', 'browser_snapshot', 'browser_snapshot', 'browser_click'])
  })

  it('rejects human approval after another persona changes input even if visible text stays identical', async () => {
    const broker = new BrowserBroker()
    const calls = answeringHost(broker)
    const action = pendingHumanAction(broker)
    await vi.waitFor(() => expect(action.ask).toHaveBeenCalledOnce())
    await broker.request('chat_1', 'browser_type', { selector: '#search', text: 'different' }, smith)
    action.allow()
    await expect(action.pending).rejects.toThrow('page changed while waiting for approval')
    expect(calls).not.toContain('browser_click')
    await expect(broker.request('chat_1', 'browser_snapshot', {}, smith)).resolves.toEqual(reviewPage)
  })

  it('does not reacquire or execute when the human denies', async () => {
    const broker = new BrowserBroker()
    const calls = answeringHost(broker)
    const action = pendingHumanAction(broker)
    await vi.waitFor(() => expect(action.ask).toHaveBeenCalledOnce())
    action.deny()
    await expect(action.pending).rejects.toThrow('denied before it ran')
    expect(calls).toEqual(['browser_snapshot'])
  })

  it('rejects approval after the released session is closed and recreated', async () => {
    const broker = new BrowserBroker()
    const calls = answeringHost(broker)
    const action = pendingHumanAction(broker)
    await vi.waitFor(() => expect(action.ask).toHaveBeenCalledOnce())
    broker.closeChat('chat_1')
    await broker.request('chat_1', 'browser_snapshot', {}, smith)
    action.allow()
    await expect(action.pending).rejects.toThrow('browser session changed')
    expect(calls).not.toContain('browser_click')
  })
})
