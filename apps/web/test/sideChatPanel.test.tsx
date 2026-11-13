import { SIDE_CHAT_DEFAULTS, type Effort, type MessageQuote } from '@manor/contracts'
import { forwardRef } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SideChatPanel, sideChatPanelLayoutClass, sideSendState } from '../src/components/SideChatPanel'
import { clearDrafts, writeDraft } from '../src/composerDrafts'
import { LiveWorkspaceProvider } from '../src/liveThread'
import { SIDE_CHAT_SPEAKER, emptyThread, emptyWorkspace, type ThreadState } from '../src/state'

vi.mock('../src/components/ComposerEditor', () => ({
  ComposerEditor: forwardRef<HTMLDivElement, { value: string; placeholder: string }>(({ value, placeholder }, ref) => <div ref={ref} aria-placeholder={placeholder}>{value}</div>),
}))

const render = (
  props: {
    chatId?: string | null
    connected?: boolean
    loaded?: boolean
    refreshing?: boolean
    runtime?: { model: string; effort: Effort }
    running?: boolean
    quote?: MessageQuote
  } = {},
) => {
  const thread: ThreadState =
    props.loaded === false
      ? emptyThread
      : {
          ...emptyThread,
          hasSnapshot: true,
          refreshing: props.refreshing ?? false,
          liveTurns: props.running
            ? [{ turnId: 'turn_1', agentId: SIDE_CHAT_SPEAKER.id, messages: [], state: 'running', startedAt: 1 }]
            : [],
        }
  // The panel reads its own live thread, as it does in the app.
  const live = { get: () => ({ ...emptyWorkspace, threads: { side_1: thread } }), subscribe: () => () => {} }
  return renderToStaticMarkup(
    <LiveWorkspaceProvider live={live}>
      <SideChatPanel
        agents={[SIDE_CHAT_SPEAKER]}
        runtime={props.runtime === undefined ? { ...SIDE_CHAT_DEFAULTS } : props.runtime}
        onRuntimeChange={() => {}}
        parentChatId="chat_1"
        chatId={props.chatId === undefined ? 'side_1' : props.chatId}
        connected={props.connected ?? true}
        onSend={() => true}
        onStop={() => {}}
        onRetry={() => {}}
        onClear={() => {}}
        width={432}
        resizing={false}
        resizeProps={{}}
        onClose={() => {}}
      />
    </LiveWorkspaceProvider>,
  )
}

afterEach(clearDrafts)

describe('the side chat panel', () => {
  it('offers the same left-edge resize the browser panel has', () => {
    const html = render()

    expect(html).toContain('cursor-col-resize')
    expect(html).toContain('min-w-0')
    expect(html).toContain('max-[760px]:hidden')
  })

  it('floats at its chosen width when its own pane needs an overlay', () => {
    // From the pane's top on the desktop, whose doors are in the top bar; under the phone's own header.
    expect(sideChatPanelLayoutClass(true)).toContain('absolute top-0 bottom-0 right-0')
    expect(sideChatPanelLayoutClass(true)).toContain('[@media(max-width:600px)]:top-[46px]')
    expect(sideChatPanelLayoutClass(true)).toContain('max-w-[calc(100%-16px)]')
    expect(sideChatPanelLayoutClass(true)).toContain('w-[calc(var(--side-width)-8px)]')
    expect(sideChatPanelLayoutClass()).not.toContain('max-[760px]:w-auto')
  })

  it('names itself once, and never the voice answering in it', () => {
    // A panel is a model rather than someone, so there is no face, no persona name and
    // no label over the replies: one voice answers here and the word would repeat down
    // the whole column.
    const html = render()

    expect(html).toContain('Side chat')
    expect(html).toContain('Ask about this chat.')
    expect(html).not.toContain('Aside')
  })

  it('shows live work without turning the model voice into a persona', () => {
    const html = render({ running: true })

    expect(html).toContain('Working for ')
    // The one stop lives in the composer, not beside the status line.
    expect(html).toContain('title="Stop"')
    expect(html).not.toContain('data-avatar="blobatar"')
    expect(html).not.toContain('text-[var(--accent-fg)]')
  })

  it('puts what it runs on in the composer, where a chat’s runtime lives', () => {
    const html = render()

    expect(html).toContain('>Sonnet 5.5<')
    expect(html).toContain('>Medium<')
    expect(html).toContain('Provider, model and reasoning for this side chat')
  })

  it('shows the default while the thread is still being named, with nothing to write to', () => {
    // The pick has to land on a chat id, and there is none yet: the label is honest
    // about what the first answer will run on, and the menu says it cannot be used.
    const html = render({ chatId: null, loaded: false, runtime: undefined })

    expect(html).toContain('>Sonnet 5.5<')
    expect(html).toContain('>Medium<')
    expect(html).toContain('disabled=""')
  })

  it('offers no way to act, only a question', () => {
    const html = render()

    // No plus: nothing to attach (an image reaches a persona as a readable path), no
    // persona to address, no skill to run.
    expect(html).not.toContain('Attach and insert')
    expect(html).not.toContain('type="file"')
    // And no per-persona pin: the panel's own model menu is the only runtime control.
    expect(html).not.toContain('provider, model and reasoning for this chat')
  })

  it('keeps a question that was typed while the panel was opening', () => {
    // The draft is keyed on the chat the panel hangs off, not on the thread the server
    // is still naming: keyed on the thread, everything typed in that first second would
    // be parked under one key and read back under another.
    writeDraft('side:chat_1', { text: 'wat bedoelt hij hier', images: [], files: [] })

    expect(render({ chatId: null, loaded: false })).toContain('wat bedoelt hij hier')
    expect(render()).toContain('wat bedoelt hij hier')
  })

  it('says what the panel is while the thread is still empty', () => {
    const html = render()

    expect(html).toContain('Ask about the conversation on the left')
    expect(html).toContain('cannot open a file or run anything')
  })

  it('waits rather than lying while the thread is being opened', () => {
    // Two different states, and the panel must not show the empty-thread invitation
    // for either: the id is one round trip away, and the transcript one more.
    expect(render({ chatId: null, loaded: false })).toContain('Loading…')
    expect(render({ chatId: null, loaded: false })).toContain('Opening the panel…')
    expect(render({ loaded: false })).toContain('Loading…')
  })

  it('says why a question cannot go out with the socket down', () => {
    expect(render({ connected: false })).toContain('Disconnected, sending is paused')
  })

  it('takes no question while a reconnect is re-reading the thread it is showing', () => {
    // The second half of the same rule: a cached snapshot is not proof the panel is
    // current. The transcript stays up, because it is still the last truth anyone had.
    const html = render({ refreshing: true })

    expect(html).toContain('Opening the panel…')
    expect(html).not.toContain('Send (Enter)')
  })
})

describe('what the panel says while it has no thread', () => {
  it('calls a round trip in flight progress, and a refused one a dead end', () => {
    // The failure this exists for: `open_side_chat` is the one request here that can
    // be refused, and its notice lands in the sidebar. Without the second state the
    // panel goes on saying "Opening" for the rest of the session.
    expect(sideSendState(true, false, false).note).toBe('Opening the panel…')
    expect(sideSendState(true, false, true).note).toBe('The panel did not open')
  })

  it('takes no question until the transcript is there, not merely the id', () => {
    // A question sent against a half-open thread gets an optimistic bubble that the
    // arriving snapshot then wipes, because a snapshot is the whole truth for a chat.
    // The stage makes the same rule for a chat that is still opening.
    expect(sideSendState(true, false, false).canSend).toBe(false)
    expect(sideSendState(true, true, false)).toEqual({ canSend: true, note: '' })
  })

  it('puts a dropped socket ahead of either, because that is the reason', () => {
    expect(sideSendState(false, false, true).note).toBe('Disconnected, sending is paused')
    expect(sideSendState(false, true, false).canSend).toBe(false)
  })
})
