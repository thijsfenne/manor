import { describe, expect, it } from 'vitest'
import { SINGLE_CHAT_VOICE } from '@manor/contracts'
import type { ClientMessage, ThreadEvent } from '@manor/contracts'
import { createChatMessage, createWorkspaceCommands } from './commands'
import { singleChatOverride } from './runtimeChoices'
import { emptyWorkspace, type WorkspaceState } from './workspaceState'

describe('browser session creation', () => {
  it('is always Single and carries only the single voice pin', () => {
    expect(createChatMessage(
      { kind: 'browser' },
      undefined,
      { sage: { model: 'claude-opus-5' }, [SINGLE_CHAT_VOICE.id]: { model: 'gpt-6-astra' } },
    )).toEqual({
      type: 'create_chat',
      kind: 'browser',
      mode: 'single',
      overrides: { [SINGLE_CHAT_VOICE.id]: { model: 'gpt-6-astra' } },
    })
    expect(createChatMessage({ kind: 'browser' })).toEqual({ type: 'create_chat', kind: 'browser', mode: 'single' })
  })
})

describe('project chat creation on both clients', () => {
  it('sends only the runtime pins owned by the selected mode', () => {
    const overrides = {
      sage: { model: 'claude-opus-5' },
      [SINGLE_CHAT_VOICE.id]: {
        driver: 'codex' as const,
        model: 'gpt-6-astra',
        effort: 'high' as const,
      },
    }

    expect(createChatMessage(
      { kind: 'project', projectId: 'manor', mode: 'house' },
      undefined,
      overrides,
      undefined,
      'house-request',
    )).toEqual({
      type: 'create_chat',
      requestId: 'house-request',
      projectId: 'manor',
      mode: 'house',
      overrides: { sage: { model: 'claude-opus-5' } },
    })

    expect(createChatMessage(
      { kind: 'project', projectId: 'manor', mode: 'single' },
      undefined,
      overrides,
      undefined,
      'single-request',
    )).toEqual({
      type: 'create_chat',
      requestId: 'single-request',
      projectId: 'manor',
      mode: 'single',
      overrides: {
        [SINGLE_CHAT_VOICE.id]: {
          driver: 'codex',
          model: 'gpt-6-astra',
          effort: 'high',
        },
      },
    })
  })
})

describe('shared request commands', () => {
  it('builds one wire shape and marks the preview pending only when the send left', () => {
    const sent: ClientMessage[] = []
    let connected = false
    let state: WorkspaceState = emptyWorkspace
    const commands = createWorkspaceCommands(
      (message) => { sent.push(message); return connected },
      (change) => { state = change(state) },
    )

    expect(commands.readRepoFile('manor', 'README.md')).toBe(false)
    expect(state).toBe(emptyWorkspace)

    connected = true
    expect(commands.readRepoFile('manor', 'README.md', 'chat-1')).toBe(true)
    expect(sent).toEqual([
      { type: 'read_repo_file', projectId: 'manor', path: 'README.md' },
      { type: 'read_repo_file', projectId: 'manor', path: 'README.md', chatId: 'chat-1' },
    ])
    expect(state.repoFilePreviews['manor::chat-1']).toEqual({ path: 'README.md', result: null })
  })

  const recorder = () => {
    const sent: ClientMessage[] = []
    let state: WorkspaceState = emptyWorkspace
    const commands = createWorkspaceCommands((message) => { sent.push(message); return true }, (change) => { state = change(state) })
    return { sent, commands, state: () => state }
  }

  it('asks for the whole child thread once, and only for what follows while the socket holds it', () => {
    const { sent, commands, state } = recorder()
    const thread = { events: [{ id: 'e1' }, { id: 'e2' }] as ThreadEvent[] }

    commands.openSubagentThread('child', 'parent', undefined, false)
    commands.openSubagentThread('child', 'parent', thread, true)
    commands.openSubagentThread('child', 'parent', thread, false)

    expect(sent).toEqual([
      { type: 'open_chat', chatId: 'child' },
      { type: 'open_chat', chatId: 'child', after: 'e2', count: 2 },
      { type: 'open_chat', chatId: 'child' },
    ])
    expect(state().childThreads).toEqual({ child: 'parent' })
    expect(state().panelThreads.has('child')).toBe(true)
  })

  it('builds the stop, answer and draft requests the same for both clients', () => {
    const { sent, commands } = recorder()

    commands.stopTurn('t1')
    commands.stopBackground('c1')
    commands.stopSubagent('c1', 'call-1')
    commands.answerUserInput('c1', 'r1', { dir: 'Left' })
    commands.answerSecretRequest('c1', 'r2')
    commands.answerSecretRequest('c1', 'r2', 'value')
    commands.changeSessionAnswer('thread', 'r3', { dir: ['Left', 'Right'] })
    commands.submitOutboundDraft('c1', 'd1', 'Body')
    commands.submitOutboundDraft('c1', 'd1', 'Body', 'Subject', undefined, 'cc@example.com')
    commands.discardOutboundDraft('c1', 'd1')
    commands.snoozeOutboundDraft('c1', 'd1', 5)
    commands.ignoreOutboundDraft('c1', 'd1')
    commands.restoreOutboundDraft('c1', 'd1')
    commands.readOutboundThread('c1', 'd1', 'outbound-thread-1')

    expect(sent).toEqual([
      { type: 'stop', turnId: 't1' },
      { type: 'stop_background', chatId: 'c1' },
      { type: 'stop_subagent', chatId: 'c1', toolCallId: 'call-1' },
      { type: 'answer_user_input', chatId: 'c1', requestId: 'r1', answers: { dir: 'Left' } },
      { type: 'answer_secret_request', chatId: 'c1', requestId: 'r2' },
      { type: 'answer_secret_request', chatId: 'c1', requestId: 'r2', value: 'value' },
      { type: 'change_session_answer', chatId: 'thread', requestId: 'r3', answers: { dir: ['Left', 'Right'] } },
      { type: 'submit_outbound_draft', chatId: 'c1', draftId: 'd1', body: 'Body' },
      { type: 'submit_outbound_draft', chatId: 'c1', draftId: 'd1', body: 'Body', subject: 'Subject', cc: 'cc@example.com' },
      { type: 'discard_outbound_draft', chatId: 'c1', draftId: 'd1' },
      { type: 'snooze_outbound_draft', chatId: 'c1', draftId: 'd1', until: 5 },
      { type: 'ignore_outbound_draft', chatId: 'c1', draftId: 'd1' },
      { type: 'restore_outbound_draft', chatId: 'c1', draftId: 'd1' },
      { type: 'outbound_thread_read', chatId: 'c1', draftId: 'd1', requestId: 'outbound-thread-1' },
    ])
  })
})

describe('the Browser chat runtime pin', () => {
  const fallback = { driver: 'claude' as const, model: 'claude-fable-5-2', effort: 'high' as const }
  it('reads an empty or Auto pin as the concrete default, and leaves other chats alone', () => {
    expect(singleChatOverride('browser', { auto: true }, fallback)).toEqual({ ...fallback, auto: false })
    expect(singleChatOverride('browser', {}, fallback)).toEqual({ ...fallback, auto: false })
    expect(singleChatOverride('project', { auto: true }, fallback)).toEqual({ auto: true })
  })
})
