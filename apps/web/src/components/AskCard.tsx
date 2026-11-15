import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { ArrowDown01Icon, ArrowRight01Icon, Cancel01Icon } from '@hugeicons/core-free-icons'
import {
  SECRET_CLOSED_TEXT,
  SUBAGENT_VOICE,
  USER_INPUT_ANSWER_MAX,
  isSkippedAnswer,
  userInputAnswerText,
  type AgentConfig,
  type UserInputAnswers,
  type UserInputQuestion,
} from '@manor/contracts'
import { accentStyle } from '../accent'
import {
  EMPTY_DRAFT,
  askKeyAction,
  hasOther,
  isMulti,
  isPicked,
  mayLeave,
  otherIndexOf,
  payloadOf,
  pick,
  rowCount,
  stepReady,
  tooLong,
  unpick,
  write,
  type AskDraft,
} from '../askFlow'
import { EASE_OUT, INSTANT } from '../motion'
import { openAsk, personaOf, type ChangeableAnswer, type Row, type SubagentQuestion, type ThreadQuestion } from '../state'
import { Button } from './ui/Button'
import { CheckboxBox } from './ui/Checkbox'
import { Fold } from './ui/Fold'
import { formHintClass } from './ui/FormField'
import { IconButton } from './ui/IconButton'
import { SIDE_SURFACE } from './ui/dockPanel'
import { SecretCard } from './SecretCard'

/** Same geometry as `formInputClass`, 14px on this card only. */
const askInputClass =
  'w-full rounded-lg border border-line bg-stage px-2.5 py-[7px] text-[14px] text-text outline-none placeholder:text-dim focus:border-dim'

/**
 * Long enough that the row you picked is on screen as picked before the card moves
 * on, short enough that answering three questions still feels like three clicks.
 */
const ADVANCE_MS = 160

interface AskCardProps {
  questions: readonly UserInputQuestion[]
  /** The persona whose turn is blocked on this. The step chip wears her colour. */
  accent: string
  /**
   * Whether the socket is up. False locks the card rather than letting every click
   * end in "Could not send": the composer already refuses to send while the
   * connection is down, and this is the same act on the same connection.
   */
  connected?: boolean
  /**
   * How many further questions are already waiting behind this card. They queue
   * rather than taking it over, so the card has to say they are coming: otherwise
   * answering the last step hands you another card out of nowhere.
   */
  more?: number
  /** Sends the answers. False means the socket refused them and the card stays put. */
  onSubmit: (answers: UserInputAnswers) => boolean
  /** In a project thread: the thread's pick for this question and why, under the question on every step. */
  advice?: { by: string; text: string }
  /**
   * Set when nothing waits on this card, such as replacing an answer already given: the
   * cross closes it without sending, and Skip reads Keep, leaving that question as it was.
   */
  onCancel?: () => void
}

/**
 * The question an agent is blocked on, one step at a time. Picking an option answers
 * and moves on in a single click; the free line and the last step are the only places
 * Next is a separate act. Skip passes one question, the cross passes the rest: both
 * send, because a card that merely disappeared would leave the turn hanging forever.
 */
export function AskCard({ questions, accent, connected = true, more = 0, onSubmit, advice, onCancel }: AskCardProps) {
  const [step, setStep] = useState(0)
  const [draft, setDraft] = useState<AskDraft>(EMPTY_DRAFT)
  const [skipped, setSkipped] = useState<string[]>([])
  const [collapsed, setCollapsed] = useState(false)
  const [failed, setFailed] = useState(false)
  const [sent, setSent] = useState(false)
  const [back, setBack] = useState(false)
  const otherRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [bodyHeight, setBodyHeight] = useState<number | null>(null)
  const advanceRef = useRef<number | null>(null)
  const reduce = useReducedMotion() ?? false

  const total = questions.length
  const question = questions[Math.min(step, total - 1)]
  const last = step >= total - 1
  // Several rows allowed, so no click can mean "and on to the next one".
  const multi = question !== undefined && isMulti(question)
  // Every way out of it puts an answer on the wire, except the cross on a card that can
  // close without one, which stays usable after a send so a refused one can still go.
  const locked = sent || !connected
  const ready = question !== undefined && !locked && stepReady(question, draft)

  const clearAdvance = () => {
    if (advanceRef.current === null) return
    window.clearTimeout(advanceRef.current)
    advanceRef.current = null
  }
  useEffect(() => clearAdvance, [])

  // What the box below has to grow or shrink to. Measured rather than declared,
  // because a question with two options and one with four are different heights and
  // the card swaps between them in place; without this the step change was a jump.
  useEffect(() => {
    const body = bodyRef.current
    if (body === null) return
    const measure = () => setBodyHeight(body.offsetHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    return () => observer.disconnect()
  }, [])

  // What a scheduled advance reads when it fires, rather than what it captured when
  // it was scheduled. A connection that drops inside those 160ms would otherwise be
  // invisible to a timer that was made while the socket was still up.
  const liveRef = useRef({ connected, sent })
  useEffect(() => {
    liveRef.current = { connected, sent }
    // Nothing may cross a connection that is gone, and a card that quietly stepped
    // forward while locked would be showing a different question than the one you
    // were answering.
    if (!connected) clearAdvance()
  }, [connected, sent])

  const send = (answers: UserInputAnswers) => {
    if (!mayLeave(liveRef.current)) return
    if (tooLong(answers)) {
      setFailed(true)
      return
    }
    // Latched in the ref before the call, not left to `sent` to catch up: state does
    // not settle until the next render, so two dispatches in one tick would both pass
    // a check on it. The latch comes off again if the socket refused the answer.
    liveRef.current = { ...liveRef.current, sent: true }
    if (onSubmit(answers)) {
      setSent(true)
      setFailed(false)
    } else {
      liveRef.current = { ...liveRef.current, sent: false }
      setFailed(true)
    }
  }

  /** Leaving a step: forward while questions remain, out the door on the last one. */
  const leave = (nextDraft: AskDraft, nextSkipped: string[]) => {
    if (last) send(payloadOf(questions, nextDraft, nextSkipped))
    else {
      setBack(false)
      setStep((current) => current + 1)
    }
  }

  const choose = (index: number) => {
    if (question === undefined || locked) return
    clearAdvance()
    const nextDraft = pick(draft, question, index)
    const nextSkipped = skipped.filter((id) => id !== question.id)
    setDraft(nextDraft)
    setSkipped(nextSkipped)
    // The free line is picked, not answered: it advances once there are words in it.
    // A row that was just ticked gets the caret; one that was just cleared does not.
    if (index === otherIndexOf(question)) {
      if (isPicked(question, nextDraft, index)) window.setTimeout(() => otherRef.current?.focus(), 0)
      return
    }
    // A question that takes several answers cannot advance on a click, because the
    // click that means "this one too" and the click that means "done" are the same
    // gesture. Next is that second act, and the card says so before you start. A card
    // that can close without an answer waits for Send too: nothing is blocked on it.
    if (multi || onCancel !== undefined) return
    advanceRef.current = window.setTimeout(() => {
      advanceRef.current = null
      if (!mayLeave(liveRef.current)) return
      leave(nextDraft, nextSkipped)
    }, reduce ? 0 : ADVANCE_MS)
  }

  // The pick goes with it. Stepping back to a skipped question used to find the old
  // row still lit while the payload said "Skipped", which is the card lying about
  // what it is holding.
  const onSkip = () => {
    if (question === undefined || locked) return
    clearAdvance()
    const nextSkipped = skipped.includes(question.id) ? skipped : [...skipped, question.id]
    const nextDraft = unpick(draft, question.id)
    setSkipped(nextSkipped)
    setDraft(nextDraft)
    leave(nextDraft, nextSkipped)
  }

  const onNext = () => {
    if (!ready) return
    clearAdvance()
    leave(draft, skipped)
  }

  const onBack = () => {
    if (locked) return
    clearAdvance()
    setBack(true)
    setStep((current) => Math.max(0, current - 1))
  }

  // Every question at once, answers kept, the rest skipped. The turn gets an answer
  // either way, which is the whole difference between this and closing a notification.
  const onDismiss = () => {
    if (locked && onCancel === undefined) return
    clearAdvance()
    if (onCancel !== undefined) onCancel()
    else send(payloadOf(questions, draft, skipped))
  }

  // 1 to 9 pick a row, Enter leaves the step. Never while something else has the
  // keyboard: a digit typed into the composer is a digit, not an answer.
  useEffect(() => {
    if (question === undefined || locked || collapsed) return
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      const inOurLine = target !== null && target === otherRef.current
      const action = askKeyAction(event.key, {
        inOurLine,
        typingElsewhere:
          target !== null &&
          !inOurLine &&
          (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable),
        ready,
        rows: rowCount(question),
      })
      if (action === null) return
      event.preventDefault()
      if (action.kind === 'next') onNext()
      else choose(action.index)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (question === undefined) return null

  const otherIndex = otherIndexOf(question)
  const other = hasOther(question)
  const otherOn = isPicked(question, draft, otherIndex)
  const typed = draft.typed[question.id] ?? ''

  return (
    <div
      className={`flex w-full min-w-0 flex-col rounded-2xl ${SIDE_SURFACE}`}
      style={accentStyle(accent)}
      role="group"
      aria-label={question.question}
    >
      <div className={`flex min-w-0 items-start gap-2.5 px-3.5 pt-3 ${collapsed || sent ? 'pb-3' : 'pb-4'}`}>
        {total > 1 ? (
          <span className="mt-px flex-none rounded-chip bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] px-1.5 py-0.5 text-meta font-medium tabular-nums text-[color:var(--accent-fg)]">
            {step + 1}/{total}
          </span>
        ) : null}
        <span
          className={`min-w-0 flex-1 text-[14px] leading-5 font-medium text-text ${
            collapsed ? 'truncate' : '[overflow-wrap:anywhere]'
          }`}
        >
          {question.header === undefined || question.header.length === 0 ? null : (
            <span className="mr-1.5 text-dim">{question.header}</span>
          )}
          {question.question}
        </span>
        {/* The controls are centred on the question's first line rather than on the
            top of the box: a 26px control against a 24px line sits a pixel low. */}
        {sent ? (
          <span className="-mt-px -mr-1.5 flex flex-none items-center gap-1">
            <span className="mt-px text-label text-dim">Sent</span>
            {/* A card that can close without an answer still can after a refused send. */}
            {onCancel === undefined ? null : <IconButton icon={Cancel01Icon} iconSize={14} size={26} label="Close" onClick={onDismiss} />}
          </span>
        ) : (
          <span className="ask-card-touch-controls -mt-px -mr-1.5 flex flex-none items-center">
            <IconButton
              icon={collapsed ? ArrowRight01Icon : ArrowDown01Icon}
              iconSize={14}
              size={26}
              label={collapsed ? 'Show the question' : 'Fold the question away'}
              onClick={() => setCollapsed((current) => !current)}
            />
            <IconButton
              icon={Cancel01Icon}
              iconSize={14}
              size={26}
              disabled={locked && onCancel === undefined}
              label={onCancel === undefined ? 'Skip all of it and let the agent decide' : 'Close without changing anything'}
              onClick={onDismiss}
            />
          </span>
        )}
      </div>

      {/* Folding away is 0 to auto, which is the house fold and pure CSS. Stepping
          between two questions is height A to height B, which nothing in CSS can
          interpolate: `auto` never changes, so no transition fires. That one is
          measured, and the box below animates to what the step actually needs. */}
      <Fold open={!collapsed && !sent}>
        <motion.div
          className="overflow-hidden"
          initial={false}
          animate={{ height: bodyHeight ?? 'auto' }}
          transition={reduce ? INSTANT : { duration: 0.22, ease: EASE_OUT }}
        >
          <div ref={bodyRef} className="flex min-w-0 flex-col">
            {advice === undefined ? null : (
              <p className="m-0 mb-3 px-3.5 text-[13.5px] leading-5 text-muted [overflow-wrap:anywhere]">
                <span className="mr-1.5 font-medium text-text">{advice.by} suggests</span>
                {advice.text}
              </p>
            )}
            <motion.div
              key={question.id}
              className="flex min-w-0 flex-col"
              initial={reduce ? false : { opacity: 0, x: back ? -12 : 12 }}
              animate={{ opacity: 1, x: 0 }}
              transition={reduce ? INSTANT : { duration: 0.18, ease: EASE_OUT }}
            >
              {/* Before the first click, never after it: whether a pick answers the
                  question or merely adds to it is the difference between one click and
                  two, and it belongs with the rows it governs rather than up in the
                  question, which it would then be read ahead of. */}
              {multi ? (
                <span className="mb-1.5 block px-3 text-meta text-dim">Pick more than one</span>
              ) : null}
              <div
                className="flex min-w-0 flex-col gap-1 px-2.5"
                role={multi ? 'group' : 'radiogroup'}
                aria-label={question.question}
              >
                {question.options.map((option, index) => {
                  const on = isPicked(question, draft, index)
                  return (
                    <button
                      key={option.label}
                      type="button"
                      role={multi ? 'checkbox' : 'radio'}
                      aria-checked={on}
                      disabled={locked}
                      onClick={() => choose(index)}
                      className={`flex min-h-11 w-full min-w-0 items-center gap-3 rounded-lg border-0 px-3 py-2 text-left ${
                        locked ? 'cursor-default' : 'cursor-pointer'
                      } ${on ? 'bg-user-bg text-text' : `bg-surface-2 text-muted ${locked ? '' : 'hover:bg-user-bg hover:text-text'}`}`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-[14px] leading-5 [overflow-wrap:anywhere]">{option.label}</span>
                        {option.description === undefined || option.description.length === 0 ? null : (
                          <span className={`mt-0.5 block ${formHintClass}`}>{option.description}</span>
                        )}
                      </span>
                      <KeyCap number={index + 1} />
                      {multi ? <CheckboxBox checked={on} /> : null}
                    </button>
                  )
                })}

                {/* The free line as a row of its own rather than a field under the list:
                    typing used to clear the option you had picked without saying so.
                    A permission card has none: allowing a call is a decision the
                    options already hold, and a typed answer only reads as a refusal. */}
                {!other ? null : (
                  <div className={`min-w-0 rounded-lg ${otherOn ? 'bg-user-bg' : 'bg-surface-2'}`}>
                    <button
                      type="button"
                      role={multi ? 'checkbox' : 'radio'}
                      aria-checked={otherOn}
                      disabled={locked}
                      onClick={() => choose(otherIndex)}
                      className={`flex min-h-11 w-full min-w-0 items-center gap-3 rounded-lg border-0 bg-transparent px-3 py-2 text-left text-[14px] leading-5 ${
                        locked ? 'cursor-default' : 'cursor-pointer'
                      } ${otherOn ? 'text-text' : `text-muted ${locked ? '' : 'hover:text-text'}`}`}
                    >
                      <span className="min-w-0 flex-1">Other</span>
                      <KeyCap number={otherIndex + 1} />
                      {multi ? <CheckboxBox checked={otherOn} /> : null}
                    </button>
                    {/* Opacity only. The box above owns height now, and two things
                        animating the same pixels made the outer one chase the inner one
                        frame by frame. */}
                    <AnimatePresence initial={false}>
                      {otherOn ? (
                        <motion.div
                          className="px-2 pb-2"
                          initial={reduce ? false : { opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          transition={reduce ? INSTANT : { duration: 0.16, ease: EASE_OUT }}
                        >
                          <input
                            ref={otherRef}
                            className={askInputClass}
                            placeholder="Type your own answer here"
                            aria-label={`Your own answer to ${question.question}`}
                            value={typed}
                            maxLength={USER_INPUT_ANSWER_MAX}
                            disabled={locked}
                            onChange={(event) => setDraft((current) => write(current, question.id, event.target.value))}
                            onKeyDown={(event) => {
                              if (event.key !== 'Enter' || !ready) return
                              event.preventDefault()
                              onNext()
                            }}
                          />
                        </motion.div>
                      ) : null}
                    </AnimatePresence>
                  </div>
                )}
              </div>

              <div className="ask-card-actions flex min-w-0 items-center gap-2 px-3.5 pt-3 pb-3">
                {step === 0 ? null : (
                  <Button variant="ghost" size="compact" disabled={locked} onClick={onBack}>
                    Back
                  </Button>
                )}
                {/* The connection first: while it is down every button here would fail for
                    that reason, and "Try again" would be advice that cannot work. */}
                <span className="min-w-0 flex-1 truncate">
                  {!connected ? (
                    <span className="text-label text-dim">Disconnected, answering is paused</span>
                  ) : failed ? (
                    <span className="text-label text-warn">Could not send. Try again.</span>
                  ) : more > 0 ? (
                    <span className="text-label text-dim">
                      {more === 1 ? 'One more card after this' : `${more} more cards after this`}
                    </span>
                  ) : null}
                </span>
                <Button variant="ghost" size="compact" disabled={locked} onClick={onSkip}>
                  {onCancel === undefined ? 'Skip' : 'Keep'}
                </Button>
                <Button variant="primary" size="compact" disabled={!ready} onClick={onNext}>
                  {last ? 'Send' : 'Next'}
                </Button>
              </div>
            </motion.div>
          </div>
        </motion.div>
      </Fold>
    </div>
  )
}

/** The number that answers this row from the keyboard. */
function KeyCap({ number }: { number: number }) {
  return (
    <span
      aria-hidden="true"
      className="grid h-5 w-5 flex-none place-items-center rounded-sm bg-surface text-meta tabular-nums text-dim"
    >
      {number}
    </span>
  )
}

/**
 * The card standing over the composer, for the one question this chat is blocked on.
 * Nothing to answer draws nothing, so the composer keeps its own space.
 */
export function AskDock({
  rows,
  agents,
  connected = true,
  chatId,
  onAnswer,
  onAnswerSecret,
  threadQuestion = null,
  subagentQuestion = null,
  threadAdvice,
  projectName,
  onAnswerThread,
  routedToThread,
  changeAnswer = null,
}: {
  rows: Row[]
  agents: AgentConfig[]
  /** False while the socket is down, which is what locks the card it draws. */
  connected?: boolean
  onAnswer?: (requestId: string, answers: UserInputAnswers) => boolean
  /** The chat this dock stands in; a thread's question is answered on its Session's chat instead. */
  chatId?: string
  /** A secret card's one answer: the value, or nothing to decline. */
  onAnswerSecret?: (chatId: string, requestId: string, value?: string) => boolean
  /** In a project thread: the oldest question one of its sessions waits on (2026-10-10). */
  threadQuestion?: ThreadQuestion | null
  /** The oldest question a subagent of this chat waits on; its own view takes no answers. */
  subagentQuestion?: SubagentQuestion | null
  /** The thread's advice per question, by requestId (`threadQuestionAdvice`). */
  threadAdvice?: ReadonlyMap<string, string>
  projectName?: string
  /** Answers it on the session's or the subagent's own chat, where the turn is held. */
  onAnswerThread?: (sessionChatId: string, requestId: string, answers: UserInputAnswers) => boolean
  /** In a session its project thread started: the question waits in the thread, so this says where. */
  routedToThread?: { onOpen: () => void }
  /**
   * In a project thread: an answer the thread gave from a preference that the user chose to
   * replace. It stands before any waiting question, because they just asked for it.
   */
  changeAnswer?: { noteId: string; answer: ChangeableAnswer; onSubmit: (answers: UserInputAnswers) => boolean; onCancel: () => void } | null
}) {
  const reduce = useReducedMotion() ?? false
  const own = openAsk(rows)
  // A thread-started session's question is answered in the thread; the session only says so.
  const routed = own !== null && routedToThread !== undefined
  const ask = changeAnswer !== null
    ? {
        requestId: `change:${changeAnswer.noteId}`,
        agentId: changeAnswer.answer.agentId,
        more: 0,
        questions: changeAnswer.answer.questions.map((question) => {
          const given = changeAnswer.answer.answers[question.id]
          return { ...question, header: `${changeAnswer.answer.title}, Manor chose ${given === undefined ? 'nothing' : userInputAnswerText(given)}` }
        }),
        // Kept questions, and ones given Manor's own answer again, stay as they were;
        // when that is every one, nothing changes and nothing is sent.
        onSubmit: (answers: UserInputAnswers) => {
          const changed = Object.fromEntries(Object.entries(answers).filter(([id, value]) => {
            const given = changeAnswer.answer.answers[id]
            return !isSkippedAnswer(value) && (given === undefined || userInputAnswerText(value) !== userInputAnswerText(given))
          }))
          if (Object.keys(changed).length === 0) {
            changeAnswer.onCancel()
            return true
          }
          return changeAnswer.onSubmit(changed)
        },
        onCancel: changeAnswer.onCancel,
      }
    : own !== null && !routed
      ? { ...own, onSubmit: (answers: UserInputAnswers) => onAnswer?.(own.requestId, answers) ?? false }
    : threadQuestion !== null && onAnswerThread !== undefined
      ? {
          requestId: threadQuestion.requestId,
          agentId: threadQuestion.agentId,
          more: threadQuestion.more,
          // The session's title heads every question, so the card says who is asking.
          questions: threadQuestion.questions.map((question) => ({ ...question, header: `${threadQuestion.title} asks ${projectName ?? 'the project'}` })),
          onSubmit: (answers: UserInputAnswers) => onAnswerThread(threadQuestion.sessionChatId, threadQuestion.requestId, answers),
        }
      : subagentQuestion !== null && onAnswerThread !== undefined
        ? {
            requestId: subagentQuestion.requestId,
            agentId: SUBAGENT_VOICE.id,
            more: subagentQuestion.more,
            questions: subagentQuestion.questions.map((question) => ({ ...question, header: `${subagentQuestion.title} asks` })),
            onSubmit: (answers: UserInputAnswers) => onAnswerThread(subagentQuestion.childChatId, subagentQuestion.requestId, answers),
          }
        : null
  // A secret card keeps its own header: it names the value, and the card says who asks.
  const secret = changeAnswer !== null
    ? null
    : own !== null && !routed
      ? secretAsk(own.questions[0], chatId, personaOf(agents, own.agentId).name)
      : own === null ? secretAsk(threadQuestion?.questions[0], threadQuestion?.sessionChatId, threadQuestion?.title) : null
  // The thread's advice goes only on its own question's card, never on a chat's own ask.
  const advice = ask !== null && ask.requestId === threadQuestion?.requestId ? threadAdvice?.get(ask.requestId) : undefined
  if (routed) {
    return (
      <div className="mb-2 flex w-full min-w-0 max-w-[760px] items-center gap-2.5 rounded-lg border border-line bg-surface-2 py-1 pr-1 pl-3 text-[12px] text-muted shadow-pill">
        <span className="min-w-0 flex-1 truncate">Waiting for a choice in the project thread</span>
        <Button size="compact" variant="ghost" onClick={routedToThread.onOpen} className="shrink-0">Open project thread</Button>
      </div>
    )
  }
  return (
    <AnimatePresence initial={false}>
      {ask === null || (own !== null && onAnswer === undefined) ? null : (
        <motion.div
          key={ask.requestId}
          className="mb-2 w-full min-w-0 max-w-[760px]"
          initial={reduce ? false : { opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
          transition={reduce ? INSTANT : { duration: 0.22, ease: EASE_OUT }}
        >
          {secret !== null ? (
            <SecretCard
              key={ask.requestId}
              question={secret.question}
              who={secret.who}
              accent={personaOf(agents, ask.agentId).color}
              connected={connected}
              onAnswer={(value) => onAnswerSecret?.(secret.chatId, ask.requestId, value) ?? false}
            />
          ) : <AskCard
            key={ask.requestId}
            questions={ask.questions}
            accent={personaOf(agents, ask.agentId).color}
            connected={connected}
            more={ask.more}
            onSubmit={ask.onSubmit}
            {...(advice === undefined ? {} : { advice: { by: projectName ?? 'The project', text: advice } })}
            {...('onCancel' in ask ? { onCancel: ask.onCancel } : {})}
          />}
        </motion.div>
      )}
    </AnimatePresence>
  )
}

const secretAsk = (question: UserInputQuestion | undefined, chatId: string | undefined, who: string | undefined) =>
  question?.secret === undefined || chatId === undefined || who === undefined ? null : { question, chatId, who }

/**
 * What the question leaves behind once it is over: the pairs, in the transcript,
 * where the rest of the conversation is. A question whose turn died without an answer
 * says that here rather than sitting above the composer pretending it can still be
 * answered.
 */
export function AskAnswers({
  questions,
  answers,
}: {
  questions: readonly UserInputQuestion[]
  answers?: UserInputAnswers
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-3 rounded-xl px-3.5 py-3 ${SIDE_SURFACE}`}>
      {questions.map((question) => {
        const given = answers?.[question.id]
        const skipped = given !== undefined && isSkippedAnswer(given)
        return (
          <div key={question.id} className="flex min-w-0 flex-col gap-0.5">
            {question.header === undefined || question.header.length === 0 ? null : (
              <span className="block text-meta text-dim">{question.header}</span>
            )}
            <span className="block text-[length:var(--card-size,16px)] leading-[1.5] text-dim [overflow-wrap:anywhere]">{question.question}</span>
            {given === undefined ? (
              <span className="block text-[length:var(--card-size,16px)] leading-[1.5] text-warn">
                {question.secret === undefined ? 'Never answered. The turn ended first.' : SECRET_CLOSED_TEXT}
              </span>
            ) : (
              <span
                className={`block text-[length:var(--card-size,16px)] leading-[1.5] [overflow-wrap:anywhere] ${
                  skipped ? 'text-dim' : 'text-text'
                }`}
              >
                {skipped ? 'Skipped' : userInputAnswerText(given)}
              </span>
            )}
          </div>
        )
      })}
    </div>
  )
}
