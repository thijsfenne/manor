import { useContext, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import type { WorkAcceptanceOptions } from '@manor/client-runtime/commands'
import { Attachment01Icon, CellsIcon, CheckmarkCircle02Icon } from '@hugeicons/core-free-icons'
import { acceptWorkProposal, updateWorkProposal, workProposalAttachmentLine, workProposalInThread, workProposalMultipleBlock } from '@manor/client-runtime/work-proposals'
import { SingleRuntimeSchema, workReopenedLine, type AgentConfig } from '@manor/contracts'
import { closedWorkHandoff, forwardedLine, threadWorkCard, workCardLine, workCardStatus, workDecisionOpen, workByline, workResultWaits, type ThreadWorkCard, type WorkHandoffRow, type WorkStatus } from '../state'
import { modelLabel } from '../runtimes'
import { CARD_RESHAPE, DISCLOSURE } from '../motion'
import { projectIcon } from '../projectAppearance'
import { useWorkProposal } from '../useWorkProposal'
import { AgentStack } from './inbox/AgentStack'
import { Icon } from './Icon'
import { NewChatModeControl } from './NewChatModeControl'
import { ProjectBadge } from './ProjectBadge'
import { SingleRuntimeControl } from './SingleRuntimeControl'
import { Button } from './ui/Button'
import { Checkbox } from './ui/Checkbox'
import { SIDE_SURFACE } from './ui/dockPanel'
import { BUNDLE_TILE, BUNDLE_TILE_HOVER, InBundle } from './bundleTile'
import { WorkPromptDialog } from './WorkPromptDialog'
import { RowArrivalsContext } from './rowArrivals'
import { WORK_STATUS_TONE, WorkCardStatusLabel, WorkResultBody, WorkStatusLabel, WorkStatusMark, type WorkResultActions } from './WorkResultBody'

/** A press on one of these inside a card is that control's, not "open the Session". */
const CONTROLS = 'button, a, input, textarea, select, label, [role="menu"], [role="listbox"], [role="dialog"]'

/**
 * An assignment's one element in the DM that briefed it. A proposal carries its model,
 * the prompt, Worktree, Reject and Accept on one row; once accepted the card is its state (Working, Ready, Committing…)
 * and a press on it opens the Session; once done it folds to one line.
 */
export function WorkHandoffCard({
  row,
  agents,
  identityAgents = agents,
  onReveal,
  onAccept,
  onReject,
  onOpenThread,
  onOpenReport,
  onOpenDiff,
  resultActions,
  inThread = false,
}: {
  row: WorkHandoffRow
  agents: AgentConfig[]
  /**
   * The whole household, for the team's faces. A Single chat or project thread hands
   * `agents` in empty, which keeps its proposal defaults off any persona's runtime, but
   * the lead and team it names are still real personas with their own faces.
   */
  identityAgents?: AgentConfig[]
  /** Scrolls another card into view by row key; a replaced proposal points at its newest version. */
  onReveal: (rowKey: string) => void
  onAccept?: (handoffId: string, options: WorkAcceptanceOptions) => Promise<unknown> | void
  onReject?: (handoffId: string) => void
  onOpenThread?: (chatId: string) => void
  /** Opens the Session at its lead's report, from a waiting result's Open report. */
  onOpenReport?: (chatId: string) => void
  /** Opens the Session with its diff beside it, from a ready card's file count. */
  onOpenDiff?: (chatId: string) => void
  resultActions?: WorkResultActions
  /**
   * Set in a project thread: the card changes shape as its Session moves (one line once
   * accepted, one line once done), and the line's word is the overview's for its Session.
   */
  inThread?: boolean
}) {
  const proposal = useWorkProposal(row, agents, identityAgents)
  const tile = useContext(InBundle)
  const { mode, runtime, isolate, accepting, error } = proposal
  const editedTask = proposal.task
  const [promptOpen, setPromptOpen] = useState(false)
  // False until the card has shown once, so only a later change of shape fades.
  const settledRef = useRef(false)
  useEffect(() => { settledRef.current = true }, [])
  // A card that turns up while the thread is open fades in where it lands, the way it
  // fades into each next shape. One that was already there on open is simply there.
  const arrivals = useContext(RowArrivalsContext)
  const [arrived] = useState(() => arrivals !== null && arrivals.current.ready && !arrivals.current.known.has(row.key))
  const pending = row.acceptedAt === null
  const canAccept = pending && row.status === 'Working' && onAccept !== undefined
  const canReject = pending && row.status === 'Working' && onReject !== undefined
  const singleMode = pending ? mode === 'single' : row.mode === 'single'
  const singleDriver = pending ? runtime.driver : row.singleDriver ?? runtime.driver
  const controlsId = `work-handoff-${row.handoffId}`
  const sessionId = row.workChatId
  const openSession = sessionId === null || onOpenThread === undefined || (pending && row.status === 'Working')
    ? undefined
    : () => onOpenThread(sessionId)

  // A revised proposal leaves its earlier version as one line that leads to the current one.
  const replacement = row.replacedBy
  if (replacement !== undefined) {
    return (
      <button
        type="button"
        id={controlsId}
        onClick={() => onReveal(replacement.key)}
        className={`${tile ? `${BUNDLE_TILE} border-0` : 'mx-auto flex w-full max-w-[620px] min-w-0 gap-2.5 rounded-lg border border-dashed border-line bg-transparent px-3.5 py-2 text-left text-[12px]'} cursor-pointer items-center text-dim [font-family:inherit] hover:text-muted`}
      >
        <span className="min-w-0 flex-1 truncate text-muted">{row.title}</span>
        <span className="shrink-0">Replaced by v{replacement.revision}</span>
      </button>
    )
  }
  // A proposal that never ran leaves one line, not a dimmed card: there is nothing in it to read back.
  const closed = closedWorkHandoff(row)
  if (closed !== null) {
    return (
      <div id={controlsId} className={`${tile ? BUNDLE_TILE : 'mx-auto flex w-full max-w-[620px] min-w-0 gap-2.5 rounded-lg border border-dashed border-line px-3.5 py-2 text-[12px]'} items-center text-dim`}>
        <span className="min-w-0 flex-1 truncate text-muted line-through decoration-dim">{row.title}</span>
        <span className="shrink-0">{closed}</span>
      </div>
    )
  }
  // A brief handed to its project thread (2026-10-10): one line that follows the session
  // the thread started. Once the Session exists a press opens the project room with it on the
  // right (what the overview's own row does); before that it opens the thread.
  const forwarded = row.forwarded
  if (forwarded !== undefined) {
    const threadChatId = forwarded.threadChatId
    const openForwarded = threadChatId === null || onOpenThread === undefined ? undefined : () => onOpenThread(row.workChatId ?? threadChatId)
    return (
      <button
        type="button"
        id={controlsId}
        disabled={openForwarded === undefined}
        onClick={openForwarded}
        aria-label={`${row.title}: ${forwardedLine(row)}`}
        className="mx-auto flex w-full max-w-[620px] min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border border-line bg-transparent px-3.5 py-2 text-left text-[12px] text-dim enabled:hover:bg-surface-2 enabled:hover:text-muted disabled:cursor-default"
      >
        <Icon icon={projectIcon(row.projectIcon)} size={14} className="flex-none" style={{ color: row.projectColor }} />
        <span className="min-w-0 flex-1 truncate text-[13px] text-text">{row.title}</span>
        <span className={`shrink-0 ${forwarded.phase === 'ready' ? 'font-medium text-warn' : ''}`}>{forwardedLine(row)}</span>
      </button>
    )
  }
  const shape: ThreadWorkCard | null = inThread ? threadWorkCard(row) : null
  const done = shape === null ? workCardLine(row) : shape.shape === 'done' ? shape : null
  const content = done !== null ? (
    <DoneLine id={controlsId} title={row.title} summary={done.summary} status={done.status} marked={shape !== null} {...(openSession === undefined ? {} : { onOpen: openSession })} />
  ) : shape?.shape === 'line' ? (
    <SessionLine id={controlsId} row={row} status={shape.status} {...(openSession === undefined ? {} : { onOpen: openSession })} />
  ) : null
  if (shape === null && content !== null) return content
  if (shape !== null) {
    // A new shape fades in where the old one stood; the first one is simply there.
    return (
      <motion.div key={shape.shape} initial={settledRef.current || arrived ? { opacity: 0 } : false} animate={{ opacity: 1 }} transition={CARD_RESHAPE}>
        {content ?? fullCard()}
      </motion.div>
    )
  }
  if (arrived) {
    return (
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={CARD_RESHAPE}>
        {fullCard()}
      </motion.div>
    )
  }
  return fullCard()

  // The card with everything on it: a proposal, a result to confirm, or one outside a thread.
  function fullCard() {
    const report = row.report
    const blocked = workCardStatus(row)?.tone === 'warn'
    const byline = workByline(singleMode
      ? { single: true, model: modelLabel(singleDriver, pending ? runtime.model : row.singleModel) }
      : { single: false, lead: row.leadAgentName, starter: row.firstExecutorName })
    // Only a proposal whose session does not exist yet can still take an edit.
    const proposedTask = canAccept && sessionId === null ? row.task : undefined
    const multipleBlock = canAccept ? workProposalMultipleBlock(row, identityAgents) : undefined
    // A card that starts in a project thread is always Single (2026-11-17), so only a brief
    // that starts its own Session offers the mode.
    const modeChoice = canAccept && !workProposalInThread(row)
    // The model is named once, on its button; the summary stands alone under the title.
    // A result reads without it (2026-11-07): its lines and status say what matters.
    const summary = canAccept ? row.summary ?? row.task : undefined
    const metaByline = (canAccept && singleMode) || report !== undefined ? undefined : byline
    const attachmentLine = canAccept ? workProposalAttachmentLine(row) : undefined
    const accept = () => {
      if (onAccept !== undefined) void acceptWorkProposal(row, agents, onAccept, identityAgents)
    }
    const revision = row.revision === undefined ? null : <span className="shrink-0 text-[12px] font-normal text-dim">v{row.revision}</span>
    // A DM card wraps its title instead of truncating it and names the project after the last word, kept on
    // that word's line so the pill never takes a line of its own. The thread's card keeps one line.
    const lastWord = row.title.lastIndexOf(' ') + 1
    const titleText = inThread ? row.title : (
      <>
        {row.title.slice(0, lastWord)}
        <span className="whitespace-nowrap">
          {row.title.slice(lastWord)}
          {revision === null ? null : <>{' '}{revision}</>}
          {/* The badge's own max-w-full would win over a width set on it, so its box bounds it instead. */}
          <span className="ml-1.5 inline-flex max-w-[45%] align-[-1px]">
            <ProjectBadge name={row.projectName} icon={row.projectIcon} color={row.projectColor} />
          </span>
        </span>
      </>
    )
    const fit = inThread ? 'truncate' : 'leading-[1.45]'
    const title = openSession === undefined ? (
      <span className={`min-w-0 ${fit} text-[14px] font-medium text-text`}>{titleText}</span>
    ) : (
      <button
        type="button"
        onClick={openSession}
        aria-label={`Open Session ${row.title}`}
        className={`min-w-0 cursor-pointer ${fit} rounded-sm border-0 bg-transparent p-0 text-left text-[14px] font-medium text-text [font-family:inherit]`}
      >
        {titleText}
      </button>
    )
    const pressCard = openSession === undefined ? undefined : (event: MouseEvent<HTMLDivElement>) => {
      if (event.target instanceof Element && event.target.closest(CONTROLS) !== null) return
      // Selecting text in the result is reading it, not opening the Session.
      if (window.getSelection()?.isCollapsed === false) return
      openSession()
    }
    return (
      <div
        id={controlsId}
        data-reveal-target
        data-work-card={workDecisionOpen(row) ? row.key : undefined}
        tabIndex={-1}
        onClick={pressCard}
        className={`mx-auto flex w-full max-w-[620px] scroll-mt-16 scroll-mb-[var(--composer-dock,0px)] flex-col gap-3 rounded-xl ${SIDE_SURFACE} px-4 py-3 shadow-pill outline-none${
          pressCard === undefined ? '' : ' cursor-pointer'
        }`}
      >
        <div className="flex items-start">
          <span className="min-w-0 flex-1">
            <span className={`flex gap-2 ${inThread ? 'items-center' : 'items-start'}`}>
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                {title}
                {inThread ? revision : null}
              </span>
              <WorkCardStatusLabel row={row} />
            </span>
            {metaByline === undefined && (inThread || pending || !row.worktreeBranch) ? null : (
              <span className="mt-0.5 flex min-w-0 items-center gap-2 text-[12px] text-muted">
                {metaByline === undefined ? null : <span className="min-w-0 truncate">{metaByline}</span>}
                {/* The thread is the project's own room: the branch is noise there. */}
                {!inThread && !pending && row.worktreeBranch ? <span className="min-w-0 truncate">{row.worktreeBranch}</span> : null}
              </span>
            )}
            {summary === undefined ? null : <ExpandableSummary text={summary} title={editedTask ?? row.task} />}
            {attachmentLine === undefined ? null : (
              <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-dim" title={attachmentLine}>
                <Icon icon={Attachment01Icon} size={13} className="flex-none" />
                <span className="min-w-0 truncate">{attachmentLine}</span>
              </span>
            )}
            {row.changedAfterReady === true ? (
              <span className="mt-1.5 block text-[12.5px] leading-[1.45] text-dim">
                {workReopenedLine(singleMode ? undefined : row.leadAgentName)}
              </span>
            ) : null}
            {report === undefined ? null : (
              <div className="mt-3">
              <WorkResultBody
                result={report}
                blocked={blocked}
                sessionSettled={row.status === 'Settled'}
                // While the Session works again, or asks, its result is not the user's move yet.
                // A blocked commit is, through Retry.
                {...(resultActions === undefined || !(workResultWaits(row) || blocked) ? {} : { actions: resultActions })}
                {...(openSession === undefined ? {} : { onOpenSession: openSession })}
                {...(sessionId === null || onOpenReport === undefined ? {} : { onOpenReport: () => onOpenReport(sessionId) })}
                {...(onOpenDiff === undefined ? {} : { onOpenDiff })}
              />
              </div>
            )}
          </span>
        </div>
        {canAccept || canReject ? (
          // One row: who runs it and the prompt on the left, the verbs on the right. A pane
          // too narrow for both drops the verbs to a second line, still on the right.
          <div className="flex flex-wrap items-center gap-2">
            {modeChoice ? (
              <>
                <NewChatModeControl
                  mode={mode}
                  disabled={accepting}
                  multipleDisabled={multipleBlock !== undefined}
                  idPrefix={`${controlsId}-mode`}
                  panelId={controlsId}
                  onChange={(next) => updateWorkProposal(row.handoffId, { mode: next })}
                />
                {multipleBlock === undefined ? null : <span className="min-w-0 text-[12px] text-dim">{multipleBlock}</span>}
              </>
            ) : null}
            {canAccept && singleMode ? (
              <SingleRuntimeControl
                override={runtime}
                fallback={runtime}
                allowAuto={false}
                disabled={accepting}
                onChange={(next) => {
                  const parsed = SingleRuntimeSchema.safeParse(next)
                  if (parsed.success) updateWorkProposal(row.handoffId, { runtime: parsed.data })
                }}
              />
            ) : canAccept ? (
              <AgentStack agentIds={[row.leadAgentId, ...row.supportingAgentIds]} agents={identityAgents} footprint={18} size={14} />
            ) : null}
            {proposedTask === undefined ? null : (
              <Button size="compact" variant="ghost" disabled={accepting} onClick={() => setPromptOpen(true)} className="text-muted">
                {editedTask === undefined ? 'View prompt' : 'Edited prompt'}
              </Button>
            )}
            <span className="ml-auto flex items-center gap-2">
              {canAccept && row.worktreeAvailable ? (
                <label className="flex items-center gap-2 pr-1 text-[13px] text-muted">
                  <Checkbox checked={isolate} disabled={accepting} onChange={(next) => updateWorkProposal(row.handoffId, { isolate: next })} />Worktree
                </label>
              ) : null}
              {canReject ? (
                <Button size="compact" variant="ghost" disabled={accepting} onClick={() => { onReject?.(row.handoffId) }}>
                  Reject
                </Button>
              ) : null}
              {canAccept ? (
                <Button size="compact" variant="primary" disabled={accepting} onClick={accept}>
                  {accepting ? 'Accepting…' : 'Accept'}
                </Button>
              ) : null}
            </span>
          </div>
        ) : null}
        {error === null ? null : <p role="alert" className="m-0 text-[13px] text-danger">{error}</p>}
        {promptOpen && proposedTask !== undefined ? (
          <WorkPromptDialog
            title={row.title}
            task={editedTask ?? proposedTask}
            onSave={(task) => updateWorkProposal(row.handoffId, { task: task === proposedTask ? undefined : task })}
            onClose={() => setPromptOpen(false)}
          />
        ) : null}
      </div>
    )
  }
}

/**
 * A proposal's summary, cut at the end of its second line. "Show more" hangs on a
 * measured overflow, never on a character count: at this width most summaries fit and
 * a control over text that is already whole would lie. Clamped only while closed and
 * still, so the height can travel between the two lines and the full text.
 */
function ExpandableSummary({ text, title }: { text: string; title?: string | undefined }) {
  const reduce = useReducedMotion() ?? false
  const body = useRef<HTMLSpanElement>(null)
  const [open, setOpen] = useState(false)
  const [moving, setMoving] = useState(false)
  // The clamped height, set only while the text overflows it; null means nothing is hidden.
  const [closedHeight, setClosedHeight] = useState<number | null>(null)
  const clamped = !open && !moving

  useLayoutEffect(() => {
    const node = body.current
    // Measured clamped only: open, the two heights agree and a re-measure would delete the way back.
    if (node === null || !clamped) return
    const measure = () => setClosedHeight(node.scrollHeight - node.clientHeight > 1 ? node.clientHeight : null)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [clamped, text])

  return (
    <>
      <motion.span
        initial={false}
        animate={{ height: open || closedHeight === null ? 'auto' : closedHeight }}
        transition={reduce ? { duration: 0 } : DISCLOSURE}
        onAnimationComplete={() => setMoving(false)}
        className="mt-1 block overflow-hidden"
      >
        <span ref={body} title={title} className={`text-[12.5px] leading-[1.45] text-muted [overflow-wrap:anywhere] ${clamped ? 'line-clamp-2' : 'block'}`}>{text}</span>
      </motion.span>
      {closedHeight === null ? null : (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => { setMoving(true); setOpen((value) => !value) }}
          className="mt-0.5 block cursor-pointer border-0 bg-transparent p-0 text-[12.5px] text-text [font-family:inherit] hover:underline"
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  )
}

/**
 * An accepted Session in its project thread: the Sessions mark in its state's colour, like
 * every Session line in the thread, its title and the word the overview has for it
 * (Working, Needs you). A press opens the Session.
 */
function SessionLine({ id, row, status, onOpen }: { id: string; row: WorkHandoffRow; status: WorkStatus; onOpen?: () => void }) {
  const tile = useContext(InBundle)
  const frame = tile
    ? `${BUNDLE_TILE} items-center`
    : `mx-auto flex w-full max-w-[620px] min-w-0 items-center gap-2.5 rounded-lg ${SIDE_SURFACE} px-3.5 py-2 text-left text-[12.5px]`
  const content = (
    <>
      <span className="flex w-4 flex-none"><Icon icon={CellsIcon} size={tile ? 15 : 14} className={WORK_STATUS_TONE[status.tone]} /></span>
      <span className={`min-w-0 flex-1 truncate text-text${tile ? '' : ' font-medium'}`}>{row.title}</span>
      <WorkStatusLabel status={status} />
    </>
  )
  return onOpen === undefined
    ? <div id={id} className={frame}>{content}</div>
    : (
        <button type="button" id={id} onClick={onOpen} aria-label={`Open Session ${row.title}, ${status.text}`} className={`${frame} cursor-pointer [font-family:inherit] ${tile ? BUNDLE_TILE_HOVER : 'hover:bg-raised'}`}>
          {content}
        </button>
      )
}

/**
 * A done assignment: title, the first sentence of what came of it, and the outcome. In
 * a project thread it leads with the Sessions mark, the way it stands among the notes of
 * a bundle. A press opens the Session.
 */
function DoneLine({ id, title, summary, status, marked, onOpen }: { id: string; title: string; summary: string; status: WorkStatus; marked: boolean; onOpen?: () => void }) {
  const tile = useContext(InBundle)
  const content = (
    <>
      {marked
        ? <span className="flex w-4 flex-none"><Icon icon={CellsIcon} size={tile ? 15 : 14} className={`flex-none ${WORK_STATUS_TONE[status.tone]}`} /></span>
        : null}
      <span className="min-w-0 flex-1 truncate text-muted">
        <span className={tile ? 'text-text' : 'font-medium text-text'}>{title}</span>
        {summary === '' ? null : <>, {summary}</>}
      </span>
      <span className={`flex shrink-0 items-center ${tile ? 'gap-1.25 text-[12.5px]' : 'gap-1.5'} ${WORK_STATUS_TONE[status.tone]}`}>
        {/* A finished Session that waits on no Confirm still gets the check, in its muted tone. */}
        {marked && status.text === 'Done' ? <Icon icon={CheckmarkCircle02Icon} size={13} /> : <WorkStatusMark status={status} />}
        {status.text}
      </span>
    </>
  )
  const frame = tile
    ? `${BUNDLE_TILE} items-center`
    : `mx-auto flex w-full max-w-[620px] min-w-0 items-center gap-2.5 rounded-lg ${SIDE_SURFACE} px-3.5 py-2 text-left text-[12.5px]`
  return onOpen === undefined
    ? <div id={id} className={frame}>{content}</div>
    : (
        <button type="button" id={id} onClick={onOpen} title="Open Session" className={`${frame} cursor-pointer [font-family:inherit] ${tile ? BUNDLE_TILE_HOVER : 'hover:bg-raised'}`}>
          {content}
        </button>
      )
}
