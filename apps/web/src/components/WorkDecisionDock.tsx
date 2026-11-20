import { useEffect, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { AgentConfig } from '@manor/contracts'
import type { WorkAcceptanceOptions } from '@manor/client-runtime/commands'
import { acceptWorkProposal, setWorkChangesOpen } from '@manor/client-runtime/work-proposals'
import { WORK_RESULT_CONNECTION_LOST, openWorkDecisions, workConfirmTitle, workResultActionLabels, type Row, type WorkHandoffRow, type WorkResult } from '../state'
import { EASE_OUT } from '../motion'
import { useRequest } from '../useRequest'
import { useWorkProposal } from '../useWorkProposal'
import { Button } from './ui/Button'
import { WORK_CHANGES_FIELD, useConfirmWait, type WorkResultActions } from './WorkResultBody'

// Rows come and go as their cards scroll past, so the fade stays short and quiet.
const FADE = { duration: 0.2, ease: EASE_OUT }

/** How a Session's changed files stand against its Ready result, as its status read last said. */
export interface SessionReadiness {
  /** The Session's changed files Confirm leaves out, the diff's Not included. */
  excluded: (sessionId: string) => number | undefined
  /** Reads that again; asked when a row appears and when the Session moves on. */
  ask: (sessionId: string) => void
  /** Changes when the Session gets a new message, so the count is read again. */
  updatedAt: (sessionId: string) => number | undefined
}

/**
 * The Session cards in this thread that wait on the user and are out of view, one row each
 * above the composer, so a proposal or a result never scrolls out of reach. A row carries
 * its card's two actions under the card's labels; the rest of the row scrolls to the card
 * (in a Session, which has no card, it opens the diff). Gone when every open card is in
 * view, and until the thread has said which ones are (`inView` null). A result whose
 * Session works again drops out until it waits once more.
 */
export function WorkDecisionDock({
  rows,
  inView,
  agents,
  onAcceptProposal,
  onRejectProposal,
  resultActions,
  readiness,
  onReveal,
}: {
  rows: readonly Row[]
  inView: ReadonlySet<string> | null
  agents: AgentConfig[]
  onAcceptProposal: (handoffId: string, options: WorkAcceptanceOptions) => Promise<unknown> | void
  onRejectProposal: (handoffId: string) => void
  resultActions: WorkResultActions
  readiness?: SessionReadiness
  onReveal: (rowKey: string, focus?: string) => void
}) {
  const reduce = useReducedMotion() ?? false
  // A project thread's own sessions stand in the room's overview, not here (2026-10-11).
  const open = inView === null ? [] : openWorkDecisions(rows, inView)
  // Reduced motion keeps the fade and drops the height change.
  const hidden = reduce ? { opacity: 0 } : { opacity: 0, height: 0 }
  return (
    <AnimatePresence initial={false}>
      {open.length === 0 ? null : (
        <motion.div
          key="work-decisions"
          role="region"
          aria-label="Needs you"
          className="pointer-events-auto mb-2 w-full min-w-0 max-w-[760px]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={FADE}
        >
          {/* Three rows show; a fourth peeks in under the cut, which says the list scrolls.
              Same frosted fill and hairline as the composer below it, so it lifts off the canvas. */}
          <ul className="scrollbar-hidden m-0 flex max-h-work-dock-max list-none flex-col overflow-y-auto rounded-2xl border border-composer-line bg-[color-mix(in_srgb,var(--color-composer)_82%,transparent)] p-1 backdrop-blur-[16px] backdrop-saturate-[1.08]">
            <AnimatePresence initial={false}>
              {open.map((decision) => (
                <motion.li
                  key={decision.row.key}
                  className="min-w-0 shrink-0 overflow-hidden"
                  initial={hidden}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={hidden}
                  transition={FADE}
                >
                  {decision.kind === 'proposal'
                    ? <ProposalRow row={decision.row} agents={agents} onAccept={onAcceptProposal} onReject={onRejectProposal} onReveal={onReveal} />
                    : <ResultRow row={decision.row} result={decision.row.report!} actions={resultActions} {...(readiness === undefined ? {} : { readiness })} onReveal={onReveal} />}
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function ProposalRow({ row, agents, onAccept, onReject, onReveal }: {
  row: WorkHandoffRow
  agents: AgentConfig[]
  onAccept: (handoffId: string, options: WorkAcceptanceOptions) => Promise<unknown> | void
  onReject: (handoffId: string) => void
  onReveal: (rowKey: string) => void
}) {
  const proposal = useWorkProposal(row, agents)
  return (
    <DecisionRow
      kind="Proposal"
      row={row}
      error={proposal.error}
      onReveal={onReveal}
      secondary={{ label: 'Reject', disabled: proposal.accepting, onClick: () => onReject(row.handoffId) }}
      primary={{
        label: proposal.accepting ? 'Accepting…' : 'Accept',
        action: 'Accept',
        disabled: proposal.accepting,
        onClick: () => void acceptWorkProposal(row, agents, onAccept),
      }}
    />
  )
}

function ResultRow({ row, result, actions, readiness, onReveal }: {
  row: WorkHandoffRow
  result: WorkResult
  actions: WorkResultActions
  readiness?: SessionReadiness
  onReveal: (rowKey: string, focus?: string) => void
}) {
  const request = useRequest(actions.requestEvents)
  const { pending, cancel } = request
  const { connected, askCheckout } = actions
  const [error, setError] = useState<string | null>(null)
  const sessionId = result.workChatId
  const confirmWait = useConfirmWait(result.handoffId, result)
  const confirmTitle = confirmWait ?? workConfirmTitle(result)
  const labels = workResultActionLabels(result)
  const excluded = sessionId === null ? undefined : readiness?.excluded(sessionId)
  const updatedAt = sessionId === null ? undefined : readiness?.updatedAt(sessionId)
  const askReadiness = readiness?.ask

  // Only the Session's own status knows what Confirm would leave out; read it while the row shows.
  useEffect(() => {
    if (sessionId !== null && connected) askReadiness?.(sessionId)
  }, [sessionId, result.version, updatedAt, connected, askReadiness])

  // The card asks for this too, but it may sit in history that is not rendered yet.
  useEffect(() => {
    if (result.worktree && result.mergeInto === undefined && sessionId !== null) askCheckout(sessionId)
  }, [result.worktree, result.mergeInto, sessionId, askCheckout])

  useEffect(() => {
    if (!connected && pending) {
      cancel()
      setError(WORK_RESULT_CONNECTION_LOST)
    }
    if (connected) setError((current) => current === WORK_RESULT_CONNECTION_LOST ? null : current)
  }, [connected, pending, cancel])

  return (
    <DecisionRow
      kind="Ready"
      row={row}
      error={error}
      {...(excluded === undefined || excluded === 0 ? {} : { extra: `${excluded} ${excluded === 1 ? 'file' : 'files'} not included` })}
      onReveal={onReveal}
      secondary={{
        label: labels.secondary,
        disabled: pending || !connected,
        // What to change is written on the card: open its field, then bring the card in
        // once the field is there so the scroll lands on it and focus goes into it.
        onClick: () => {
          setWorkChangesOpen(result.handoffId, true)
          requestAnimationFrame(() => onReveal(row.key, WORK_CHANGES_FIELD))
        },
      }}
      primary={{
        label: pending ? labels.pending : labels.primary,
        action: labels.primary,
        disabled: pending || !connected || confirmWait !== undefined,
        ...(confirmTitle === undefined ? {} : { title: confirmTitle }),
        onClick: () => {
          setError(null)
          request.start(
            (requestId) => actions.accept(result.handoffId, result.mergeInto, result.version, requestId),
            { onNotice: (notice) => setError(notice.text) },
          )
        },
      }}
    />
  )
}

interface RowAction {
  label: string
  disabled: boolean
  onClick: () => void
}

function DecisionRow({ kind, row, error, extra, onReveal, secondary, primary }: {
  kind: 'Proposal' | 'Ready'
  row: WorkHandoffRow
  error: string | null
  /** The one case a row says more: Confirm would commit less than the diff shows. */
  extra?: string
  onReveal: (rowKey: string) => void
  secondary: RowAction
  /** `action` names the decision for screen readers while the label says it is underway. */
  primary: RowAction & { action: string; title?: string }
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 rounded-xl py-1 pr-1 pl-1 hover:bg-surface-2">
      <button
        type="button"
        onClick={() => onReveal(row.key)}
        className="flex min-w-0 flex-1 cursor-pointer flex-col items-start rounded-lg border-0 bg-transparent px-2.5 py-1 text-left"
      >
        <span className="flex w-full min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-[12px] text-dim">{kind}</span>
          <span className="min-w-0 truncate text-[14px] text-text">{row.title}</span>
          {/* Gives way before the title does: in a narrow pane it ends in an ellipsis first. */}
          {extra === undefined ? null : <span className="ml-auto min-w-0 shrink-[4] truncate pl-1 text-[12px] text-dim">{extra}</span>}
        </span>
        {error === null ? null : <span role="alert" className="w-full truncate text-[12px] text-danger">{error}</span>}
      </button>
      <Button
        size="compact"
        variant="ghost"
        disabled={secondary.disabled}
        aria-label={`${secondary.label} ${row.title}`}
        onClick={secondary.onClick}
        className="shrink-0"
      >
        {secondary.label}
      </Button>
      <Button
        size="compact"
        variant="primary"
        disabled={primary.disabled}
        aria-label={`${primary.action} ${row.title}`}
        {...(primary.title === undefined ? {} : { title: primary.title })}
        onClick={primary.onClick}
        className="shrink-0"
      >
        {primary.label}
      </Button>
    </div>
  )
}
