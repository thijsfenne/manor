import { CHAT_COMMAND_BUSY, GOALS_RUN_IN_SESSIONS, SINGLE_CHAT_VOICE, commandGoalTurn, type ChatCommandContext, type ThreadEvent } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { chatCommandRows, commandDraft, draftCommandRefusal } from './chatCommands'
import { ROLLOVER_COMPACT_DONE } from './compacting'
import { latestSessionContext } from './contextMeter'
import { projectWorkHandoffs, type Row } from './transcriptState'
import { sendingUserMessage } from './workspaceActions'
import type { WorkspaceState } from './workspaceState'

const session: ChatCommandContext = { room: 'session', hasConversation: true, busy: false, goal: undefined }

describe('the command menu', () => {
  it('filters on the typed word and names why a row cannot run', () => {
    expect(chatCommandRows(session, '').map((row) => row.command)).toEqual(['/compact', '/clear', '/goal'])
    expect(chatCommandRows(session, 'co').map((row) => row.command)).toEqual(['/compact'])
    expect(chatCommandRows({ ...session, room: 'chat' }, '').find((row) => row.command === '/goal')?.refusal).toBe(GOALS_RUN_IN_SESSIONS)
    expect(chatCommandRows({ ...session, busy: true }, 'clear')[0]?.refusal).toBe(CHAT_COMMAND_BUSY)
  })

  it('offers showing and removing a goal this Session set', () => {
    const goal = { objective: 'Ship', own: true, reached: false }
    expect(chatCommandRows({ ...session, goal }, 'goal').map((row) => row.command)).toEqual(['/goal', '/goal clear'])
    expect(chatCommandRows({ ...session, goal }, 'goal')[0]).toMatchObject({ description: 'Show this Session’s goal', runs: true })
  })

  it('leaves a path and any other text alone', () => {
    expect(commandDraft('/usr/bin')).toBeNull()
    expect(commandDraft('hello')).toBeNull()
    expect(draftCommandRefusal({ text: '/usr/bin' }, { ...session, busy: true })).toBeUndefined()
  })

  it('refuses a draft command with the same reason as its row', () => {
    expect(draftCommandRefusal({ text: '/compact' }, { ...session, busy: true })).toBe(CHAT_COMMAND_BUSY)
  })
})

describe('a goal set in its own Session', () => {
  const note = { id: 'note', ts: 1, type: 'system_note', kind: 'info', text: 'Goal set.', workHandoffId: 'handoff', workHandoffPhase: 'created' }
  const rows = [{ kind: 'event', event: note }] as unknown as Row[]
  const handoff = { id: 'handoff', sourceChatId: 'chat', workChatId: 'chat', state: 'active' }
  const project = (fields: object) => projectWorkHandoffs(rows, [{ ...handoff, ...fields }] as never, [], [], [])

  it('stays a plain line, also after it was removed', () => {
    expect(project({ sourceTurnId: commandGoalTurn('1') })).toEqual(rows)
    expect(project({ sourceTurnId: commandGoalTurn('1'), state: 'deleted', workChatId: null })).toEqual(rows)
  })

  it('leaves a proposed brief its card', () => {
    expect(project({ sourceTurnId: 'turn_1', supportingAgentIds: [], supportingAgentNames: [] })[0]).toMatchObject({ kind: 'work_handoff' })
  })
})

describe('the context ring', () => {
  it('empties after a rollover compact', () => {
    const events = [
      { id: 'result', ts: 1, type: 'turn_result', agentId: SINGLE_CHAT_VOICE.id, turnId: 't', contextTokens: 100_000 },
      { id: 'note', ts: 2, type: 'system_note', kind: 'info', text: ROLLOVER_COMPACT_DONE },
    ] as unknown as ThreadEvent[]
    expect(latestSessionContext(events).used).toBeUndefined()
  })
})

describe('sending', () => {
  it('draws no bubble for a command', () => {
    const state = { threads: { chat: {} } } as unknown as WorkspaceState
    expect(sendingUserMessage(state, 'chat', '/compact')).toBe(state)
  })
})
