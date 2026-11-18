import { ArrowLeft01Icon, BubbleChatIcon, Cancel01Icon, CheckmarkSquare02Icon, File01Icon, RefreshIcon, SquareIcon } from '@hugeicons/core-free-icons'
import { NOTE_MARKER, type ContextFile, type ProjectMemoryScope, type ServerMessage } from '@manor/contracts'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Fragment, useEffect, useMemo, useState, type ComponentPropsWithoutRef, type CSSProperties, type ReactNode } from 'react'
import type { Components } from 'react-markdown'
import { messageTime } from '../messageMeta'
import { INSTANT, LINE_REVEAL, LINE_REVEAL_FROM, LINE_REVEAL_REST, LINE_SETTLE_OUT } from '../motion'
import { fileLines, lineKeys, type FileLine } from '../projectFileLines'
import type { RequestEvents } from '../useRequest'
import type { ConnectionStatus } from '../useWorkspace'
import { ChatSummaryView, useChatSummary } from './AgentMemory'
import { ExternalLink } from './ExternalLink'
import { Icon } from './Icon'
import { Markdown } from './Markdown'
import { Button } from './ui/Button'
import { DOCK_FLOAT, DOCK_PANEL_GAP, DOCK_PANEL_SHELL, useMovedWithin } from './ui/dockPanel'
import { IconButton } from './ui/IconButton'

type Memory = Extract<ServerMessage, { type: 'project_memory' }>
type MemoryFile = Memory['files'][number]
/** A project thread's own two files lead the Project folder (2026-10-10). */
const THREAD_FILE_NAMES = new Set(['preferences.md', 'notes.md'])
/** A User folder file is keyed apart from project paths so the detail view can tell them apart. */
const USER_KEY = 'user:'
/** The project thread's own conversation summary, opened like a file but from the chat. */
const SUMMARY_KEY = 'summary:'
const SUMMARY_TITLE = 'Conversation summary'
type LoadState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ready'; memory: Memory }
const EMPTY_PATHS: ReadonlySet<string> = new Set()

/** The index already owns the short human title, so the rail needs no generated summary. */
export function projectMemoryTitles(files: readonly MemoryFile[]): Map<string, string> {
  const index = files.find((file) => file.kind === 'index')
  if (index === undefined) return new Map()
  const titles = new Map<string, string>()
  for (const row of index.content.split('\n')) {
    const link = row.match(/^\s*-\s+\[([^\]]+)\]\(([^)]+\.md)\)/)
    if (link?.[1] !== undefined && link[2] !== undefined) titles.set(link[2].split('/').pop()!, link[1])
  }
  return titles
}

const fileName = (path: string): string => path.split('/').pop() ?? path

const fallbackTitle = (path: string): string =>
  fileName(path)
    .replace(/\.md$/i, '')
    .replace(/^(project|reference)_[^_]+_/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/^./, (letter) => letter.toUpperCase())

/**
 * Frontmatter and the server's Notes source markers route the file for agents; the
 * user-facing detail starts at the memory itself.
 */
export const projectMemoryBody = (content: string): string =>
  content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim().split(/\r?\n/).map((line) => line.replace(NOTE_MARKER, '')).join('\n')

interface Props {
  projectId: string
  status: ConnectionStatus
  requestEvents: RequestEvents
  onLoad: (projectId: string, requestId: string) => boolean
  onClose: () => void
  width: number
  resizing: boolean
  resizeProps: ComponentPropsWithoutRef<'div'>
  /** Structured files injected for the latest finished turn. */
  usedPaths?: ReadonlySet<string>
  /** The global standing files, read-only here: the User folder. */
  userFiles?: readonly ContextFile[]
  /** Reads them from disk when the panel opens. */
  onLoadUserFiles?: () => void
  memoryScope?: ProjectMemoryScope
  /**
   * A project thread rolls over like a DM, so its panel also shows the summary a
   * fresh session is seeded from. Absent for every other project chat.
   */
  summaryChatId?: string
  onLoadSummary?: (chatId: string, requestId: string) => boolean
  /** Opens the Session a notes.md row belongs to. */
  onOpenSession?: (chatId: string) => void
  /** Changes when the project thread writes or undoes a line, so the open panel reloads and shows it. */
  refreshKey?: string
  overlay?: boolean
  revealed?: boolean
  phone?: boolean
}

export function ProjectMemoryPanel({
  projectId,
  status,
  requestEvents,
  onLoad,
  onClose,
  width,
  resizing,
  resizeProps,
  usedPaths = EMPTY_PATHS,
  userFiles = [],
  onLoadUserFiles,
  memoryScope = 'project',
  summaryChatId,
  onLoadSummary,
  onOpenSession,
  refreshKey,
  overlay = false,
  revealed = true,
  phone = false,
}: Props) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [revision, setRevision] = useState(0)
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const withSummary = summaryChatId !== undefined && onLoadSummary !== undefined
  const summaryState = useChatSummary(
    withSummary ? summaryChatId : undefined, status, requestEvents, onLoadSummary, revision, 'the conversation summary',
  )
  const summary = summaryState.kind === 'ready' ? summaryState.summary : null

  useEffect(() => {
    if (status !== 'live') {
      setState({ kind: 'error', message: 'Connect to Manor to load project memory.' })
      return
    }
    // A reload keeps what is on screen, so the lines that stayed stay mounted and only
    // what the thread changed moves.
    setState((current) => current.kind === 'ready' ? current : { kind: 'loading' })
    const requestId = crypto.randomUUID()
    const timer = window.setTimeout(() => setState({ kind: 'error', message: 'Loading project memory took too long. Try again.' }), 15_000)
    const unsubscribe = requestEvents.subscribe((response) => {
      if (response.requestId !== requestId) return
      if (response.type === 'project_memory' && response.projectId === projectId) {
        window.clearTimeout(timer)
        setState({ kind: 'ready', memory: response })
      } else if (response.type === 'notice') {
        window.clearTimeout(timer)
        setState({ kind: 'error', message: response.text })
      }
    })
    if (!onLoad(projectId, requestId)) {
      window.clearTimeout(timer)
      setState({ kind: 'error', message: 'Could not load project memory. Try again.' })
    }
    return () => { window.clearTimeout(timer); unsubscribe() }
  }, [projectId, status, requestEvents, onLoad, revision, refreshKey])

  useEffect(() => {
    if (status === 'live') onLoadUserFiles?.()
  }, [status, onLoadUserFiles, revision])

  const memory = state.kind === 'ready' ? state.memory : null
  const knowledge = memoryScope === 'knowledge'
  const scopeLabel = knowledge ? 'Knowledge work memory' : 'Context'
  const projectFiles = useMemo(() => memory?.files.filter((file) => file.kind === 'file') ?? [], [memory])
  // The User folder reads like the project files, so one detail view serves both.
  const userAsFiles = useMemo<MemoryFile[]>(() => knowledge ? [] : userFiles.map((file) => ({
    path: `${USER_KEY}${file.name}`, kind: 'file', modifiedAt: Date.parse(file.updatedAt) || 0, content: file.content,
  })), [knowledge, userFiles])
  const files = useMemo(() => [...projectFiles, ...userAsFiles], [projectFiles, userAsFiles])
  const listedByPath = useMemo(() => new Map(projectFiles.map((file) => [file.path, file])), [projectFiles])
  const orderedFiles = useMemo(() => [...projectFiles].sort((left, right) => {
    const thread = Number(THREAD_FILE_NAMES.has(fileName(right.path))) - Number(THREAD_FILE_NAMES.has(fileName(left.path)))
    const used = Number(usedPaths.has(right.path)) - Number(usedPaths.has(left.path))
    return thread || used || right.modifiedAt - left.modifiedAt
  }), [projectFiles, usedPaths])
  const listItems = useMemo(() => {
    if (!knowledge) return orderedFiles.map((file) => ({ file, listed: true as const }))
    return [...usedPaths].map((path) => {
      const file = listedByPath.get(path)
      return file === undefined
        ? { file: { path, kind: 'file' as const, modifiedAt: 0, content: '' }, listed: false as const }
        : { file, listed: true as const }
    })
  }, [knowledge, listedByPath, orderedFiles, usedPaths])
  const titles = useMemo(() => projectMemoryTitles(memory?.files ?? []), [memory])
  const selected = files.find((file) => file.path === selectedPath) ?? null
  // The detail stays open only while there is a summary to read in it.
  const summaryOpen = withSummary && selectedPath === SUMMARY_KEY && summary !== null
  const title = summaryOpen ? SUMMARY_TITLE : selected === null ? null : selected.path.startsWith(USER_KEY)
    ? selected.path.slice(USER_KEY.length)
    : (titles.get(fileName(selected.path)) ?? fallbackTitle(selected.path))
  const detailKey = summaryOpen ? SUMMARY_KEY : selected?.path ?? 'list'
  const selectedBody = selected === null ? '' : projectMemoryBody(selected.content)
  // The thread's notes.md reads as rows: their ages live on the server, not in the file.
  const threadFile = selected !== null && !selected.path.startsWith(USER_KEY) && THREAD_FILE_NAMES.has(fileName(selected.path))
  const noteRows = threadFile && fileName(selected.path) === 'notes.md' ? memory?.noteRows : undefined
  const lines = useMemo(() => threadFile ? fileLines(selectedBody) : undefined, [threadFile, selectedBody])
  const memoryLinks = useMemo<Components>(() => ({
    a: ({ href, children }) => {
      if (href !== undefined && /^https?:\/\//i.test(href)) return <ExternalLink href={href}>{children}</ExternalLink>
      // Only loaded sibling cards can open here; User files have a separate scope.
      const sibling = href?.match(/^(?:\.\/)?([^/\\:?#]+\.md)$/i)?.[1]
      const path = selected === null || selected.path.startsWith(USER_KEY) || sibling === undefined
        ? undefined
        : `${selected.path.slice(0, selected.path.lastIndexOf('/') + 1)}${sibling}`
      if (path === undefined || !listedByPath.has(path)) return <span>{children}</span>
      return (
        <button
          type="button"
          className="inline cursor-pointer text-left text-[var(--accent-fg)] underline underline-offset-2 hover:no-underline"
          onClick={() => setSelectedPath(path)}
        >
          {children}
        </button>
      )
    },
  }), [selected, listedByPath])

  const movedWithin = useMovedWithin(detailKey)
  return (
    <aside
      aria-label={scopeLabel}
      className={`${phone ? 'absolute inset-0 z-[8]' : `${overlay ? `dock-panel-reveal ${DOCK_FLOAT} max-w-[calc(100%-16px)]` : 'relative'} my-2 mr-2`} flex min-h-0 flex-col ${DOCK_PANEL_SHELL}`}
      data-open={overlay && !phone ? revealed : undefined}
      style={{
        width: phone ? '100%' : `calc(var(--memory-width) - ${DOCK_PANEL_GAP}px)`,
        '--memory-width': `${width}px`,
      } as CSSProperties}
    >
      {phone ? null : (
        <div
          {...resizeProps}
          className="group absolute inset-y-0 left-0 z-30 w-2 touch-none cursor-col-resize outline-none max-[760px]:hidden"
        >
          <span
            className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 ${
              resizing
                ? 'bg-primary'
                : 'bg-transparent group-hover:bg-muted group-focus-visible:bg-primary group-active:bg-primary'
            }`}
          />
        </div>
      )}
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line pr-2 pl-3.5">
        {selected === null && !summaryOpen ? (
          <h2 className="m-0 flex-1 truncate text-label font-medium text-muted">{scopeLabel}</h2>
        ) : (
          <button
            type="button"
            aria-label={`Back to ${scopeLabel.toLowerCase()}`}
            className="-ml-1.5 flex min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-button border-0 bg-transparent px-1.5 py-1 [font-family:inherit] text-label font-medium text-muted hover:text-text"
            onClick={() => setSelectedPath(null)}
          >
            <Icon icon={ArrowLeft01Icon} size={15} className="flex-none" />
            <span className="truncate">{title}</span>
          </button>
        )}
        {!knowledge && selected !== null && usedPaths.has(selected.path) ? <SelectedBadge /> : null}
        {selected === null && !summaryOpen && state.kind === 'ready' ? (
          <IconButton icon={RefreshIcon} label={`Refresh ${scopeLabel.toLowerCase()}`} onClick={() => setRevision((value) => value + 1)} />
        ) : null}
        <IconButton icon={Cancel01Icon} label={`Close ${scopeLabel.toLowerCase()}`} onClick={onClose} />
      </div>

      <div
        key={detailKey}
        className={`min-h-0 flex-1 overflow-y-auto ${!movedWithin ? '' : detailKey === 'list' ? 'panel-enter-back' : 'panel-enter-forward'}`}
      >
        {summaryOpen && summary !== null ? (
          <div className="text-label text-text"><ChatSummaryView summary={summary} /></div>
        ) : selected === null ? (
          <div className="p-2.5 text-label text-text">
            {withSummary ? (
              <>
                <h3 className="m-0 px-2.5 pt-1 pb-1.5 text-meta font-medium text-dim">Conversation</h3>
                <SummaryRow load={summaryState} onOpen={() => setSelectedPath(SUMMARY_KEY)} />
              </>
            ) : null}
            {!knowledge && state.kind === 'loading' ? <p role="status" className="px-2 text-dim">Loading project memory…</p> : null}
            {state.kind === 'error' ? (
              <div role="alert" className="px-2">
                <p>{state.message}</p>
                <Button variant="secondary" size="compact" onClick={() => setRevision((value) => value + 1)}>Retry</Button>
              </div>
            ) : null}
            {!knowledge && memory !== null && files.length === 0 ? (
              <p className="px-2 text-dim">{memory.truncated ? 'No project memory files could be loaded.' : 'No project memories saved yet.'}</p>
            ) : null}
            {knowledge && usedPaths.size === 0 && state.kind !== 'error' ? (
              <p className="px-2 text-dim">No memories selected this turn.</p>
            ) : null}
            {!knowledge && memory?.truncated && files.length > 0 ? <p role="status" className="px-2 text-muted">Some memories could not be included.</p> : null}
            {knowledge ? null : <h3 className={`m-0 px-2.5 ${withSummary ? 'pt-4' : 'pt-1'} pb-1.5 text-meta font-medium text-dim`}>Project folder</h3>}
            <ol className="m-0 list-none p-0">
              {listItems.map(({ file, listed }, index) => {
                const used = usedPaths.has(file.path)
                const followsUsed = !knowledge && index > 0 && usedPaths.has(listItems[index - 1]!.file.path) && !used
                const rowClass = `flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left [font:inherit] ${used ? 'text-text' : 'text-muted'}`
                const rowTitle = `${file.path}${!knowledge && used ? ', Selected this turn' : ''}`
                const label = titles.get(fileName(file.path)) ?? fallbackTitle(file.path)
                const body = (
                  <>
                    <Icon
                      icon={File01Icon}
                      size={16}
                      className={`flex-none ${used ? 'text-[var(--accent-fg)]' : 'text-dim'}`}
                    />
                    <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
                    {!knowledge && used ? <SelectedBadge /> : null}
                    {!knowledge && !used ? (
                      <time className="flex-none text-meta text-dim" dateTime={new Date(file.modifiedAt).toISOString()}>
                        {messageTime(file.modifiedAt, Date.now())}
                      </time>
                    ) : null}
                  </>
                )
                return (
                  <Fragment key={file.path}>
                    {followsUsed ? <li role="separator" className="mx-2 my-2 border-t border-line" /> : null}
                    <li>
                      {listed ? (
                        <button
                          type="button"
                          className={`${rowClass} cursor-pointer border-0 bg-transparent hover:bg-tree-hover hover:text-text`}
                          title={rowTitle}
                          onClick={() => setSelectedPath(file.path)}
                        >
                          {body}
                        </button>
                      ) : (
                        <div className={rowClass} title={rowTitle}>{body}</div>
                      )}
                    </li>
                  </Fragment>
                )
              })}
            </ol>
            {userAsFiles.length === 0 ? null : (
              <>
                <h3 className="m-0 px-2.5 pt-4 pb-1.5 text-meta font-medium text-dim">User folder</h3>
                <ol className="m-0 list-none p-0">
                  {userAsFiles.map((file) => (
                    <li key={file.path}>
                      <button
                        type="button"
                        className="flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg border-0 bg-transparent px-2.5 py-1.5 text-left text-muted [font:inherit] hover:bg-tree-hover hover:text-text"
                        title={`${file.path.slice(USER_KEY.length)}, read-only`}
                        onClick={() => setSelectedPath(file.path)}
                      >
                        <Icon icon={File01Icon} size={16} className="flex-none text-dim" />
                        <span className="min-w-0 flex-1 truncate font-medium">{file.path.slice(USER_KEY.length)}</span>
                        <span className="flex-none text-meta text-dim">Read-only</span>
                      </button>
                    </li>
                  ))}
                </ol>
              </>
            )}
          </div>
        ) : (
          <article className="px-5 py-5 text-label leading-[1.6] text-text">
            {noteRows === undefined && /^#\s/.test(selectedBody) ? null : (
              <h1 className="mt-0 mb-2 text-[16px] leading-snug font-medium tracking-[-0.01em] text-text">{title}</h1>
            )}
            {noteRows !== undefined
              ? <NoteRows rows={noteRows} onOpenSession={onOpenSession} />
              : lines !== undefined
                ? <FileLines lines={lines} components={memoryLinks} />
                : <Markdown text={selectedBody} variant="panel" components={memoryLinks} />}
          </article>
        )}
      </div>
    </aside>
  )
}

/** The thread's one summary row: opens the summary, or says why there is none to open. */
function SummaryRow({ load, onOpen }: { load: ReturnType<typeof useChatSummary>; onOpen: () => void }) {
  const rowClass = 'flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left [font:inherit]'
  if (load.kind !== 'ready' || load.summary === null) {
    const note = load.kind === 'loading' ? 'Loading…' : load.kind === 'error' ? load.message : 'Not summarized yet'
    return (
      <div className={`${rowClass} text-muted`} {...(load.kind === 'loading' ? { role: 'status' } : load.kind === 'error' ? { role: 'alert' } : {})}>
        <Icon icon={BubbleChatIcon} size={16} className="flex-none text-dim" />
        <span className="min-w-0 flex-1 truncate font-medium">{SUMMARY_TITLE}</span>
        <span className="min-w-0 flex-none truncate text-meta text-dim" title={note}>{note}</span>
      </div>
    )
  }
  const { summary } = load
  return (
    <button
      type="button"
      className={`${rowClass} cursor-pointer border-0 bg-transparent text-muted hover:bg-tree-hover hover:text-text`}
      title={`${SUMMARY_TITLE}, read-only`}
      onClick={onOpen}
    >
      <Icon icon={BubbleChatIcon} size={16} className="flex-none text-dim" />
      <span className="min-w-0 flex-1 truncate font-medium">{SUMMARY_TITLE}</span>
      <time className="flex-none text-meta text-dim" dateTime={new Date(summary.updatedAt).toISOString()}>
        {messageTime(summary.updatedAt, Date.now())}
      </time>
    </button>
  )
}

function SelectedBadge() {
  return (
    <span
      className="flex-none rounded-chip bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] px-1.5 py-0.5 text-meta font-medium text-[var(--accent-fg)]"
      title="Selected this turn"
    >
      This turn
    </span>
  )
}

/**
 * A project thread's notes.md as rows: the box, the text, the Session that owns the row
 * and how long an open row has stood. A done row fades until Manor archives it.
 */
function NoteRows({ rows, onOpenSession }: { rows: NonNullable<Memory['noteRows']>; onOpenSession?: ((chatId: string) => void) | undefined }) {
  // Two Sessions can share a status text, so a row is its Session and its text.
  const keys = lineKeys(rows.map((row) => `${row.session?.chatId ?? ''} ${row.text}`))
  return (
    // Rows pad below instead of a gap, so a row folding in or out carries its own spacing.
    // The list stays mounted when empty, so the last row still slides away above the empty text.
    <>
      <ol aria-label="Notes" className={`m-0 list-none p-0 ${rows.length === 0 ? '' : '-mb-3'}`}>
        <AnimatePresence initial={false}>
          {rows.map((row, index) => (
            <WrittenLine key={keys[index]} as="li">
              <div className={`flex min-w-0 items-start gap-2 pb-3 ${row.done === true ? 'opacity-50' : ''}`}>
                {row.done === undefined ? <span className="w-[15px] flex-none" /> : (
                  <Icon
                    icon={row.done ? CheckmarkSquare02Icon : SquareIcon}
                    size={15}
                    className="mt-[3px] flex-none text-dim"
                    {...{ role: 'img', 'aria-label': row.done ? 'Done' : 'Open' }}
                  />
                )}
                <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
                  <span className={`[overflow-wrap:anywhere] ${row.done === true ? 'line-through decoration-dim' : ''}`}>{row.text}</span>
                  {row.session === undefined && row.age === undefined ? null : (
                    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                      {row.session === undefined ? null : onOpenSession === undefined ? (
                        <span className="max-w-full truncate rounded-chip border border-line px-1.5 py-0.5 text-meta text-muted">{row.session.title}</span>
                      ) : (
                        <button
                          type="button"
                          title={`Open the Session ${row.session.title}`}
                          className="max-w-full cursor-pointer truncate rounded-chip border border-line bg-transparent px-1.5 py-0.5 text-meta text-muted [font-family:inherit] hover:border-dim hover:text-text"
                          onClick={() => onOpenSession(row.session!.chatId)}
                        >
                          {row.session.title}
                        </button>
                      )}
                      {row.age === undefined ? null : <span className="whitespace-nowrap rounded-chip bg-raised px-1.5 py-0.5 text-meta text-dim">{row.age}</span>}
                    </span>
                  )}
                </div>
              </div>
            </WrittenLine>
          ))}
        </AnimatePresence>
      </ol>
      {rows.length === 0 ? <p className="m-0 text-dim">No notes yet.</p> : null}
    </>
  )
}

/**
 * preferences.md, or a notes.md without parsed rows, drawn line by line so a line the
 * thread adds rises in and a line it removes slides away. Each line is its own small
 * document, so a bullet still wears its bullet.
 */
function FileLines({ lines, components }: { lines: readonly FileLine[]; components: Components }) {
  return (
    <AnimatePresence initial={false}>
      {lines.map((line) => (
        <WrittenLine key={line.key}>
          <div className={line.item ? 'pb-1' : 'pb-[0.75em]'}>
            <Markdown text={line.text} variant="panel" components={components} />
          </div>
        </WrittenLine>
      ))}
    </AnimatePresence>
  )
}

/**
 * One line of a thread file. Mounted inside `AnimatePresence initial={false}`, so the
 * lines a panel opens with stand still and only a line written while it is open moves.
 */
function WrittenLine({ as = 'div', children }: { as?: 'div' | 'li'; children: ReactNode }) {
  const reduce = useReducedMotion() ?? false
  const Line = as === 'li' ? motion.li : motion.div
  return (
    <Line
      className="min-w-0 overflow-hidden"
      initial={reduce ? false : LINE_REVEAL_FROM}
      animate={LINE_REVEAL_REST}
      exit={reduce ? { opacity: 0, transition: INSTANT } : LINE_SETTLE_OUT}
      transition={reduce ? INSTANT : LINE_REVEAL}
    >
      {children}
    </Line>
  )
}
