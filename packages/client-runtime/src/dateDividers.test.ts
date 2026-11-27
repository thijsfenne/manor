import { describe, expect, it } from 'vitest'
import { dateDividers, joinsBubbleAbove } from './dateDividers'
import type { Row, TurnRow } from './transcriptState'

const at = (day: number, hour: number, minute: number) => new Date(2026, 10, day, hour, minute).getTime()
const now = at(17, 12, 0)

const user = (key: string, ts: number): Row => ({
  kind: 'event', key, event: { id: key, ts, type: 'user_message', text: 'Hi', mentions: [] },
})
const reply = (key: string, startedAt: number, patch: Partial<TurnRow> = {}): TurnRow => ({
  kind: 'turn', key, turnId: key, agentId: 'smith', asks: [], drafts: [], activities: [], timeline: [], segments: [],
  answer: [], tail: [{ kind: 'reply', key: `${key}:r`, text: 'Hello', images: [], quoteSources: [] }], startedAt, ...patch,
})
const relay = (key: string, ts: number, phase: 'sent' | 'received' = 'sent'): Row => ({
  kind: 'event', key, event: {
    id: key, ts, type: 'agent_relay', agentId: 'smith', peerAgentId: 'post',
    pairChatId: 'pair_post', turnId: 't', relayId: key, phase,
  },
})
const note = (key: string, ts: number): Row => ({
  kind: 'event', key, event: { id: key, ts, type: 'system_note', kind: 'info', text: 'Stopped.' },
})

describe('date dividers', () => {
  it('keeps one line, directly above the next bubble, when gaps stack between two messages', () => {
    const rows = [
      user('u1', at(16, 21, 0)),
      reply('t1', at(16, 21, 1)),
      relay('relay', at(16, 21, 29)),
      note('stopped', at(16, 23, 46)),
      reply('quiet', at(16, 23, 50), { tail: [{ kind: 'reply', key: 'cut', text: 'Half', images: [], quoteSources: [], interrupted: true }] }),
      reply('t2', at(17, 7, 40)),
    ]
    expect(dateDividers(rows, 'gaps', now)).toEqual(['Yesterday 21:00', undefined, undefined, undefined, undefined, 'Today 07:40'])
  })

  it('gives an agent-to-agent line no time and measures the pause from the message before it', () => {
    const rows = [user('u1', at(17, 10, 0)), relay('relay', at(17, 10, 30)), reply('t1', at(17, 11, 10))]
    expect(dateDividers(rows, 'gaps', now)).toEqual(['Today 10:00', undefined, 'Today 11:10'])
    const close = [user('u1', at(17, 10, 0)), relay('relay', at(17, 11, 30)), reply('t1', at(17, 10, 40))]
    expect(dateDividers(close, 'gaps', now)).toEqual(['Today 10:00', undefined, undefined])
  })

  it('puts the time above an incoming relay line that introduces the reply under it', () => {
    expect(dateDividers([user('u1', at(17, 8, 0)), relay('from', at(17, 11, 0), 'received'), reply('t1', at(17, 11, 1))], 'gaps', now))
      .toEqual(['Today 08:00', 'Today 11:01', undefined])
  })

  it('marks a day change above the first bubble of the new day, never above a line before it', () => {
    const rows = [user('u1', at(16, 23, 50)), relay('relay', at(17, 0, 5)), reply('t1', at(17, 0, 10))]
    expect(dateDividers(rows, 'gaps', now)).toEqual(['Yesterday 23:50', undefined, 'Today 00:10'])
    expect(dateDividers(rows, 'days', now)).toEqual(['Mon, 16 Nov 2026', undefined, 'Tue, 17 Nov 2026'])
  })

  it('times a running DM card and every pair chat turn, but not an empty task list', () => {
    const emptyPlan = reply('plan', at(17, 9, 0), { tail: [{ kind: 'todo', key: 'todo', todos: [] }] })
    const planning = reply('running', at(17, 11, 0), {
      tail: [], live: { turnId: 'running', agentId: 'smith', messages: [], state: 'running', startedAt: at(17, 11, 0) },
      segments: [{ kind: 'todo', key: 'todo', todos: [{ text: 'Read the notes', status: 'in_progress' }] }],
    })
    expect(dateDividers([user('u1', at(17, 8, 0)), emptyPlan, planning], 'gaps', now)).toEqual(['Today 08:00', undefined, 'Today 11:00'])
    const cut = reply('cut', at(17, 0, 5), { tail: [{ kind: 'reply', key: 'cut', text: 'Half', images: [], quoteSources: [], interrupted: true }] })
    expect(dateDividers([user('u1', at(16, 23, 50)), cut], 'days', now)).toEqual(['Mon, 16 Nov 2026', 'Tue, 17 Nov 2026'])
  })
})

describe('bubbles that join the one above', () => {
  const t = at(17, 11, 0)

  it('joins the same speaker again: the user anywhere, an agent in a DM', () => {
    expect(joinsBubbleAbove(user('u2', t), user('u1', t), undefined, false)).toBe(true)
    expect(joinsBubbleAbove(reply('t2', t), reply('t1', t), undefined, true)).toBe(true)
    expect(joinsBubbleAbove(reply('t2', t), reply('t1', t), undefined, false)).toBe(false)
  })

  it('keeps the gap for a time line, another speaker, or a reaction badge hanging into it', () => {
    expect(joinsBubbleAbove(reply('t2', t), reply('t1', t), 'Today 11:00', true)).toBe(false)
    expect(joinsBubbleAbove(reply('t1', t), user('u1', t), undefined, true)).toBe(false)
    expect(joinsBubbleAbove(user('u1', t), reply('t1', t), undefined, true)).toBe(false)
    expect(joinsBubbleAbove(reply('t2', t, { agentId: 'sage' }), reply('t1', t), undefined, true)).toBe(false)
    const reacted = reply('t1', t, { tail: [{ kind: 'reply', key: 't1:r', text: 'Hi', images: [], quoteSources: [], reaction: { emoji: '👍', at: t } }] })
    expect(joinsBubbleAbove(reply('t2', t), reacted, undefined, true)).toBe(false)
  })

  it('does not join a turn that shows nothing whole yet', () => {
    expect(joinsBubbleAbove(reply('t2', t, { tail: [] }), reply('t1', t), undefined, true)).toBe(false)
  })
})

