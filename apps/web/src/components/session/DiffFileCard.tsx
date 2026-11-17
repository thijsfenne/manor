import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { ArrowDown01Icon, AtIcon, Copy01Icon, File01Icon, MoreHorizontalIcon } from '@hugeicons/core-free-icons'
import { splitPath, splitRows, type DiffViewFile, type DiffViewRow } from '../../diffView'
import { FileMark } from '../fileMark'
import { Markdown } from '../Markdown'
import { Icon } from '../Icon'
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu'
import { SegmentedControl, type SegmentOption } from '../ui/SegmentedControl'
import { sourceLanguage } from '@manor/client-runtime/languages'
import { highlightLines, type SyntaxSpan } from '../ui/sourceSyntax'

export type DiffLayout = 'stacked' | 'split'

/** One rendered line: the height a placeholder reserves before its body is drawn. */
const ROW_PX = 18
/** How far outside the view a body is drawn ahead of the scroll. */
const AHEAD = '1600px 0px'

const ADDED = 'bg-[color-mix(in_srgb,var(--color-ok)_14%,transparent)]'
const REMOVED = 'bg-[color-mix(in_srgb,var(--color-danger)_14%,transparent)]'
/** The edge mark of a changed line: solid for an addition, dashed for a removal. */
const ADDED_EDGE = 'bg-ok'
const REMOVED_EDGE = 'bg-[repeating-linear-gradient(to_bottom,var(--color-danger)_0_3px,transparent_3px_5px)]'

/** Files read as prose: their change is shown as text first and as source second. */
const isProse = (path: string) => /\.(md|markdown|txt)$/i.test(path)

type ProseView = 'text' | 'source'

const textViewOptions = (id: string): readonly SegmentOption<ProseView>[] => [
  { value: 'text', label: 'Text', tabId: `${id}-text`, panelId: `${id}-body` },
  { value: 'source', label: 'Source', tabId: `${id}-source`, panelId: `${id}-body` },
]

interface DiffFileCardProps {
  file: DiffViewFile
  layout: DiffLayout
  collapsed: boolean
  /** The pane's scroller: bodies are drawn once they come near it. */
  scrollRoot: RefObject<HTMLElement>
  onToggle: (key: string) => void
  /** Registers the card for the marker strip and previous and next file. */
  cardRef: (key: string, element: HTMLElement | null) => void
  onOpenFile?: (panelPath: string) => void
  onReference?: (panelPath: string) => void
  onCopyPath: (path: string) => void
}

/**
 * One file of a diff: a header that stays at the top while its lines scroll under it,
 * and the lines themselves, drawn only once the card comes near the view so a diff of
 * a thousand files opens as fast as one of ten.
 */
export const DiffFileCard = memo(function DiffFileCard({
  file, layout, collapsed, scrollRoot, onToggle, cardRef, onOpenFile, onReference, onCopyPath,
}: DiffFileCardProps) {
  const { name, folder } = splitPath(file.path)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const items: ContextMenuItem[] = [
    ...(file.panelPath !== undefined && onOpenFile !== undefined && file.status !== 'deleted'
      ? [{ label: 'Open in files panel', icon: File01Icon, onSelect: () => onOpenFile(file.panelPath!) }] : []),
    ...(file.panelPath !== undefined && onReference !== undefined
      ? [{ label: 'Reference in chat', icon: AtIcon, onSelect: () => onReference(file.panelPath!) }] : []),
    { label: 'Copy path', icon: Copy01Icon, onSelect: () => onCopyPath(file.path) },
  ]
  const headingId = `diff-file-${file.key.replace(/[^A-Za-z0-9_-]/g, '-')}`
  // Per card and not remembered: a prose file opens as text every time.
  const [proseView, setProseView] = useState<ProseView>('text')
  const prose = isProse(file.path) && file.rows.length > 0

  return (
    <section
      ref={(element) => cardRef(file.key, element)}
      aria-labelledby={headingId}
      data-diff-file={file.key}
      // `clip`, not `hidden`: hidden makes the card a scroller, and a sticky header
      // inside one sticks to the card instead of to the pane.
      className="rounded-lg border border-line bg-stage [overflow:clip]"
    >
      {/* Square corners: stuck mid-card, rounded ones would show the lines passing
          under it; at the card's top the card's own clip rounds them. */}
      <div className="sticky top-0 z-[2] flex min-h-10 min-w-0 items-center gap-1 border-b border-line bg-stage py-1 pr-1 pl-1.5">
        <button
          type="button"
          aria-expanded={!collapsed}
          onClick={() => onToggle(file.key)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-1.5 py-1 text-left hover:bg-surface-2"
        >
          <FileMark path={file.path} size={14} />
          <span id={headingId} className="min-w-0 truncate text-[13px]" title={file.oldPath === undefined ? file.path : `${file.oldPath} → ${file.path}`}>
            <span className="text-text">{name}</span>
            {folder === '' ? null : <span className="text-dim"> {folder}</span>}
          </span>
          {file.oldPath !== undefined ? <span className="flex-none text-meta text-dim">renamed</span>
            : file.status === 'deleted' ? <span className="flex-none text-meta text-dim">deleted</span> : null}
          {/* Line counts are review bookkeeping; a prose file read as text leaves them out. */}
          {prose && proseView === 'text' ? null : (
            <span className="ml-auto flex flex-none items-center gap-1.5 pl-2 text-meta tabular-nums">
              <span className="text-ok">+{file.added}</span>
              <span className="text-danger">−{file.removed}</span>
            </span>
          )}
        </button>
        {prose ? (
          <SegmentedControl label={`View of ${name}`} options={textViewOptions(headingId)} value={proseView} onChange={setProseView} />
        ) : null}
        <button
          type="button"
          aria-label={`More for ${name}`}
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          title="More"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect()
            setMenu((current) => current === null ? { x: rect.right - 184, y: rect.bottom + 4 } : null)
          }}
          className={`grid h-7 w-7 flex-none cursor-pointer place-items-center rounded-button-sm border-0 ${menu === null ? 'bg-transparent text-muted hover:bg-icon-fill hover:text-text' : 'bg-icon-fill text-text'}`}
        >
          <Icon icon={MoreHorizontalIcon} size={15} />
        </button>
        <button
          type="button"
          aria-label={collapsed ? `Expand ${name}` : `Collapse ${name}`}
          title={collapsed ? 'Expand' : 'Collapse'}
          onClick={() => onToggle(file.key)}
          className="grid h-7 w-7 flex-none cursor-pointer place-items-center rounded-button-sm border-0 bg-transparent text-muted hover:bg-icon-fill hover:text-text"
        >
          <Icon icon={ArrowDown01Icon} size={13} className={`duration-200 ease-arrive motion-safe:transition-transform ${collapsed ? '-rotate-90' : ''}`} />
        </button>
        {menu === null ? null : <ContextMenu x={menu.x} y={menu.y} items={items} onClose={() => setMenu(null)} />}
      </div>
      {/* Keyed by view: Text has no lazy box, so Source mounts its own and watches it. */}
      {collapsed ? null : <FileBody key={prose ? proseView : 'source'} file={file} layout={layout} scrollRoot={scrollRoot} text={prose && proseView === 'text'} bodyId={`${headingId}-body`} />}
    </section>
  )
})

/** The lines, or what stands in for them until they are near enough to draw. */
function FileBody({ file, layout, scrollRoot, text, bodyId }: {
  file: DiffViewFile
  layout: DiffLayout
  scrollRoot: RefObject<HTMLElement>
  /** A prose file read as text rather than as source. */
  text: boolean
  bodyId: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const near = useNear(box, scrollRoot)
  const syntax = useMemo(() => (near ? rowSyntax(file.path, file.rows) : null), [near, file.path, file.rows])
  const estimate = Math.max(1, file.rows.length) * ROW_PX + 8
  // The widest number, plus the padding either side of it inside its own column.
  const gutter = useMemo(() => `calc(${String(file.rows.reduce((widest, row) =>
    row.kind === 'gap' ? widest : Math.max(widest, row.kind === 'added' ? row.newNo ?? 0 : row.kind === 'removed' ? row.oldNo ?? 0 : Math.max(row.oldNo ?? 0, row.newNo ?? 0)), 0)).length}ch + 20px)`, [file.rows])

  if (file.rows.length === 0) {
    return (
      <p className="m-0 px-3 py-2.5 text-label text-dim">
        {file.binary ? 'Binary file, no lines to show.'
          : file.truncated ? 'Too large to show here. Open it in the files panel to read all of it.'
            : file.skipped ? 'Diff not loaded, this turn changed many files. Open it in the files panel to read it.'
            : file.status === 'deleted' ? 'Deleted.' : 'No line changes.'}
      </p>
    )
  }
  if (text) {
    return (
      <div id={bodyId} className="py-1.5">
        <TextLines rows={file.rows} markdown={/\.(md|markdown)$/i.test(file.path)} />
        {file.truncated ? <p className="m-0 px-3 pt-1.5 pb-1 text-label text-warn">Part of this file’s diff is left out.</p> : null}
      </div>
    )
  }
  return (
    <div
      id={bodyId}
      ref={box}
      className="py-1 font-mono text-meta leading-[18px]"
      // Drawn once, then skipped by the browser whenever it is out of view.
      style={{ '--diff-gutter': gutter, contentVisibility: 'auto', containIntrinsicSize: `auto ${estimate}px`, ...(near ? {} : { height: estimate }) } as CSSProperties}
    >
      {near ? (layout === 'split' ? <SplitLines rows={file.rows} syntax={syntax} /> : <StackedLines rows={file.rows} syntax={syntax} />) : null}
      {file.truncated && near ? <p className="m-0 px-3 pt-1.5 pb-1 font-sans text-label text-warn">Part of this file’s diff is left out.</p> : null}
    </div>
  )
}

type LineRow = Exclude<DiffViewRow, { kind: 'gap' }>
/** Each line's coloured spans, by row. `null` where the file has no grammar. */
type RowSyntax = ReadonlyMap<DiffViewRow, SyntaxSpan[]> | null

/**
 * Past this many characters of diff a file stays plain: the parse runs on the main
 * thread as the card scrolls into view, and a change this long is a generated file.
 */
const HIGHLIGHT_MAX_CHARS = 120_000

/**
 * Colours each hunk as the two texts it comes from: unchanged and removed lines read
 * as the old text, unchanged and added lines as the new, so a line inside a block
 * comment or a template string colours as one. Hunks parse apart, so a comment the
 * diff leaves out between them cannot run on into the next. An unchanged line takes
 * the new side's colours. The grammar is the file's, read once: the first line seen
 * is line 1 only where the diff starts there, which is where a `#!` sits.
 */
export function rowSyntax(path: string, rows: readonly DiffViewRow[]): RowSyntax {
  const first = rows.find((row) => row.kind !== 'gap')
  const language = sourceLanguage(path, first?.text)
  if (language === null || rows.reduce((sum, row) => sum + (row.kind === 'gap' ? 0 : row.text.length + 1), 0) > HIGHLIGHT_MAX_CHARS) return null
  const spans = new Map<DiffViewRow, SyntaxSpan[]>()
  const colour = (side: LineRow[]) => {
    if (side.length === 0) return
    const lines = highlightLines(language, side.map((row) => row.text).join('\n'))
    side.forEach((row, index) => spans.set(row, lines[index] ?? []))
  }
  let hunk: LineRow[] = []
  for (const row of [...rows, { kind: 'gap' } as const]) {
    if (row.kind !== 'gap') {
      hunk.push(row)
      continue
    }
    colour(hunk.filter((line) => line.kind !== 'added'))
    colour(hunk.filter((line) => line.kind !== 'removed'))
    hunk = []
  }
  return spans
}

/** A line's text in its grammar's colours, or as it is where there is none. */
function Code({ row, syntax }: { row: DiffViewRow | undefined; syntax: RowSyntax }) {
  if (row === undefined || row.kind === 'gap' || row.text === '') return ' '
  const spans = syntax?.get(row)
  if (spans === undefined) return row.text
  return spans.map((span, index) => (span.className === '' ? span.text : <span key={index} className={span.className}>{span.text}</span>))
}

/** Lines the diff leaves out between two hunks, counted where Git says how many. */
function Gap({ count }: { count?: number }) {
  return (
    <div className="my-1 select-none bg-surface-2 px-3 py-1.5 font-sans text-label text-dim">
      {count === undefined ? 'Unmodified lines' : `${count} unmodified ${count === 1 ? 'line' : 'lines'}`}
    </div>
  )
}

/** Wraps rather than scrolls sideways, as every diff in Manor does. */
const TEXT = 'min-w-0 whitespace-pre-wrap wrap-anywhere pr-3'
const NUMBER = 'select-none pr-3 pl-2 text-right text-dim diff-quiet'

/** The 3px mark at a changed line's edge, and nothing on a line that did not change. */
function Edge({ kind }: { kind: DiffViewRow['kind'] | undefined }) {
  return <span aria-hidden className={kind === 'added' ? ADDED_EDGE : kind === 'removed' ? REMOVED_EDGE : ''} />
}

/** What the reading view draws: a run of lines that changed alike, or the place lines were left out. */
type TextBlock =
  | { kind: LineRow['kind']; lines: string[] }
  | { kind: 'gap'; count?: number }

/** Consecutive lines of one kind become one block, so a list or a paragraph reaches Markdown whole. */
function textBlocks(rows: readonly DiffViewRow[]) {
  const blocks: TextBlock[] = []
  for (const row of rows) {
    const last = blocks[blocks.length - 1]
    if (row.kind === 'gap') blocks.push(row.count === undefined ? { kind: 'gap' } : { kind: 'gap', count: row.count })
    else if (last !== undefined && last.kind === row.kind && 'lines' in last) last.lines.push(row.text)
    else blocks.push({ kind: row.kind, lines: [row.text] })
  }
  return blocks
}

/** A quiet break where the diff leaves lines out, spoken as the count of unchanged lines. */
function TextGap({ count }: { count?: number }) {
  return (
    <div
      role="separator"
      aria-label={count === undefined ? 'Unchanged lines' : `${count} unchanged ${count === 1 ? 'line' : 'lines'}`}
      className="select-none py-1 text-center text-label leading-none text-dim"
    >
      <span aria-hidden>…</span>
    </div>
  )
}

/**
 * A prose change as reading text: the message's own font and size, wrapped, no numbers.
 * A Markdown file reads as rendered Markdown, one block per run of lines that changed
 * alike; a list cut in two by a change may come out as two lists. Other prose stays
 * plain lines. Added blocks carry the soft success tint, removed ones are struck
 * through and muted. A blank line is a paragraph break, so it takes a small space and
 * no tint.
 */
function TextLines({ rows, markdown }: { rows: readonly DiffViewRow[]; markdown: boolean }) {
  const blocks = useMemo(() => textBlocks(rows), [rows])
  return (
    <>
      {blocks.map((block, index) => {
        if (block.kind === 'gap') return <TextGap key={index} {...(block.count === undefined ? {} : { count: block.count })} />
        const tone = block.kind === 'added' ? `${ADDED} text-text` : block.kind === 'removed' ? `${REMOVED} text-muted line-through [&_*]:text-muted` : 'text-text'
        // Close to the 12px source view: a diff is read beside the chat, not as a message.
        const type = 'text-label leading-[1.6]'
        if (markdown) {
          const text = block.lines.join('\n')
          return text.trim() === '' ? <div key={index} aria-hidden className="h-2" /> : (
            <div key={index} className={`px-3 py-0.5 ${type} ${tone}`}>
              <Markdown text={text} variant="panel" />
            </div>
          )
        }
        return block.lines.map((line, at) => line === '' ? (
          <div key={`${index}-${at}`} aria-hidden className="h-2" />
        ) : (
          <p key={`${index}-${at}`} className={`m-0 px-3 py-0.5 ${type} whitespace-pre-wrap wrap-anywhere ${tone}`}>{line}</p>
        ))
      })}
    </>
  )
}

/** One column of numbers: the new line's, or the old one's for a line that is gone. */
function StackedLines({ rows, syntax }: { rows: readonly DiffViewRow[]; syntax: RowSyntax }) {
  return (
    <>
      {rows.map((row, index) => row.kind === 'gap' ? <Gap key={index} {...(row.count === undefined ? {} : { count: row.count })} /> : (
        <div key={index} className={`grid grid-cols-[3px_var(--diff-gutter)_minmax(0,1fr)] ${
          row.kind === 'added' ? `${ADDED} text-text` : row.kind === 'removed' ? `${REMOVED} text-text` : 'text-muted'}`}>
          <Edge kind={row.kind} />
          <span className={NUMBER}>{row.kind === 'removed' ? row.oldNo : row.newNo}</span>
          <span className={TEXT}><Code row={row} syntax={syntax} /></span>
        </div>
      ))}
    </>
  )
}

function SplitLines({ rows, syntax }: { rows: readonly DiffViewRow[]; syntax: RowSyntax }) {
  const pairs = useMemo(() => splitRows(rows), [rows])
  return (
    <>
      {pairs.map((pair, index) => pair.kind === 'gap' ? <Gap key={index} {...(pair.count === undefined ? {} : { count: pair.count })} /> : (
        <div key={index} className="grid grid-cols-[3px_var(--diff-gutter)_minmax(0,1fr)_3px_var(--diff-gutter)_minmax(0,1fr)]">
          <Edge kind={pair.left?.kind} />
          <span className={`${NUMBER} ${pair.left?.kind === 'removed' ? REMOVED : ''}`}>{pair.left?.oldNo}</span>
          <span className={`${TEXT} border-r border-line ${pair.left === undefined ? 'bg-surface-2' : pair.left.kind === 'removed' ? `${REMOVED} text-text` : 'text-muted'}`}>
            <Code row={pair.left} syntax={syntax} />
          </span>
          <Edge kind={pair.right?.kind} />
          <span className={`${NUMBER} ${pair.right?.kind === 'added' ? ADDED : ''}`}>{pair.right?.newNo}</span>
          <span className={`${TEXT} ${pair.right === undefined ? 'bg-surface-2' : pair.right.kind === 'added' ? `${ADDED} text-text` : 'text-muted'}`}>
            <Code row={pair.right} syntax={syntax} />
          </span>
        </div>
      ))}
    </>
  )
}

/** True once the element has come within `AHEAD` of the scroller's view, and from then on. */
function useNear(element: RefObject<HTMLElement>, root: RefObject<HTMLElement>) {
  const [near, setNear] = useState(false)
  useEffect(() => {
    const target = element.current
    if (near || target === null) return
    if (typeof IntersectionObserver === 'undefined') {
      setNear(true)
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return
      setNear(true)
      observer.disconnect()
    }, { root: root.current, rootMargin: AHEAD })
    observer.observe(target)
    return () => observer.disconnect()
  }, [near, element, root])
  return near
}
