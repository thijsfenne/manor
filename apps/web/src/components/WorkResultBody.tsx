import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { AlertCircleIcon, CheckmarkCircle02Icon, CircleCheckIcon, Tick02Icon } from '@hugeicons/core-free-icons'
import { readWorkChanges, subscribeWorkChanges, writeWorkChanges } from '@manor/client-runtime/work-changes'
import { readWorkChangesOpen, setWorkChangesOpen, subscribeWorkProposals } from '@manor/client-runtime/work-proposals'
import type { GoalChoice } from '@manor/contracts'
import { WORK_RESULT_CONNECTION_LOST, evidenceThumbnailRatio, evidenceVisibleCount, workBlockedReason, workCardStatus, workConfirmTitle, workConfirmWait, pickWorkChoice, workChangesAsked, workChoicePicked, workResultActionLabels, workResultChoiceList, workResultFiles, workResultLines, type WorkHandoffRow, type WorkResult, type WorkStatus } from '../state'
import { TEXT_SWAP, TEXT_SWAP_ABOVE, TEXT_SWAP_BELOW, TEXT_SWAP_REST } from '../motion'
import { useRequest, type RequestEvents } from '../useRequest'
import { sendWorkChanges } from '../workChanges'
import { Icon } from './Icon'
import { MergeFixPanel } from './MergeFixPanel'
import { Button } from './ui/Button'
import { Pill } from './ui/Pill'
import { ZoomableImage } from './ui/ZoomableImage'
import { WorkChangesField } from './WorkChangesField'

/** The Request changes field's editor, so the bar's Request changes can focus it on the card. */
export const WORK_CHANGES_FIELD = '[data-work-changes] [data-composer-editor]'

/** What the briefing DM can do with a Session's result. Absent where the card is read-only. */
export interface WorkResultActions {
  requestEvents: RequestEvents
  /** False while the socket is down: actions wait, and an unanswered one is dropped. */
  connected: boolean
  accept: (handoffId: string, mergeInto: string | undefined, version: number, requestId: string) => boolean
  revise: (handoffId: string, version: number, text: string, requestId: string) => boolean
  /** Runs a blocked commit or merge again under the same Confirm. */
  retry: (handoffId: string, requestId: string) => boolean
  /** Approves the conflict fix Manor holds before merging; absent where the card cannot act on it. */
  approveFix?: (handoffId: string, tip: string, requestId: string) => boolean
  /** Asks the server for the Session's checkout, so a worktree's merge branch can be named. */
  askCheckout: (chatId: string) => void
}

export const WORK_STATUS_TONE: Record<WorkStatus['tone'], string> = {
  busy: 'text-busy', ready: 'text-text', ok: 'text-ok', warn: 'text-warn', waiting: 'text-warn', dim: 'text-dim',
}

/**
 * The dot or check in front of a state word; a landed commit gets the check, and a quiet
 * Session's Done the Settled fold's circle check (2026-11-24). Still,
 * also while busy: the word beside it already says Working, and a loop on every card
 * would be one more thing moving for a fact nobody needs repeated.
 */
export function WorkStatusMark({ status }: { status: WorkStatus }) {
  if (status.tone === 'ok' && status.text !== 'Settled') return <Icon icon={CheckmarkCircle02Icon} size={13} />
  if (status.tone === 'ready' && status.text === 'Done') return <Icon icon={CircleCheckIcon} size={13} />
  if (status.tone === 'dim') return null
  return <span aria-hidden className="size-1.5 rounded-full bg-current" />
}

/**
 * The one status in an assignment card's header. It swaps in place as the Session moves
 * on, so Working, Ready, Committing… and Committed read as one card changing, not new
 * cards, and Merge blocked takes the same place when Git does not show it landing.
 */
export function WorkCardStatusLabel({ row }: { row: WorkHandoffRow }) {
  const status = workCardStatus(row)
  return <WorkStatusLabel status={status} />
}

/** A state word with its mark, swapping in place when the word changes. */
export function WorkStatusLabel({ status }: { status: WorkStatus | null }) {
  const reduce = useReducedMotion() ?? false
  return (
    <AnimatePresence initial={false} mode="wait">
      {status === null ? null : (
        <motion.span
          key={status.text}
          className={`flex shrink-0 items-center gap-1.5 text-[12px] ${WORK_STATUS_TONE[status.tone]}`}
          initial={reduce ? { opacity: 0 } : TEXT_SWAP_BELOW}
          animate={TEXT_SWAP_REST}
          exit={reduce ? { opacity: 0 } : TEXT_SWAP_ABOVE}
          transition={TEXT_SWAP}
        >
          <WorkStatusMark status={status} />
          {status.text}
        </motion.span>
      )}
    </AnimatePresence>
  )
}

/**
 * What came of the Session (2026-11-07): at most three short lines, each behind a tick,
 * then the limitation, muted, behind its own mark. A report from before points shows the
 * sentences of its result in the same style.
 */
function ResultLines({ result, settled }: { result: WorkResult; settled: boolean }) {
  const lines = workResultLines(result)
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0">
      {lines.map((line, index) => (
        <li key={index} className={`flex min-w-0 items-start gap-2 text-[14px] leading-[1.45] ${settled ? 'text-muted' : 'text-text'}`}>
          <Icon icon={Tick02Icon} size={14} className="mt-[3px] flex-none text-muted" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{line}</span>
        </li>
      ))}
      {result.limitations === undefined ? null : (
        <li className="flex min-w-0 items-start gap-2 text-[13px] leading-[1.45] text-muted">
          <Icon icon={AlertCircleIcon} size={14} className="mt-[2px] flex-none text-dim" />
          <span title={result.limitations} className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">{result.limitations}</span>
        </li>
      )}
    </ul>
  )
}

/**
 * The decisions a report leaves to the user, under a divider: each choice's plain question
 * on up to two lines (its title on one line for an older report) and its options as small
 * grey buttons, the picked one in a blue wash. A press writes `Title: option` into Follow up,
 * which opens, so several picks go to the Session as one message. A choice without a pick
 * carries a red star. Follow up stays closed while it holds only picks of a choice's
 * `noChange` option, and Confirm waits until every choice has one (`workConfirmWait`).
 */
function YourCall({ result, picked, disabled, onPick }: {
  result: WorkResult
  picked: string
  disabled: boolean
  onPick: (choice: GoalChoice, option: string) => void
}) {
  const { choices, more } = workResultChoiceList(result)
  if (choices.length === 0) return null
  return (
    <div className="flex min-w-0 flex-col gap-2.5 border-t border-line pt-2.5">
      {choices.map((choice) => (
        <div key={choice.title} className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 items-start gap-0.5">
            {choice.question === undefined
              ? <p title={choice.title} className="m-0 truncate text-[13px] leading-[1.45] text-text">{choice.title}</p>
              : <p title={choice.question} className="m-0 line-clamp-2 text-[13px] leading-[1.45] text-text [overflow-wrap:anywhere]">{choice.question}</p>}
            {choice.options.some((option) => workChoicePicked(picked, choice.title, option)) ? null : <AnswerNeeded />}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {choice.options.map((option) => {
              const recommended = option === choice.recommended
              const on = workChoicePicked(picked, choice.title, option)
              return (
                <Pill
                  key={option}
                  size="sm"
                  label={option}
                  on={on}
                  disabled={disabled}
                  hint={`${recommended ? 'Recommended. ' : ''}${option === choice.noChange ? 'Needs no change.' : 'Adds this answer to your Follow up message.'}`}
                  onToggle={() => onPick(choice, option)}
                />
              )
            })}
          </div>
        </div>
      ))}
      {more === 0 ? null : <p className="m-0 text-[12.5px] text-dim">+{more} more in the report</p>}
    </div>
  )
}

/**
 * The red star after a choice that still has no pick: Confirm stays off until every shown
 * choice has one, and there is no room for a line beside it (2026-11-24).
 */
function AnswerNeeded() {
  return (
    <span className="flex-none text-[13px] leading-[1.45] text-danger">
      <span aria-hidden>*</span>
      <span className="sr-only">Answer needed</span>
    </span>
  )
}

// The thumbnails' height and gap (h-8, gap-1.5); the "+N" tile is a square of that height.
const EVIDENCE_HEIGHT = 32
const EVIDENCE_GAP = 6

/**
 * The screenshots the lead named, small at the foot of the card. Each opens the image
 * viewer at full size, which steps through the rest. When the row cannot hold them all,
 * the ones that do not fit fold into a "+N" tile that opens the viewer at the first of them.
 */
function EvidenceRow({ evidence }: { evidence: WorkResult['evidence'] }) {
  const rowRef = useRef<HTMLUListElement>(null)
  const [available, setAvailable] = useState<number | null>(null)
  const widths = evidence.map((item) => EVIDENCE_HEIGHT * evidenceThumbnailRatio(item))
  // The row asks for the width of all its thumbnails, so the footer wraps it onto its own
  // line exactly as before; folding them never changes what it asks for, so it cannot flip back.
  const natural = widths.reduce((sum, width) => sum + width, 0) + EVIDENCE_GAP * Math.max(0, widths.length - 1)

  const empty = evidence.length === 0
  useLayoutEffect(() => {
    const row = rowRef.current
    if (row === null) return
    const measure = () => setAvailable(row.getBoundingClientRect().width)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(row)
    return () => observer.disconnect()
  }, [empty])

  if (empty) return null
  const gallery = evidence.map((item) => ({ src: item.src, alt: item.name }))
  // Half a pixel of slack: the measured box and the summed widths round differently.
  const shown = available === null ? evidence.length : evidenceVisibleCount(widths, available + 0.5, EVIDENCE_GAP, EVIDENCE_HEIGHT)
  const more = evidence.length - shown
  const firstHidden = evidence[shown]
  return (
    <ul
      ref={rowRef}
      aria-label="Screenshots"
      className="m-0 flex min-w-0 list-none gap-1.5 overflow-hidden p-0"
      style={{ flexBasis: natural }}
    >
      {evidence.slice(0, shown).map((item, index) => (
        <li
          key={item.src}
          className="h-8 shrink-0 overflow-hidden rounded-sm border border-line bg-surface-2"
          style={{ aspectRatio: evidenceThumbnailRatio(item) }}
        >
          <ZoomableImage
            src={item.src}
            alt={item.name}
            frame="h-full w-full"
            className="h-full w-full object-cover object-top"
            gallery={{ images: gallery, index }}
          />
        </li>
      ))}
      {firstHidden === undefined ? null : (
        <li className="size-8 shrink-0 overflow-hidden rounded-sm border border-line bg-surface-2">
          <ZoomableImage
            src={firstHidden.src}
            alt={firstHidden.name}
            label={`Show ${more} more ${more === 1 ? 'screenshot' : 'screenshots'}`}
            frame="h-full w-full"
            gallery={{ images: gallery, index: shown }}
            thumbnail={<span className="flex h-full w-full items-center justify-center text-[12px] font-medium tabular-nums text-muted">+{more}</span>}
          />
        </li>
      )}
    </ul>
  )
}

/**
 * The result part of an assignment's card (2026-11-07): up to three result lines and the
 * limitation, the choices it leaves to the user, then its screenshots small at the foot
 * beside its two actions. A result with files offers Request changes and Confirm, whose
 * tooltip says what it commits, and its file count opens the diff; one with nothing to
 * commit offers Open report, Follow up and Close. Either sends feedback to the same
 * Session. The card's header carries the status; a commit or merge that did not land adds
 * its reason here, in one line, with the way into the Session where it gets fixed.
 */
export function WorkResultBody({
  result,
  actions,
  blocked = false,
  sessionSettled = false,
  onOpenSession,
  onOpenReport,
  onOpenDiff,
}: {
  result: WorkResult
  actions?: WorkResultActions
  /** The header says Merge blocked or Commit blocked, so the reason belongs under it. */
  blocked?: boolean
  /** The Session is settled: Retry waits until the user reopens it, Open Session stays. */
  sessionSettled?: boolean
  onOpenSession?: () => void
  /** Opens the Session at the lead's report, for a report or one that leaves choices. */
  onOpenReport?: () => void
  /** Opens the Session with its diff beside it, from a result's file count. */
  onOpenDiff?: (chatId: string) => void
}) {
  const request = useRequest(actions?.requestEvents ?? NO_EVENTS)
  const { pending, cancel } = request
  const connected = actions?.connected === true
  const handoffId = result.handoffId
  // Shared with the bar's Request changes, which opens this field from above the composer.
  const readChanges = () => readWorkChangesOpen(handoffId)
  const changesOpen = useSyncExternalStore(subscribeWorkProposals, readChanges, readChanges)
  const setWriting = (next: boolean) => setWorkChangesOpen(handoffId, next)
  const [error, setError] = useState<string | null>(null)
  const open = result.decision === 'open' && actions !== undefined
  const writing = open && changesOpen
  const wasWriting = useRef(writing)
  const reason = blocked ? workBlockedReason(result) : undefined
  const settled = result.decision === 'closed'
  const askCheckout = actions?.askCheckout
  const sessionId = result.workChatId

  // A worktree Session merges into the branch its linked folders are on; ask once so Confirm can say which.
  useEffect(() => {
    if (open && result.worktree && result.mergeInto === undefined && sessionId !== null) askCheckout?.(sessionId)
  }, [open, result.worktree, result.mergeInto, sessionId, askCheckout])

  // Focus only when the field opens, not when a card that left it open mounts again.
  // The bar's Request changes scrolls the card in and focuses the field itself.
  useEffect(() => {
    wasWriting.current = writing
  }, [writing])

  // An answer lost with the socket never arrives, so the request is dropped rather than
  // left pending; the reconnect snapshot then shows whether it landed.
  useEffect(() => {
    if (!connected && pending) {
      cancel()
      setError(WORK_RESULT_CONNECTION_LOST)
    }
    if (connected) setError((current) => current === WORK_RESULT_CONNECTION_LOST ? null : current)
  }, [connected, pending, cancel])

  const accept = () => {
    if (actions === undefined) return
    setError(null)
    request.start(
      (requestId) => actions.accept(result.handoffId, result.mergeInto, result.version, requestId),
      { onNotice: (notice) => setError(notice.text) },
    )
  }
  const send = (text: string) => {
    if (actions === undefined) return
    setError(null)
    request.start(
      (requestId) => sendWorkChanges(actions.requestEvents, handoffId, text, requestId,
        () => actions.revise(result.handoffId, result.version, text, requestId)),
      {
        onNotice: (notice) => setError(notice.text),
      },
    )
  }
  const refused = reason === undefined ? undefined : result.completion?.retryRefused
  const canRetry = reason !== undefined && refused === undefined && !sessionSettled && actions !== undefined
  const retry = () => {
    if (actions === undefined) return
    setError(null)
    request.start(
      (requestId) => actions.retry(result.handoffId, requestId),
      { onNotice: (notice) => setError(notice.text) },
    )
  }
  const confirmTitle = open ? workConfirmTitle(result) : undefined
  const labels = workResultActionLabels(result)
  const report = open && onOpenReport !== undefined && (result.operation === 'none' || result.choices !== undefined) ? onOpenReport : undefined

  const files = workResultFiles(result)
  const openDiff = files === undefined || sessionId === null || onOpenDiff === undefined ? undefined : () => onOpenDiff(sessionId)
  const picked = useSyncExternalStore(subscribeWorkChanges, () => readWorkChanges(handoffId), () => readWorkChanges(handoffId))
  const pick = (choice: GoalChoice, option: string) => {
    setError(null)
    const next = pickWorkChoice(readWorkChanges(handoffId), choice, option)
    writeWorkChanges(handoffId, next)
    setWriting(workChangesAsked(next, result.choices))
  }
  const actionRow = open && !writing
  // Open choices hold Confirm, and its tooltip says why instead of what it commits.
  const confirmWait = workConfirmWait(picked, result)
  const primaryTitle = confirmWait ?? confirmTitle
  // The file count stays while the user writes changes or a commit is blocked: that is when the diff matters.
  const footer = result.evidence.length > 0 || actionRow || openDiff !== undefined

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ResultLines result={result} settled={settled} />
      {open ? <YourCall result={result} picked={picked} disabled={request.pending || !connected} onPick={pick} /> : null}
      {reason === undefined ? null : (
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p role="status" title={reason} className="m-0 line-clamp-2 text-[13px] leading-[1.45] text-muted">{reason}</p>
            {refused === undefined ? null : <p title={refused} className="m-0 line-clamp-2 text-[12.5px] leading-[1.45] text-dim">{refused}</p>}
          </span>
          {onOpenSession === undefined ? null : (
            <Button size="compact" variant="ghost" onClick={onOpenSession} className="shrink-0">Open Session</Button>
          )}
          {canRetry ? (
            <Button
              size="compact"
              variant="primary"
              disabled={request.pending || !connected}
              onClick={retry}
              title="Runs the commit again under your Confirm"
              className="shrink-0"
            >
              {request.pending ? 'Retrying…' : 'Retry'}
            </Button>
          ) : null}
        </div>
      )}
      <MergeFixPanel result={result} {...(actions === undefined ? {} : { actions })} {...(onOpenSession === undefined ? {} : { onOpenSession })} />

      {footer ? (
        <div className="relative flex min-w-0 flex-wrap items-center justify-between gap-2">
          <EvidenceRow evidence={result.evidence} />
          {actionRow || openDiff !== undefined ? (
            <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
              {actionRow && report !== undefined ? <Button size="compact" variant="ghost" onClick={report}>Open report</Button> : null}
              {openDiff === undefined ? null : (
                <Button size="compact" variant="ghost" onClick={openDiff} title="Show the diff">{files}</Button>
              )}
              {actionRow ? (
                <>
                  <Button size="compact" variant="ghost" disabled={request.pending || !connected} onClick={() => { setError(null); setWriting(true) }}>
                    {labels.secondary}
                  </Button>
                  <Button
                    size="compact"
                    variant="primary"
                    disabled={request.pending || !connected || confirmWait !== undefined}
                    onClick={accept}
                    {...(primaryTitle === undefined ? {} : { title: primaryTitle })}
                  >
                    {request.pending ? labels.pending : labels.primary}
                  </Button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      {writing ? (
        <WorkChangesField
          handoffId={handoffId}
          pending={request.pending}
          connected={connected}
          autoFocus={!wasWriting.current}
          onCancel={() => setWriting(false)}
          onSend={send}
        />
      ) : null}
      {error === null ? null : <p role="alert" className="m-0 text-[13px] text-danger">{error}</p>}
    </div>
  )
}

/**
 * Why a result's Confirm waits on its open choices, read live from the Follow up text the
 * card's picks write, for the surfaces that offer Confirm away from the card.
 */
export function useConfirmWait(handoffId: string, result: Pick<WorkResult, 'choices'>): string | undefined {
  const read = () => readWorkChanges(handoffId)
  return workConfirmWait(useSyncExternalStore(subscribeWorkChanges, read, read), result)
}

const NO_EVENTS: RequestEvents = { subscribe: () => () => undefined }
