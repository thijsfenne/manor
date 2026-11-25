import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentPropsWithoutRef, type CSSProperties, type ReactNode } from 'react'
import { readWorkChangesOpen, setWorkChangesOpen, subscribeWorkProposals } from '@manor/client-runtime/work-proposals'
import {
  ArrowDown01Icon, ArrowUp01Icon, Cancel01Icon, MoreHorizontalIcon, PlusMinusIcon, PlusMinusSquare01Icon, Refresh01Icon,
} from '@hugeicons/core-free-icons'
import type { ServerMessage } from '@manor/contracts'
import { copyText } from '../../clipboard'
import { toast } from '../../notices'
import { changeRuns, sessionDiffView, withoutWhitespaceChanges, type ChangeRun, type DiffViewFile } from '../../diffView'
import { useRequest } from '../../useRequest'
import { sendWorkChanges } from '../../workChanges'
import { workResultActionLabels, type WorkResult } from '../../state'
import { Button } from '../ui/Button'
import { DOCK_PANEL_GAP, DOCK_PANEL_SHELL, dockPanelLayoutClass } from '../ui/dockPanel'
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu'
import { Icon } from '../Icon'
import { WorkChangesField } from '../WorkChangesField'
import { useConfirmWait, type WorkResultActions } from '../WorkResultBody'
import { DiffFileCard, type DiffLayout } from './DiffFileCard'
import { SESSION_CONNECTION_LOST } from './SessionSections'
import { DiffFileJump } from './DiffFileJump'

export type SessionDiffReply = Extract<ServerMessage, { type: 'session_diff' }>

/** Whole Session is what Confirm or Commit would land; a turn is what one turn changed. */
export type DiffScope = { kind: 'session' } | { kind: 'turn'; turnId: string }
export const SESSION_SCOPE: DiffScope = { kind: 'session' }

/** A turn that changed files: who answered, where there is a persona, and when. */
export interface DiffTurn {
  turnId: string
  who?: string
  at?: string
}

/** `Smith, 14:02`, or `Turn, 14:02` where a Single Session's model answered. */
const turnName = (turn: DiffTurn, first = turn.who ?? 'Turn') => [first, ...(turn.who !== undefined && first !== turn.who ? [turn.who] : []), ...(turn.at === undefined ? [] : [turn.at])].join(', ')

/** Split needs both sides at a readable width; below this the pane only stacks. */
export const SPLIT_MIN_WIDTH = 900
const LAYOUT_KEY = 'manor:diff-layout'

/** A result waiting for Confirm, and what the card's own Confirm sends. */
export interface WaitingGoal {
  handoffId: string
  version: number
  mergeInto?: string
  /** What Confirm commits, said in its tooltip as on the card. */
  confirmTitle?: string
  /** Nothing to commit: the actions read Follow up and Close, as on the card. */
  operation?: WorkResult['operation']
  /** The report's open choices, which hold Confirm until answered, as on the card. */
  choices?: WorkResult['choices']
}

interface DiffPanelProps {
  /** The chat has a linked git folder, so the whole Session can be diffed. */
  hasSession: boolean
  /** The Session's Changes, the same numbers its panel's Changes row reads. */
  sessionChanges?: { files: number; added: number; removed: number }
  scope: DiffScope
  /** Turns in this chat that changed files, newest first. */
  turns: readonly DiffTurn[]
  onScope: (scope: DiffScope) => void
  /** The whole-Session diff as last read; undefined until the first answer. */
  sessionDiff: SessionDiffReply | undefined
  onRead: (ignoreWhitespace: boolean) => void
  /** One turn's files; undefined when that turn is no longer in the transcript. */
  turnFiles: readonly DiffViewFile[] | undefined
  goal?: WaitingGoal
  actions: WorkResultActions
  /** Track width, gutter included, the same number the region reserved. */
  width: number
  overlay: boolean
  revealed: boolean
  resizing: boolean
  resizeProps: ComponentPropsWithoutRef<'div'>
  onClose: () => void
  onOpenFile?: (panelPath: string) => void
  onReference?: (panelPath: string) => void
}

/**
 * What changed, beside the chat. Whole Session by default, which is exactly what Confirm
 * or Commit would land; one turn when opened from that turn's changed-files card. Every
 * file is a card in one scrolling list, stacked by default, with a strip of one tick per
 * file along the edge and a menu to jump between them.
 */
export function DiffPanel({
  hasSession, sessionChanges, scope, turns, onScope, sessionDiff, onRead, turnFiles, goal, actions,
  width, overlay, revealed, resizing, resizeProps, onClose, onOpenFile, onReference,
}: DiffPanelProps) {
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(true)
  const [chosenLayout, setChosenLayout] = useState<DiffLayout>(() => readLayout())
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [current, setCurrent] = useState<string | null>(null)
  const [reloading, setReloading] = useState(false)
  const scroller = useRef<HTMLDivElement>(null)
  const cards = useRef(new Map<string, HTMLElement>())
  const contentWidth = width - DOCK_PANEL_GAP
  const layout: DiffLayout = contentWidth >= SPLIT_MIN_WIDTH ? chosenLayout : 'stacked'
  const sessionScope = scope.kind === 'session'

  // The whole-Session diff is read for the whitespace setting on screen, and again
  // whenever the Session's status moves (`onRead` changes with it).
  const read = sessionScope && hasSession
  const answered = sessionDiff !== undefined && sessionDiff.ignoreWhitespace === ignoreWhitespace
  useEffect(() => {
    if (read) onRead(ignoreWhitespace)
  }, [read, ignoreWhitespace, onRead])
  // Reload turns until the next answer lands, whatever it says.
  useEffect(() => setReloading(false), [sessionDiff])

  const { files, hidden, partial, error, loading } = useMemo(() => {
    if (sessionScope) {
      if (!hasSession) return { files: [], hidden: 0, partial: false, error: undefined, loading: false }
      if (sessionDiff === undefined) return { files: [], hidden: 0, partial: false, error: undefined, loading: true }
      return { files: sessionDiffView(sessionDiff.files), hidden: 0, partial: sessionDiff.partial, error: sessionDiff.error, loading: false }
    }
    if (turnFiles === undefined) return { files: [], hidden: 0, partial: false, error: 'That turn is no longer in this chat.', loading: false }
    const shown = ignoreWhitespace ? withoutWhitespaceChanges(turnFiles) : { files: [...turnFiles], hidden: 0 }
    return { ...shown, partial: turnFiles.some((file) => file.truncated), error: undefined, loading: false }
  }, [sessionScope, hasSession, sessionDiff, turnFiles, ignoreWhitespace])

  const cardRef = useCallback((key: string, element: HTMLElement | null) => {
    if (element === null) cards.current.delete(key)
    else cards.current.set(key, element)
  }, [])
  const toggle = useCallback((key: string) => setCollapsed((set) => {
    const next = new Set(set)
    if (!next.delete(key)) next.add(key)
    return next
  }), [])
  const copyPath = useCallback((path: string) => {
    void copyText(path).then((ok) => (ok ? toast.success('Path copied') : toast.error('Could not copy the path')))
  }, [])
  const allCollapsed = files.length > 0 && files.every((file) => collapsed.has(file.key))

  // Where the reader is: the last card whose top has reached the top of the pane.
  const locate = useCallback(() => {
    const pane = scroller.current
    if (pane === null) return
    // A jump lands a card at the edge; anything within a card gap of it counts.
    const top = pane.getBoundingClientRect().top + 12
    let found: string | null = files[0]?.key ?? null
    for (const file of files) {
      const card = cards.current.get(file.key)
      if (card !== undefined && card.getBoundingClientRect().top <= top) found = file.key
    }
    setCurrent(found)
  }, [files])
  useLayoutEffect(locate, [locate])

  const jump = useCallback((key: string) => {
    const pane = scroller.current
    const card = cards.current.get(key)
    if (pane === null || card === undefined) return
    pane.scrollTop += card.getBoundingClientRect().top - pane.getBoundingClientRect().top
    setCurrent(key)
  }, [])
  const step = useCallback((by: 1 | -1) => {
    const at = files.findIndex((file) => file.key === current)
    const next = files[Math.min(files.length - 1, Math.max(0, (at < 0 ? 0 : at) + by))]
    if (next !== undefined) jump(next.key)
  }, [files, current, jump])

  const options: ContextMenuItem[] = [
    { label: 'Stacked', checked: layout === 'stacked', onSelect: () => chooseLayout('stacked') },
    { label: contentWidth < SPLIT_MIN_WIDTH ? 'Split, in a wider pane' : 'Split', checked: layout === 'split', disabled: contentWidth < SPLIT_MIN_WIDTH, onSelect: () => chooseLayout('split') },
    { label: 'Hide whitespace', checked: ignoreWhitespace, onSelect: () => setIgnoreWhitespace((value) => !value) },
    allCollapsed
      ? { label: 'Expand all files', onSelect: () => setCollapsed(new Set()) }
      : { label: 'Collapse all files', disabled: files.length === 0, onSelect: () => setCollapsed(new Set(files.map((file) => file.key))) },
  ]
  function chooseLayout(next: DiffLayout) {
    setChosenLayout(next)
    writeLayout(next)
  }

  return (
    <aside
      aria-label="Changes"
      style={{ '--diff-width': `${width}px` } as CSSProperties}
      data-open={overlay ? revealed : undefined}
      className={`grid min-h-0 min-w-0 grid-rows-[auto_auto_minmax(0,1fr)] ${DOCK_PANEL_SHELL} ${dockPanelLayoutClass('w-[calc(var(--diff-width)-8px)]', false, overlay)}`}
      onKeyDown={(event) => {
        // Alt+↑/↓ walks the files. Bound here, not on the window: in the composer the
        // same keys move the caret by paragraph.
        if (!event.altKey || event.metaKey || event.ctrlKey || (event.key !== 'ArrowDown' && event.key !== 'ArrowUp')) return
        event.preventDefault()
        step(event.key === 'ArrowDown' ? 1 : -1)
      }}
    >
      <div {...resizeProps} className="group absolute inset-y-0 left-0 z-30 w-2 touch-none cursor-col-resize outline-none max-[760px]:hidden">
        <div className={`pointer-events-none absolute inset-y-0 left-[3px] w-0.5 bg-primary transition-opacity duration-150 group-hover:opacity-40 group-focus-visible:opacity-60 ${resizing ? 'opacity-60' : 'opacity-0'}`} />
      </div>

      {/* One bar: the source on the left, then the tools, the
          turn picker and the way out. The two pills are the two things the pane can
          show, the lit one being on screen. Whole Session has no menu because it is the
          only source Manor diffs; staged, branch and compare views were left out.
          A narrow pane drops the pill words first, then puts the tools on a second
          line, so no control ever leaves the bar. */}
      <div className="@container flex min-w-0 flex-wrap items-center gap-1.5 border-b border-line px-2.5 py-2">
        {hasSession ? (
          <button type="button" aria-pressed={sessionScope} title="Everything this Session would land" onClick={() => onScope(SESSION_SCOPE)}
            className={`${PILL} flex-none ${sessionScope ? PILL_ON : PILL_OFF}`}>
            <Icon icon={PlusMinusSquare01Icon} size={15} className="flex-none" />
            <span className={`${BAR_WORD} ${ALONE_WORD}`}>Whole Session</span>
            {sessionChanges === undefined ? null : <Totals {...sessionChanges} />}
          </button>
        ) : null}
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          <div role="toolbar" aria-label="Diff tools" className="flex h-8 flex-none items-center gap-0.5 rounded-full border border-line px-1">
            <ToolButton label="Reload diff" disabled={!read || reloading}
              onClick={() => {
                setReloading(true)
                onRead(ignoreWhitespace)
              }}>
              <Icon icon={Refresh01Icon} size={14} className={reloading ? 'motion-safe:animate-spin-calm' : ''} />
            </ToolButton>
            <OptionsButton items={options} />
            <ToolButton label="Previous file (⌥↑)" disabled={files.length < 2} onClick={() => step(-1)}><Icon icon={ArrowUp01Icon} size={14} /></ToolButton>
            <ToolButton label="Next file (⌥↓)" disabled={files.length < 2} onClick={() => step(1)}><Icon icon={ArrowDown01Icon} size={14} /></ToolButton>
            <DiffFileJump files={files} current={current} onJump={jump} />
          </div>
          <TurnsPill turns={turns} scope={scope} onScope={onScope} />
          <button type="button" aria-label="Close diff" title="Close diff" onClick={onClose}
            className="grid h-8 w-8 flex-none cursor-pointer place-items-center rounded-full border border-line bg-transparent text-muted hover:bg-surface-2 hover:text-text">
            <Icon icon={Cancel01Icon} size={14} />
          </button>
        </div>
      </div>

      {goal === undefined ? <div /> : <WaitingBar goal={goal} actions={actions} excluded={sessionScope ? files.filter((file) => file.excluded === true).length : 0} />}

      <div className="relative min-h-0 min-w-0">
        <div
          ref={scroller}
          tabIndex={0}
          role="region"
          aria-label="Changed files"
          onScroll={locate}
          // No top padding on the scroller itself: a sticky file header sticks to the
          // scroller's padding edge, and lines scrolling under it would show through
          // the gap above it. The list carries the space instead.
          className="h-full min-h-0 overflow-y-auto px-3 pb-6 pr-4 outline-none"
        >
          <div className="pt-3">
            {partial ? (
              <p className="m-0 mb-3 rounded-lg bg-[color-mix(in_srgb,var(--color-warn)_10%,transparent)] px-3 py-2 text-label text-warn">
                Some changes are not shown.
              </p>
            ) : null}
            {hidden > 0 ? (
              <p className="m-0 mb-3 text-label text-dim">
                {hidden} {hidden === 1 ? 'file changes' : 'files change'} only whitespace and {hidden === 1 ? 'is' : 'are'} hidden.
              </p>
            ) : null}
            {error !== undefined ? (
              <div className="flex flex-col items-start gap-2 py-6">
                <p role="alert" className="m-0 text-label text-danger">{error}</p>
                {sessionScope ? <Button size="compact" variant="secondary" onClick={() => onRead(ignoreWhitespace)}>Try again</Button> : null}
              </div>
            ) : loading || (!answered && files.length === 0 && sessionScope && hasSession) ? (
              <p className="m-0 py-6 text-label text-dim">Reading the diff…</p>
            ) : files.length === 0 ? (
              <p className="m-0 py-6 text-label text-dim">
                {sessionScope ? (hasSession ? 'No changes yet.' : 'No linked git folder to diff.') : 'This turn changed no lines.'}
              </p>
            ) : (
              <div className="flex flex-col gap-3">
                {files.map((file, index) => (
                  <Fragment key={file.key}>
                    {/* The Session's other changes follow the result, under their own heading. */}
                    {file.excluded === true && files[index - 1]?.excluded !== true ? (
                      <h3 title="Confirm leaves these out. Request changes brings them into a new version."
                        className="m-0 mt-2 text-label font-normal text-dim">
                        Not included
                      </h3>
                    ) : null}
                    <DiffFileCard
                      file={file}
                      layout={layout}
                      collapsed={collapsed.has(file.key)}
                      scrollRoot={scroller}
                      onToggle={toggle}
                      cardRef={cardRef}
                      {...(onOpenFile === undefined ? {} : { onOpenFile })}
                      {...(onReference === undefined ? {} : { onReference })}
                      onCopyPath={copyPath}
                    />
                  </Fragment>
                ))}
              </div>
            )}
          </div>
        </div>
        <MarkerStrip files={files} collapsed={collapsed} cards={cards} scroller={scroller} onJump={jump} />
      </div>
    </aside>
  )
}

/** The bar's pills: a rounded outline that reads as one control. */
const PILL = 'flex h-8 cursor-pointer items-center gap-2 rounded-full border border-line px-2.5 text-label'
const PILL_ON = 'bg-surface-2 text-text'
const PILL_OFF = 'bg-transparent text-muted hover:bg-surface-2 hover:text-text'
/** A pill's word, kept for screen readers once the bar is too narrow to show it. */
const BAR_WORD = '@max-[30rem]:sr-only'
/** Narrower still the tools wrap under Whole Session, which then has its row to itself. */
const ALONE_WORD = '@max-[22rem]:not-sr-only'

function Totals({ files, added, removed }: { files: number; added: number; removed: number }) {
  return (
    <span className="flex flex-none items-center gap-1.5 tabular-nums">
      <span className="text-dim">{files}</span>
      <span className="text-ok">+{added}</span>
      <span className="text-danger">−{removed}</span>
    </span>
  )
}

function ToolButton({ label, disabled = false, onClick, pressed, children }: { label: string; disabled?: boolean; onClick: (event: React.MouseEvent<HTMLButtonElement>) => void; pressed?: boolean; children: ReactNode }) {
  return (
    <button type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}
      {...(pressed === undefined ? {} : { 'aria-expanded': pressed, 'aria-haspopup': 'menu' as const })}
      className={`grid h-6 w-6 flex-none cursor-pointer place-items-center rounded-full border-0 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent ${
        pressed === true ? 'bg-surface-2 text-text' : 'bg-transparent text-muted hover:bg-surface-2 hover:text-text'}`}>
      {children}
    </button>
  )
}

/** View, whitespace and folding, in one menu. */
function OptionsButton({ items }: { items: ContextMenuItem[] }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  return (
    <>
      <ToolButton label="Diff view options" pressed={menu !== null}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          setMenu((open) => open === null ? { x: rect.right - 200, y: rect.bottom + 6 } : null)
        }}>
        <Icon icon={MoreHorizontalIcon} size={14} />
      </ToolButton>
      {menu === null ? null : <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
    </>
  )
}

/**
 * Turns: which turn's own diff to read, newest first. Shows the turn and its totals
 * while one is open; the Whole Session pill is the way back.
 */
function TurnsPill({ turns, scope, onScope }: {
  turns: readonly DiffTurn[]
  scope: DiffScope
  onScope: (scope: DiffScope) => void
}) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const selected = scope.kind === 'turn' ? turns.find((turn) => turn.turnId === scope.turnId) : undefined
  const label = scope.kind === 'session' ? 'Turns' : selected === undefined ? 'One turn' : turnName(selected)
  return (
    <>
      <button type="button" aria-haspopup="menu" aria-expanded={menu !== null} aria-label={`Choose turn diff: ${label}`} title={label}
        disabled={turns.length === 0}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect()
          setMenu((open) => open === null ? { x: rect.right - 240, y: rect.bottom + 6 } : null)
        }}
        className={`${PILL} max-w-[9.5rem] min-w-0 shrink disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent ${scope.kind === 'turn' ? PILL_ON : PILL_OFF}`}>
        <Icon icon={PlusMinusIcon} size={14} className="flex-none" />
        <span className={`min-w-0 truncate ${scope.kind === 'session' ? BAR_WORD : ''}`}>{label}</span>
        <Icon icon={ArrowDown01Icon} size={12} className="flex-none" />
      </button>
      {menu === null ? null : (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}
          items={turns.map((turn, index) => ({
            label: index === 0 ? turnName(turn, 'Last turn') : turnName(turn),
            checked: scope.kind === 'turn' && scope.turnId === turn.turnId,
            onSelect: () => onScope({ kind: 'turn', turnId: turn.turnId }),
          }))} />
      )}
    </>
  )
}

/**
 * While a result waits: the same Confirm and Request changes its card in the briefing
 * chat offers, on their own line under the bar. Request changes is shared with the
 * Session's Ready row above the composer, which opens this field from there.
 */
function WaitingBar({ goal, actions, excluded }: { goal: WaitingGoal; actions: WorkResultActions; excluded: number }) {
  const request = useRequest(actions.requestEvents)
  const handoffId = goal.handoffId
  const readWriting = () => readWorkChangesOpen(handoffId)
  const writing = useSyncExternalStore(subscribeWorkProposals, readWriting, readWriting)
  const setWriting = (open: boolean) => setWorkChangesOpen(handoffId, open)
  const [error, setError] = useState<string | null>(null)
  const { pending, cancel } = request
  const labels = workResultActionLabels({ operation: goal.operation ?? 'commit' })
  const confirmWait = useConfirmWait(handoffId, goal)
  const confirmTitle = confirmWait ?? goal.confirmTitle
  useEffect(() => {
    if (!actions.connected && pending) {
      cancel()
      setError(SESSION_CONNECTION_LOST)
    }
    if (actions.connected) setError((current) => current === SESSION_CONNECTION_LOST ? null : current)
  }, [actions.connected, pending, cancel])
  const confirm = () => {
    setError(null)
    request.start((requestId) => actions.accept(goal.handoffId, goal.mergeInto, goal.version, requestId), { onNotice: (notice) => setError(notice.text) })
  }
  const send = (text: string) => {
    setError(null)
    request.start((requestId) => sendWorkChanges(actions.requestEvents, handoffId, text, requestId,
      () => actions.revise(goal.handoffId, goal.version, text, requestId)), {
      onNotice: (notice) => setError(notice.text),
    })
  }
  return (
    <div className="flex min-w-0 flex-col border-b border-line">
      {writing ? null : (
        <div className="flex min-h-11 min-w-0 flex-wrap items-center gap-2 px-3.5 py-1.5">
          <span className="flex min-w-0 flex-1 items-baseline gap-2 text-label">
            <span className="text-warn">Ready</span>
            {excluded === 0 ? null : <span className="text-dim">{excluded} {excluded === 1 ? 'file' : 'files'} not included</span>}
          </span>
          <Button size="compact" variant="ghost" className="flex-none" disabled={pending || !actions.connected}
            onClick={() => {
              setError(null)
              setWriting(true)
            }}>
            {labels.secondary}
          </Button>
          <Button size="compact" variant="primary" className="flex-none" disabled={pending || !actions.connected || confirmWait !== undefined} onClick={confirm}
            {...(confirmTitle === undefined ? {} : { title: confirmTitle })}>
            {pending ? labels.pending : labels.primary}
          </Button>
        </div>
      )}
      {writing ? (
        <div className="px-3 pt-3 pb-3">
          <WorkChangesField
            handoffId={handoffId}
            pending={pending}
            connected={actions.connected}
            autoFocus
            onCancel={() => setWriting(false)}
            onSend={send}
          />
        </div>
      ) : null}
      {error === null ? null : <p role="alert" className="m-0 px-3.5 pb-2 text-label text-danger">{error}</p>}
    </div>
  )
}

/**
 * A mark per run of changed lines along the pane's edge, at the height it sits in the
 * list, in the colour of what it does: added, removed, or both. A collapsed file is
 * one mark. A pointer shortcut; the file menu and ⌥↑/⌥↓ are the keyboard's way.
 */
function MarkerStrip({ files, collapsed, cards, scroller, onJump }: {
  files: readonly DiffViewFile[]
  collapsed: ReadonlySet<string>
  cards: { current: Map<string, HTMLElement> }
  scroller: { current: HTMLDivElement | null }
  onJump: (key: string) => void
}) {
  const [marks, setMarks] = useState<{ id: string; key: string; path: string; top: number; height: number; tone: ChangeRun['tone'] }[]>([])
  useEffect(() => {
    const pane = scroller.current
    if (pane === null || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      const total = pane.scrollHeight
      if (total <= 0) return
      const base = pane.getBoundingClientRect().top - pane.scrollTop
      setMarks(files.flatMap((file) => {
        const card = cards.current.get(file.key)
        if (card === undefined) return []
        const box = card.getBoundingClientRect()
        const top = box.top - base
        const tone: ChangeRun['tone'] = file.added > 0 && file.removed > 0 ? 'both' : file.removed > 0 ? 'removed' : 'added'
        const runs = changeRuns(file.rows)
        if (collapsed.has(file.key) || runs.length === 0) return [{ id: file.key, key: file.key, path: file.path, top: top / total, height: 0, tone }]
        const header = card.firstElementChild?.getBoundingClientRect().height ?? 0
        const body = box.height - header
        return runs.map((run) => ({
          id: `${file.key}:${run.start}`, key: file.key, path: file.path, tone: run.tone,
          top: (top + header + (body * run.start) / file.rows.length) / total,
          height: (body * run.length) / file.rows.length / total,
        }))
      }))
    }
    const observer = new ResizeObserver(measure)
    for (const child of Array.from(pane.children)) observer.observe(child)
    observer.observe(pane)
    measure()
    return () => observer.disconnect()
  }, [files, collapsed, cards, scroller])
  if (files.length === 0) return null
  return (
    <div role="group" aria-label="Change markers" className="pointer-events-none absolute top-0 right-1 bottom-0 w-1.5">
      {marks.map((mark) => (
        <div
          key={mark.id}
          aria-hidden
          title={mark.path}
          onClick={() => onJump(mark.key)}
          className={`pointer-events-auto absolute right-0 w-1.5 min-h-[3px] cursor-pointer rounded-full opacity-70 hover:opacity-100 ${mark.tone === 'added' ? 'bg-ok' : mark.tone === 'removed' ? 'bg-danger' : 'bg-muted'}`}
          style={{ top: `${Math.min(99.5, mark.top * 100)}%`, height: `${mark.height * 100}%` }}
        />
      ))}
    </div>
  )
}

function readLayout(): DiffLayout {
  try {
    return window.localStorage.getItem(LAYOUT_KEY) === 'split' ? 'split' : 'stacked'
  } catch {
    return 'stacked'
  }
}

function writeLayout(layout: DiffLayout) {
  try {
    window.localStorage.setItem(LAYOUT_KEY, layout)
  } catch {
    // The choice still holds while the pane is open.
  }
}
