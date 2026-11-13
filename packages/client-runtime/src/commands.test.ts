import { describe, expect, it } from 'vitest'
import { SINGLE_CHAT_VOICE } from '@manor/contracts'
import type { ClientMessage } from '@manor/contracts'
import { createChatMessage, createWorkspaceCommands } from './commands'
import { emptyWorkspace, type WorkspaceState } from './workspaceState'

describe('browser session creation', () => {
  it('carries the fixed mode and only the single voice pin', () => {
    expect(createChatMessage(
      { kind: 'browser', mode: 'single' },
      undefined,
      { sage: { model: 'claude-opus-5' }, [SINGLE_CHAT_VOICE.id]: { model: 'gpt-6-astra' } },
    )).toEqual({
      type: 'create_chat',
      kind: 'browser',
      mode: 'single',
      overrides: { [SINGLE_CHAT_VOICE.id]: { model: 'gpt-6-astra' } },
    })
    expect(createChatMessage({ kind: 'browser', mode: 'house' })).toEqual({ type: 'create_chat', kind: 'browser', mode: 'house' })
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
})
