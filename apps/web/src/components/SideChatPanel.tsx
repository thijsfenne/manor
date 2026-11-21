import { NO_CHAT_COMMANDS } from '@manor/client-runtime/chat-commands'
import { useEffect, useMemo, useState, type ComponentPropsWithoutRef, type CSSProperties } from 'react'
import { Cancel01Icon, Delete02Icon } from '@hugeicons/core-free-icons'
import { SIDE_CHAT_DEFAULTS, type AgentConfig, type Effort, type ImageAttachment, type InlineQuote, type UserInputAnswers } from '@manor/contracts'
import { useLiveThread } from '../liveThread'
import { rowsOf, type TurnRow } from '../state'
import { AskDock } from './AskCard'
import type { DictationSettings } from '../dictation/useDictation'
import { Composer } from './Composer'
import { ConfirmStrip } from './Confirm'
import { SideRuntimeMenu } from './SideRuntimeMenu'
import { Transcript } from './Transcript'
import { Button } from './ui/Button'
import { DOCK_PANEL_SHELL, dockPanelLayoutClass } from './ui/dockPanel'
import { IconButton } from './ui/IconButton'

/** See `dockPanelLayoutClass`; never expanded, so the 760 overlay is always on. */
export const sideChatPanelLayoutClass = (overlay = false) =>
  dockPanelLayoutClass('w-[calc(var(--side-width)-8px)]', false, overlay)

interface SideChatPanelProps {
  /**
   * The roster, for the personas a quoted line from the chat next door may mention.
   * Nothing in this panel offers one to pick. The model voice stays anonymous in its
   * transcript; only its turn status is shown above an answer.
   */
  agents: AgentConfig[]
  /** The house's dictation settings, for the composer's microphone; null before they load. */
  dictation?: DictationSettings | null
  /**
   * What this panel runs on, already resolved by the server. Undefined only while the
   * thread is still being opened, where the defaults stand in and the menu is dead:
   * there is nothing yet to write a pick to.
   */
  runtime: { model: string; effort: Effort } | undefined
  onRuntimeChange: (model: string, effort: Effort) => void
  /**
   * The chat this panel hangs off. It identifies the draft rather than the panel's own
   * thread id does, because that id arrives a round trip later: keyed on it, a question
   * typed while the panel was still opening would be parked under one key and read back
   * under another, which is the draft disappearing as the answer becomes possible.
   */
  parentChatId: string
  /** The panel's own thread, or null while the server is still naming it. */
  chatId: string | null
  /** False while the socket is down, which is the one reason typing cannot go out. */
  connected: boolean
  onSend: (text: string, attachments: { images: ImageAttachment[] }, quotes?: InlineQuote[]) => boolean
  /** Selected text staged from the parent transcript. */
  onStop: (turnId: string) => void
  /** Answers an ask-user card in this panel's own thread. */
  onAnswer?: (requestId: string, answers: UserInputAnswers) => boolean
  /** Deletes this panel's history and starts it over, after a confirm. */
  onClear: () => void
  /** Asks for the thread again, for the one request that can be refused and not retried. */
  onRetry: () => void
  /** Track width, gutter included, same number the region reserved for this panel. */
  width: number
  overlay?: boolean
  revealed?: boolean
  resizing: boolean
  resizeProps: ComponentPropsWithoutRef<'div'>
  onClose: () => void
}

/**
 * How long the panel waits for the server to name its thread before saying it did
 * not arrive. The round trip is one query, so this is far past slow and only reached
 * when the answer was a refusal: the notice explaining it lands in the sidebar, and
 * without this the panel would go on promising to open for the rest of the session.
 */
const OPENING_PATIENCE_MS = 10_000

/**
 * Whether a question can go out, and why not when it cannot. Its own function so the
 * states can be read at a glance and checked without a DOM.
 *
 * `ready` is the thread named *and* loaded, not just named. A question sent against a
 * thread whose snapshot is still travelling gets an optimistic bubble that the arriving
 * snapshot then wipes, because a snapshot is the whole truth for a chat and drops
 * everything pending — the message is on its way, and the panel spends the wait looking
 * like it swallowed it. The stage makes the same rule for a chat that is still opening.
 */
export function sideSendState(
  connected: boolean,
  ready: boolean,
  gaveUp: boolean,
): { canSend: boolean; note: string } {
  if (!connected) return { canSend: false, note: 'Disconnected, sending is paused' }
  if (ready) return { canSend: true, note: '' }
  return { canSend: false, note: gaveUp ? 'The panel did not open' : 'Opening the panel…' }
}

/**
 * The aside beside a chat: one voice, reading the conversation on the stage and
 * answering questions about it here. It never writes into that conversation, which is
 * why it is a panel and not a second thread in the sidebar.
 *
 * Deliberately thin. One control, the model and reasoning this panel runs on, and it
 * sits in the composer where every other chat's runtime does. No roster (a panel is a
 * model, not a member of the household), no mentions, no `$` skills and nothing to
 * attach: this voice holds no tools, so every control that would promise an action is
 * absent rather than present and dead.
 */
const noChatCommands = () => NO_CHAT_COMMANDS

export function SideChatPanel({
  agents,
  dictation = null,
  runtime,
  onRuntimeChange,
  parentChatId,
  chatId,
  connected,
  onSend,
  onStop,
  onAnswer,
  onRetry,
  onClear,
  width,
  overlay = false,
  revealed = true,
  resizing,
  resizeProps,
  onClose,
}: SideChatPanelProps) {
  // Its own live thread: the panel draws the streamed reply.
  const thread = useLiveThread(chatId)
  const rows = useMemo(() => rowsOf(thread), [thread])
  const running = useMemo(
    () => rows.filter((row): row is TurnRow => row.kind === 'turn' && row.live?.state === 'running'),
    [rows],
  )
  // Opening the panel is two round trips: the thread is created on the server the first
  // time it is asked for, and its transcript follows. Ready is both, and stops being
  // both while a reconnect re-reads a transcript that is already on screen.
  const ready = chatId !== null && thread.hasSnapshot && !thread.refreshing
  const [attempt, setAttempt] = useState(0)
  const [gaveUp, setGaveUp] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)

  // `attempt` is in the deps for the retry's sake: nothing else about the panel changes
  // when the button is pressed, so without it the failure would stand for good and no
  // second timer would ever run. Cleared at the top of every pass, so an answer that
  // lands takes the failure with it.
  useEffect(() => {
    setGaveUp(false)
    if (ready || !connected) return
    const timer = window.setTimeout(() => setGaveUp(true), OPENING_PATIENCE_MS)
    return () => window.clearTimeout(timer)
  }, [ready, connected, attempt])

  const { canSend, note: blockedNote } = sideSendState(connected, ready, gaveUp)

  const retry = () => {
    setAttempt((current) => current + 1)
    onRetry()
  }

  return (
    <aside
      style={{ '--side-width': `${width}px` } as CSSProperties}
      data-open={overlay ? revealed : undefined}
      className={`grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] ${DOCK_PANEL_SHELL} ${sideChatPanelLayoutClass(overlay)}`}
      aria-label="Side chat"
    >
      <div
        {...resizeProps}
        className="group absolute inset-y-0 left-0 z-30 w-2 touch-none cursor-col-resize outline-none max-[760px]:hidden"
      >
        <div
          className={`pointer-events-none absolute inset-y-0 left-[3px] w-0.5 bg-primary transition-opacity duration-150 group-hover:opacity-40 group-focus-visible:opacity-60 ${
            resizing ? 'opacity-60' : 'opacity-0'
          }`}
        />
      </div>
      {/* What this is, and the way out. No face and no name: the panel is a model
          rather than someone, and what it runs on is a control, so it lives in the
          composer with every other chat's runtime instead of being stated up here. */}
      <div className="flex h-11 min-w-0 items-center justify-between border-b border-line px-3.5 pr-2">
        {confirmingClear ? (
          <ConfirmStrip
            question="Clear this side chat's history?"
            confirmLabel="Clear"
            onConfirm={() => {
              setConfirmingClear(false)
              onClear()
            }}
            onCancel={() => setConfirmingClear(false)}
          />
        ) : (
          <>
            <h2 className="m-0 text-label font-medium text-muted">Side chat</h2>
            <div className="flex items-center">
              {/* Only once there is something to clear, and never mid-open. */}
              {ready && rows.length > 0 && (
                <IconButton icon={Delete02Icon} label="Clear side chat" disabled={!connected} onClick={() => setConfirmingClear(true)} />
              )}
              <IconButton icon={Cancel01Icon} label="Hide side chat" onClick={onClose} />
            </div>
          </>
        )}
      </div>

      {gaveUp && rows.length === 0 ? (
        // The one path that can hang: the server refused to open the thread and said
        // why in the sidebar's notice. Better a dead end with a way out than a label
        // that goes on promising to open for the rest of the session.
        <div className="flex min-h-0 flex-col items-start gap-2 px-3.5 py-8">
          <span className="text-dim">
            The panel did not open. Whatever the server said about it is in the notice.
          </span>
          <Button variant="secondary" size="compact" onClick={retry}>
            Try again
          </Button>
        </div>
      ) : (
        <Transcript
          key={chatId}
          rows={rows}
          agents={agents}
          skills={[]}
          hasSnapshot={thread.hasSnapshot}
          variant="panel"
          emptyNote={
            <span className="block text-meta">It has no tools, so it cannot open a file or run anything.</span>
          }
        />
      )}

      {/* No divider above it: the composer is already a bordered card, and two
          hairlines ten pixels apart is the panel framing itself twice. */}
      <div className="flex min-w-0 flex-col items-center p-3 pt-0">
        {/* Standing over the composer here too: the panel scrolls on its own, and a
            question that scrolled away would block the turn out of sight. */}
        <AskDock rows={rows} agents={agents} connected={connected} onAnswer={onAnswer} />
        <Composer
          agents={agents}
          commandContext={noChatCommands}
          // Nothing here addresses a persona, attaches a picture or runs a skill. One
          // voice, one question, one answer.
          allowAgentMentions={false}
          allowWorkDestination={false}
          allowBrowserMentions={false}
          allowComputerMentions={false}
          allowAttachments={false}
          allowSkills={false}
          // A panel beside a chat: a shorter resting box and a smaller send mark, since
          // nothing here attaches a file or addresses a persona anyway.
          compact
          dictation={dictation}
          placeholder="Ask about this chat."
          draftKey={`side:${parentChatId}`}
          controls={
            <SideRuntimeMenu
              model={runtime?.model ?? SIDE_CHAT_DEFAULTS.model}
              effort={runtime?.effort ?? SIDE_CHAT_DEFAULTS.effort}
              disabled={!connected || runtime === undefined}
              onChange={onRuntimeChange}
            />
          }
          onSend={(text, attachments, _pageContexts, _replyTo, quotes) => onSend(text, attachments, quotes)}
          canSend={canSend}
          blockedNote={blockedNote}
          running={running.length > 0}
          onStop={() => {
            for (const row of running) onStop(row.turnId)
          }}
        />
      </div>
    </aside>
  )
}
