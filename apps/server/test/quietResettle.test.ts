import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acceptedWork, harness, settledNotes } from './workModuleHarness.js'

/**
 * A Session settled before a follow-up turn gets its stamp back when that turn ends
 * quietly (2026-11-28); one never settled, or one that ends with a result or a question, stays open.
 */
describe('quiet re-settle', () => {
  let now = 1_000
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now) })
  afterEach(() => { vi.useRealTimers() })
  const later = () => { now += 1_000; vi.setSystemTime(now) }

  async function reopened(options: Parameters<typeof harness>[1] = {}) {
    const outcome = vi.fn(async () => 'Written outcome.')
    const h = await harness('dm', { ...options, outcome })
    const { workChatId } = await acceptedWork(h)
    await h.module.setSettled(workChatId, true)
    later()
    await h.module.setSettled(workChatId, false)
    outcome.mockClear()
    return { h, workChatId, outcome }
  }
  // A follow-up turn that ended, with no text of its own: its result row is what counts.
  const answer = async (h: Awaited<ReturnType<typeof harness>>, chatId: string) => {
    later()
    await h.store.appendEvent(chatId, { type: 'turn_result', agentId: 'sage', turnId: 'follow_up' })
  }

  it('stamps a settled Session again once its follow-up turn ends quietly, the way Settle does, without an outcome turn', async () => {
    const { h, workChatId, outcome } = await reopened()
    await answer(h, workChatId)

    expect(await h.module.resettleWhenQuiet(workChatId)).toBe(true)
    expect(await h.store.getChat(workChatId)).toMatchObject({ settledAt: expect.any(Number) })
    expect(await h.store.workHandoffForTarget(workChatId)).toMatchObject({ state: 'settled', result: null })
    expect(outcome).not.toHaveBeenCalled()
    expect(settledNotes(await h.store.loadEvents(h.source.id)).at(-1)?.text).toBe('Session “Ship handoffs” settled.')
    // Nothing runs to stop, and halting would refuse a message that lands right after.
    expect(h.stopped).toEqual([workChatId])
    // Unsettle still works afterwards.
    await h.module.setSettled(workChatId, false)
    expect(await h.store.getChat(workChatId)).toMatchObject({ settledAt: null })
  })

  it('stamps it again when the user stops the follow-up turn', async () => {
    const { h, workChatId } = await reopened()
    later()
    await h.store.appendEvent(workChatId, { type: 'system_note', kind: 'aborted', text: 'Sage\'s turn was stopped.', agentId: 'sage', turnId: 'follow_up' })

    expect(await h.module.resettleWhenQuiet(workChatId)).toBe(true)
  })

  it('yields to the user\'s own Settle queued before it', async () => {
    const { h, workChatId } = await reopened()
    await answer(h, workChatId)
    const settle = h.module.setSettled(workChatId, true)
    // The quiet request queued behind it, whose own check fails once the message holds the chat.
    const queued = h.module as unknown as { settleWhen: (chatId: string, settled: boolean, when: () => Promise<boolean>, landed: undefined, quiet: boolean) => Promise<boolean> }
    const quiet = queued.settleWhen(workChatId, true, async () => false, undefined, true)
    await Promise.all([settle, quiet])

    expect(await h.store.getChat(workChatId)).toMatchObject({ settledAt: expect.any(Number) })
  })

  it('keeps the chat running when delivery fails after the quiet stamp is written', async () => {
    let failing = false
    const { h, workChatId } = await reopened({ beforeDelivery: async () => { if (failing) throw new Error('directory down') } })
    await answer(h, workChatId)
    failing = true
    const stops = h.stopped.length

    await expect(h.module.resettleWhenQuiet(workChatId)).rejects.toThrow('directory down')
    expect(await h.store.getChat(workChatId)).toMatchObject({ settledAt: expect.any(Number) })
    expect(h.stopped.length).toBe(stops)
  })

  it('leaves a Session that was never settled open when its turn ends quietly', async () => {
    const h = await harness()
    const { workChatId } = await acceptedWork(h)
    await answer(h, workChatId)

    expect(await h.module.resettleWhenQuiet(workChatId)).toBe(false)
    expect(await h.store.getChat(workChatId)).toMatchObject({ settledAt: null })
  })

  it('keeps an Unsettle with no answer since, and waits while the Session still runs', async () => {
    const { h, workChatId } = await reopened()
    expect(await h.module.resettleWhenQuiet(workChatId)).toBe(false)

    await answer(h, workChatId)
    h.busy.add(workChatId)
    expect(await h.module.resettleWhenQuiet(workChatId)).toBe(false)
    h.busy.delete(workChatId)
    expect(await h.module.resettleWhenQuiet(workChatId)).toBe(true)
  })

  it('does not stamp a follow-up that ends with a result card or an open question', async () => {
    const asking: Record<string, string[]> = {}
    const { h, workChatId } = await reopened({ awaitingInput: () => asking })
    await answer(h, workChatId)

    asking[workChatId] = ['request_1']
    expect(await h.module.resettleWhenQuiet(workChatId)).toBe(false)
    delete asking[workChatId]

    const handoff = (await h.store.workHandoffForTarget(workChatId))!
    await h.store.reachWorkGoal(handoff.id, {
      type: 'system_note', kind: 'info', text: 'Ready.', workGoalHandoffId: handoff.id, goalReport: { result: 'Fixed.' },
    })
    expect(await h.module.resettleWhenQuiet(workChatId)).toBe(false)
    expect(await h.store.getChat(workChatId)).toMatchObject({ settledAt: null })
  })

  it('waits for a saved message that has yet to run', async () => {
    const { h, workChatId } = await reopened()
    await answer(h, workChatId)
    await h.store.appendEvent(workChatId, { type: 'user_message', text: 'En in main?', mentions: [], dispatchState: 'pending' })

    await h.module.resettleQuietSessions()
    expect(await h.store.getChat(workChatId)).toMatchObject({ settledAt: null })
  })

  it('repairs a Session left reopened and quiet at startup', async () => {
    const { h, workChatId } = await reopened()
    await answer(h, workChatId)

    await h.module.resettleQuietSessions()
    expect(await h.store.getChat(workChatId)).toMatchObject({ settledAt: expect.any(Number) })
  })
})
