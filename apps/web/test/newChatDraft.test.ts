import { beforeEach, describe, expect, it } from 'vitest'
import { clearDrafts, readDraft, writeDraft } from '../src/composerDrafts'
import {
  draftBlockedNote,
  draftWithMode,
  emptyNewChatDraft,
  forgetHeldProjectDraft,
  holdProjectDraft,
  refusesCreate,
  reopenDraft,
  restoreSentDraft,
  resumeProjectDraft,
  stageDraftKey,
  submittedDraftOutcome,
} from '../src/useChatDialogs'

const outcome = (over: Partial<Parameters<typeof submittedDraftOutcome>[0]> = {}) =>
  submittedDraftOutcome({
    previousChatId: 'chat_before',
    pendingChatId: null,
    openChatId: null,
    errorNotice: false,
    ...over,
  })

describe('what became of a submitted new-chat draft', () => {
  it('waits while the server has said nothing back', () => {
    expect(outcome()).toBe('waiting')
    // The chat that was already on screen is not this send's answer.
    expect(outcome({ openChatId: 'chat_before' })).toBe('waiting')
  })

  it('calls a notice with no chat behind it a refusal', () => {
    expect(outcome({ errorNotice: true })).toBe('refused')
  })

  it('lets a chat that landed beat a notice that came with it', () => {
    // "That chat was made, but its model pin was not saved" is an error notice and a
    // created chat in the same breath. Reading it as a refusal put a message that had
    // already been sent back in the composer, ready to be sent twice.
    expect(outcome({ openChatId: 'chat_new', errorNotice: true })).toBe('born')
    expect(outcome({ pendingChatId: 'chat_new', errorNotice: true })).toBe('arriving')
  })

  it('counts only a notice carrying the create\'s own request id as its refusal', () => {
    const error = (requestId?: string) => ({ kind: 'error' as const, text: 'no', ...(requestId === undefined ? {} : { requestId }) })
    expect(refusesCreate(error('create_1'), 'create_1')).toBe(true)
    // "That chat was made, but its model pin was not saved" is broadcast without one.
    expect(refusesCreate(error(), 'create_1')).toBe(false)
    expect(refusesCreate(error('create_other'), 'create_1')).toBe(false)
    expect(refusesCreate(error(), undefined)).toBe(false)
  })

  it('follows a chat still arriving before one that has landed', () => {
    expect(outcome({ pendingChatId: 'chat_new', openChatId: 'chat_before' })).toBe('arriving')
  })
})

describe('new-chat mode switches', () => {
  it('enters Single on Auto without seeding a runtime pin', () => {
    const draft = emptyNewChatDraft({ kind: 'project', projectId: 'project_1', mode: 'house' })

    expect(draftWithMode(draft, 'single')?.overrides.__single__).toBeUndefined()
  })

  it('keeps the runtime choices of both modes in the draft', () => {
    const draft = {
      ...emptyNewChatDraft({ kind: 'project', projectId: 'project_1', mode: 'single' as const }),
      overrides: {
        __single__: { driver: 'cursor' as const, model: 'grok-4.6', effort: 'medium' as const },
        smith: { model: 'claude-opus-4-1' },
      },
    }

    const house = draftWithMode(draft, 'house')
    const single = draftWithMode(house, 'single')

    expect(single?.target).toEqual({ kind: 'project', projectId: 'project_1', mode: 'single' })
    expect(single?.overrides).toEqual(draft.overrides)
  })
})

describe('the new-chat stage setup', () => {
  const runtime = { driver: 'claude' as const, model: 'claude-opus-5-5', effort: 'high' as const }
  const projects = [{ id: 'project_1' }, { id: 'project_2' }]
  beforeEach(forgetHeldProjectDraft)

  it('opens a project stage as Single with Auto off', () => {
    const draft = emptyNewChatDraft({ kind: 'project', projectId: 'project_1' }, runtime)

    expect(draft.target).toEqual({ kind: 'project', projectId: 'project_1', mode: 'single' })
    expect(draft.overrides.__single__).toEqual(runtime)
  })

  it('reopens the held setup instead of the default room after leaving the stage', () => {
    const picked = {
      ...emptyNewChatDraft({ kind: 'project', projectId: 'project_2' }, runtime),
      target: { kind: 'project' as const, projectId: 'project_2', mode: 'house' as const },
      overrides: { smith: { auto: false, model: 'gpt-6' } },
      checkout: { mode: 'worktree' as const, branch: 'feature' },
    }
    holdProjectDraft(picked)

    expect(resumeProjectDraft({ kind: 'project', projectId: 'project_1' }, projects, runtime)).toBe(picked)
  })

  it('keeps the pre-send setup while a create is unanswered', () => {
    // Leaving mid-send must not cost the picks; only the server's answer spends them.
    const setup = emptyNewChatDraft({ kind: 'project', projectId: 'project_2' }, runtime)
    holdProjectDraft(setup)
    holdProjectDraft({ ...setup, submitting: true })

    expect(resumeProjectDraft({ kind: 'project', projectId: 'project_1' }, projects, runtime)).toBe(setup)
  })

  const sent = { text: 'hello', images: [], files: [], documents: [], pageContexts: [] }

  it('reopens an unanswered create still sending, measured from the chat on screen now', () => {
    const inFlight = {
      ...emptyNewChatDraft({ kind: 'project', projectId: 'project_2' }, runtime),
      submitting: true,
      previousChatId: 'chat_before_send',
      sent,
    }

    const reopened = reopenDraft({ kind: 'project', projectId: 'project_1' }, inFlight, 'chat_left_for', projects, runtime)

    // Still sending, so the way back cannot send it twice; the chat left for is not its arrival.
    expect(reopened).toMatchObject({ submitting: true, sent, previousChatId: 'chat_left_for' })
  })

  it('does not put a DM create in flight on the project stage', () => {
    const setup = emptyNewChatDraft({ kind: 'project', projectId: 'project_2' }, runtime)
    holdProjectDraft(setup)
    const dmInFlight = { ...emptyNewChatDraft({ kind: 'dm', agentId: 'smith' }), submitting: true, sent }

    expect(reopenDraft({ kind: 'project', projectId: 'project_1' }, dmInFlight, null, projects, runtime)).toBe(setup)
    expect(reopenDraft({ kind: 'dm', agentId: 'iris' }, dmInFlight, null, projects, runtime).submitting).toBe(false)
  })

  it('puts refused text back only in the stage it was sent from, ahead of what was written there since', () => {
    clearDrafts()
    const project = { kind: 'project' as const, projectId: 'project_1' }
    const dm = { kind: 'dm' as const, agentId: 'smith' }
    const image = { name: 'a.png', dataUrl: 'data:image/png;base64,AA' }
    writeDraft(stageDraftKey(dm), { text: 'typed in the DM since', images: [], files: [] })

    restoreSentDraft(project, sent)
    expect(readDraft(stageDraftKey(project)).text).toBe('hello')
    expect(readDraft(stageDraftKey(dm)).text).toBe('typed in the DM since')

    // Text written into the box from elsewhere meanwhile stays, after the refused text.
    writeDraft(stageDraftKey(project), { text: 'discuss this', images: [], files: [] })
    restoreSentDraft(project, { ...sent, images: [image] })
    expect(readDraft(stageDraftKey(project))).toMatchObject({ text: 'hello\n\ndiscuss this', images: [image] })

    restoreSentDraft(dm, sent)
    expect(readDraft(stageDraftKey(dm)).text).toBe('hello\n\ntyped in the DM since')
  })

  it('starts fresh once its room is gone', () => {
    holdProjectDraft(emptyNewChatDraft({ kind: 'project', projectId: 'project_gone' }, runtime))
    expect(resumeProjectDraft({ kind: 'project', projectId: 'project_1' }, projects, runtime).target)
      .toMatchObject({ projectId: 'project_1', mode: 'single' })
  })
})

describe('what blocks the new-chat stage from sending', () => {
  const base = { live: true, starting: false, mode: 'house' as const, seatedAgents: 2 }

  it('blocks a Multiple Session with no Session agent, and says why', () => {
    expect(draftBlockedNote({ ...base, seatedAgents: 0 })).toBe('Add a session agent to start a Multiple session')
  })

  it('lets Single, a seated Multiple and a DM send', () => {
    expect(draftBlockedNote({ ...base, mode: 'single', seatedAgents: 0 })).toBe('')
    expect(draftBlockedNote(base)).toBe('')
    expect(draftBlockedNote({ ...base, mode: undefined, seatedAgents: 1 })).toBe('')
  })

  it('keeps the connection and starting reasons first', () => {
    expect(draftBlockedNote({ ...base, seatedAgents: 0, live: false })).toBe('Disconnected, sending is paused')
    expect(draftBlockedNote({ ...base, seatedAgents: 0, starting: true })).toBe('Starting the chat…')
  })
})
