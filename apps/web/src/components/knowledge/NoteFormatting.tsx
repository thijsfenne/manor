import {
  ArrowDown01Icon,
  BubbleChatAddIcon,
  CheckListIcon,
  CodeSquareIcon,
  Heading01Icon,
  Heading02Icon,
  Heading03Icon,
  InformationCircleIcon,
  LeftToRightListBulletIcon,
  LeftToRightListNumberIcon,
  Link01Icon,
  MoreHorizontalIcon,
  QuoteDownIcon,
  SolidLine01Icon,
  SourceCodeIcon,
  TableIcon,
  TextBoldIcon,
  TextIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
  Tick02Icon,
  Unlink01Icon,
} from '@hugeicons/core-free-icons'
import { EditorSelection, type EditorState, type TransactionSpec } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../Icon'
import { Popover } from '../ui/Popover'
import { turnInto } from './blockCommands'
import { activeMarks, editLinkAt, linkAt, linkLabelText, linkTarget, markAvailable, removeLink, setLink, toggleMark, wikilinkAt, type InlineMark } from './formatCommands'
import { linkDraftEffect } from './noteEditing'
import { blockKindAt, type BlockKind } from './noteSyntax'
import { applySlashItem, openSlashMenu, slashEffect, type SlashItem } from './slashMenu'

type IconData = Parameters<typeof Icon>[0]['icon']

/** What a selection can be sent to besides formatting: the chat's quote actions. */
export interface QuoteAction {
  id: string
  label: string
  /** Shown when the bar is wide enough for words. */
  short: string
  icon: IconData
  run: (text: string) => void
}

export const BLOCK_ROWS: { kind: BlockKind; label: string; icon: IconData; hint: string }[] = [
  { kind: 'text', label: 'Text', icon: TextIcon, hint: '⌘⌥0' },
  { kind: 'h1', label: 'Heading 1', icon: Heading01Icon, hint: '⌘⌥1' },
  { kind: 'h2', label: 'Heading 2', icon: Heading02Icon, hint: '⌘⌥2' },
  { kind: 'h3', label: 'Heading 3', icon: Heading03Icon, hint: '⌘⌥3' },
  { kind: 'bullet', label: 'Bulleted list', icon: LeftToRightListBulletIcon, hint: '⌘⌥5' },
  { kind: 'number', label: 'Numbered list', icon: LeftToRightListNumberIcon, hint: '⌘⌥6' },
  { kind: 'todo', label: 'To-do list', icon: CheckListIcon, hint: '⌘⌥4' },
  { kind: 'quote', label: 'Quote', icon: QuoteDownIcon, hint: '>' },
  { kind: 'code', label: 'Code block', icon: CodeSquareIcon, hint: '⌘⌥8' },
]

const MARK_BUTTONS: { mark: InlineMark; label: string; icon: IconData; shortcut: string }[] = [
  { mark: 'bold', label: 'Bold', icon: TextBoldIcon, shortcut: '⌘B' },
  { mark: 'italic', label: 'Italic', icon: TextItalicIcon, shortcut: '⌘I' },
  { mark: 'strike', label: 'Strikethrough', icon: TextStrikethroughIcon, shortcut: '⌘⇧S' },
  { mark: 'code', label: 'Inline code', icon: SourceCodeIcon, shortcut: '⌘E' },
]

/** Inline marks that fold into More when the bar does not fit. Bold and italic always stay. */
const FOLDING: ReadonlySet<InlineMark> = new Set(['strike', 'code'])

export const SLASH_ICONS: Record<SlashItem['id'], IconData> = {
  text: TextIcon,
  h1: Heading01Icon,
  h2: Heading02Icon,
  h3: Heading03Icon,
  bullet: LeftToRightListBulletIcon,
  number: LeftToRightListNumberIcon,
  todo: CheckListIcon,
  quote: QuoteDownIcon,
  divider: SolidLine01Icon,
  code: CodeSquareIcon,
  callout: InformationCircleIcon,
  table: TableIcon,
}

// ---------------------------------------------------------------------------
// The bar itself, without any knowledge of the editor, so it renders in a test.

export interface FormatToolbarProps {
  block: BlockKind
  marks: Record<InlineMark, boolean>
  /** Whether each mark's command would act; a control that would decline shows disabled. */
  available: Record<InlineMark, boolean>
  link: boolean
  linkAvailable: boolean
  compact: boolean
  /**
   * Where the bar's menus open, so they never cover the selection: away from it when
   * there is room (\`up\` for a bar above the selection), otherwise past the selection
   * on the other side, \`clear\` pixels beyond the bar's edge.
   */
  menuPlace?: MenuPlace
  quote: readonly QuoteAction[]
  /** The link field, while it is open. `text` is there when an existing link is edited. */
  linkDraft: LinkDraftView | null
  onTurnInto: (kind: BlockKind) => void
  onToggle: (mark: InlineMark) => void
  onLink: () => void
  onLinkSubmit: (url: string, text?: string) => void
  onLinkRemove: () => void
  onLinkCancel: () => void
  onQuote: (action: QuoteAction) => void
  /** Escape with focus in the bar: back to the text, selection kept. */
  onLeave: () => void
}

const barButton =
  'grid h-7 min-w-7 flex-none cursor-pointer place-items-center rounded-md border-0 bg-transparent px-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-[var(--accent-fg)] aria-pressed:bg-user-bg aria-pressed:text-text aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted'
const menuRow =
  'flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-label text-text [font:inherit] hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:outline-none aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent'

/** The buttons never take the caret: pressing one keeps the selection it acts on. */
const keep = (event: { preventDefault: () => void }) => event.preventDefault()

export interface LinkDraftView {
  url: string
  existing: boolean
  text?: string
  /** A `[[wikilink]]`: its destination is a note name, not an address. */
  wiki?: boolean
}

export interface MenuPlace {
  side: 'up' | 'down'
  clear: number
}

const MENU_DOWN: MenuPlace = { side: 'down', clear: 0 }

export function FormatToolbar(props: FormatToolbarProps) {
  const { block, marks, available, link, linkAvailable, compact, quote, linkDraft, menuPlace = MENU_DOWN } = props
  const [menu, setMenu] = useState<'turn' | 'more' | null>(null)
  const current = BLOCK_ROWS.find((row) => row.kind === block) ?? BLOCK_ROWS[0]!
  const shown = MARK_BUTTONS.filter((button) => !compact || !FOLDING.has(button.mark))
  const folded = compact ? MARK_BUTTONS.filter((button) => FOLDING.has(button.mark)) : []

  // Arrow keys walk the bar, the ARIA toolbar pattern; Escape hands focus back.
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (menu !== null) setMenu(null)
      else props.onLeave()
      return
    }
    if (menu !== null || (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft')) return
    const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>('[data-bar-control]')]
    const at = buttons.indexOf(event.target as HTMLElement)
    if (at === -1) return
    event.preventDefault()
    buttons[(at + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
  }

  if (linkDraft !== null) return <LinkField {...props} draft={linkDraft} />

  return (
    <div role="toolbar" aria-label="Format selection" aria-keyshortcuts="Alt+F10" className="relative flex items-center gap-0.5" onKeyDown={onKeyDown}>
      <div className="relative">
        <button
          type="button"
          data-bar-control
          aria-haspopup="menu"
          aria-expanded={menu === 'turn'}
          title="Turn into"
          className={`${barButton} gap-1 px-2 text-label text-text`}
          onMouseDown={keep}
          onClick={() => setMenu(menu === 'turn' ? null : 'turn')}
        >
          <span className="flex items-center gap-1">
            {compact ? <Icon icon={current.icon} size={15} /> : <span className="max-w-[7rem] truncate">{current.label}</span>}
            <Icon icon={ArrowDown01Icon} size={12} />
          </span>
        </button>
        <BarMenu open={menu === 'turn'} label="Turn into" place={menuPlace} onClose={() => setMenu(null)}>
          {BLOCK_ROWS.map((row) => (
            <MenuRow
              key={row.kind}
              icon={row.icon}
              label={row.label}
              hint={row.hint}
              checked={row.kind === block}
              onPick={() => {
                setMenu(null)
                props.onTurnInto(row.kind)
              }}
            />
          ))}
        </BarMenu>
      </div>
      <Hairline />
      {shown.map((button) => (
        <button
          key={button.mark}
          type="button"
          data-bar-control
          aria-label={button.label}
          aria-pressed={marks[button.mark]}
          // aria-disabled, not disabled: the control stays in the arrow-key order.
          aria-disabled={available[button.mark] ? undefined : true}
          title={`${button.label} (${button.shortcut})`}
          className={barButton}
          onMouseDown={keep}
          onClick={() => { if (available[button.mark]) props.onToggle(button.mark) }}
        >
          <Icon icon={button.icon} size={15} />
        </button>
      ))}
      <button
        type="button"
        data-bar-control
        aria-label="Link"
        aria-pressed={link}
        aria-disabled={linkAvailable ? undefined : true}
        title="Link (⌘K)"
        className={barButton}
        onMouseDown={keep}
        onClick={() => { if (linkAvailable) props.onLink() }}
      >
        <Icon icon={Link01Icon} size={15} />
      </button>
      {folded.length === 0 ? null : (
        <div className="relative">
          <button
            type="button"
            data-bar-control
            aria-label="More formatting"
            aria-haspopup="menu"
            aria-expanded={menu === 'more'}
            className={barButton}
            onMouseDown={keep}
            onClick={() => setMenu(menu === 'more' ? null : 'more')}
          >
            <Icon icon={MoreHorizontalIcon} size={15} />
          </button>
          <BarMenu open={menu === 'more'} label="More formatting" align="end" place={menuPlace} onClose={() => setMenu(null)}>
            {folded.map((button) => (
              <MenuRow
                key={button.mark}
                icon={button.icon}
                label={button.label}
                hint={button.shortcut}
                checked={marks[button.mark]}
                disabled={!available[button.mark]}
                onPick={() => {
                  setMenu(null)
                  props.onToggle(button.mark)
                }}
              />
            ))}
          </BarMenu>
        </div>
      )}
      {quote.length === 0 ? null : (
        <>
          <Hairline />
          {quote.map((action) => (
            <button
              key={action.id}
              type="button"
              data-bar-control
              data-quote-action={action.id}
              aria-label={action.label}
              title={action.label}
              className={`${barButton} gap-1.5 px-2 text-label`}
              onMouseDown={keep}
              onClick={() => props.onQuote(action)}
            >
              <span className="flex items-center gap-1.5">
                <Icon icon={action.icon} size={15} />
                {compact ? null : <span>{action.short}</span>}
              </span>
            </button>
          ))}
        </>
      )}
    </div>
  )
}

function Hairline() {
  return <span aria-hidden className="mx-1 h-4 w-px flex-none bg-line" />
}

function BarMenu({ open, label, align = 'start', place = MENU_DOWN, onClose, children }: { open: boolean; label: string; align?: 'start' | 'end'; place?: MenuPlace; onClose: () => void; children: ReactNode }) {
  const side = place.side
  const ref = useRef<HTMLDivElement>(null)
  // Focus moves into the list only when the bar already had it (keyboard use).
  useEffect(() => {
    if (!open) return
    const owner = ref.current?.ownerDocument
    if (owner === undefined || !ref.current?.parentElement?.contains(owner.activeElement)) return
    ref.current.querySelector<HTMLElement>('[role="menuitemradio"],[role="menuitemcheckbox"]')?.focus()
  }, [open])
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    const rows = [...event.currentTarget.querySelectorAll<HTMLElement>('button')]
    const at = rows.indexOf(event.target as HTMLElement)
    event.preventDefault()
    event.stopPropagation()
    rows[(at + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus()
  }
  return (
    <Popover
      ref={ref}
      open={open}
      origin={`${side === 'up' ? 'bottom' : 'top'}-${align === 'end' ? 'right' : 'left'}`}
      role="menu"
      aria-label={label}
      // Solid, not \`surface-floating\`: the bar's own backdrop blur is a backdrop root,
      // so a frosted menu inside it would show the note's text through it unblurred.
      className={`absolute z-[2] min-w-[13rem] rounded-panel border border-line bg-raised p-1 shadow-popover ${align === 'end' ? 'right-0' : 'left-0'}`}
      // The bar's own padding (4px) plus 6px of air, then past the selection if asked.
      style={side === 'up' ? { bottom: `calc(100% + ${place.clear + 10}px)` } : { top: `calc(100% + ${place.clear + 10}px)` }}
      contentClassName="grid"
    >
      <div onKeyDown={onKeyDown} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onClose() }}>
        {children}
      </div>
    </Popover>
  )
}

function MenuRow({ icon, label, hint, checked, disabled = false, onPick }: { icon: IconData; label: string; hint: string; checked: boolean; disabled?: boolean; onPick: () => void }) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      aria-disabled={disabled ? true : undefined}
      className={menuRow}
      onMouseDown={keep}
      onClick={() => { if (!disabled) onPick() }}
    >
      <Icon icon={icon} size={15} className="flex-none text-muted" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="flex-none font-mono text-meta text-dim">{hint}</span>
      <span className="grid w-3.5 flex-none place-items-center">{checked ? <Icon icon={Tick02Icon} size={13} /> : null}</span>
    </button>
  )
}

function LinkField({ draft, onLinkSubmit, onLinkRemove, onLinkCancel }: FormatToolbarProps & { draft: LinkDraftView }) {
  const [url, setUrl] = useState(draft.url)
  const [text, setText] = useState(draft.text ?? '')
  const cancel = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    onLinkCancel()
  }
  const input = 'h-7 min-w-0 flex-1 rounded-md border-0 bg-surface-2 px-2 text-label text-text outline-none placeholder:text-dim'
  return (
    <form
      role="group"
      aria-label="Edit link"
      className="flex min-w-0 items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault()
        if (draft.text === undefined) onLinkSubmit(url)
        else onLinkSubmit(url, text)
      }}
    >
      {draft.text === undefined ? null : (
        <input
          aria-label="Link text"
          placeholder="Text"
          value={text}
          spellCheck={false}
          className={`${input} w-36`}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={cancel}
        />
      )}
      <input
        // eslint-disable-next-line jsx-a11y/no-autofocus -- the field is what the user just asked for
        autoFocus
        aria-label={draft.wiki === true ? 'Linked note' : 'Link address'}
        placeholder={draft.wiki === true ? 'Note name' : 'Paste or type a link'}
        value={url}
        spellCheck={false}
        className={`${input} w-56`}
        onChange={(event) => setUrl(event.target.value)}
        onKeyDown={cancel}
      />
      <button type="submit" aria-label="Apply link" title="Apply (Enter)" className={barButton} onMouseDown={keep}>
        <Icon icon={Tick02Icon} size={15} />
      </button>
      {draft.existing ? (
        <button type="button" aria-label="Remove link" title="Remove link" className={barButton} onMouseDown={keep} onClick={onLinkRemove}>
          <Icon icon={Unlink01Icon} size={15} />
        </button>
      ) : null}
    </form>
  )
}

// ---------------------------------------------------------------------------
// The slash menu's rows.

export function SlashMenuList({ items, index, onPick, onHover }: { items: readonly SlashItem[]; index: number; onPick: (item: SlashItem) => void; onHover: (index: number) => void }) {
  const active = useRef<HTMLLIElement>(null)
  useEffect(() => {
    active.current?.scrollIntoView?.({ block: 'nearest' })
  }, [index])
  return (
    <>
      {items.map((item, position) => (
        <li
          key={item.id}
          id={`manor-slash-${item.id}`}
          ref={position === index ? active : undefined}
          role="option"
          aria-selected={position === index}
          className={`flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 ${position === index ? 'bg-surface-2' : ''}`}
          onMouseDown={(event) => {
            event.preventDefault()
            onPick(item)
          }}
          onMouseMove={() => { if (position !== index) onHover(position) }}
        >
          <span className="grid h-8 w-8 flex-none place-items-center rounded-md border border-line bg-surface text-muted">
            <Icon icon={SLASH_ICONS[item.id]} size={16} />
          </span>
          <span className="min-w-0 flex-1 truncate text-label text-text">{item.name}</span>
          <span className="flex-none font-mono text-meta text-dim">{item.hint}</span>
        </li>
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// The live layer: reads the editor, places the bar and the menu, runs the commands.

export interface NoteFormattingHandle {
  openLink: (view: EditorView) => boolean
  focusToolbar: (view: EditorView) => boolean
}

interface NoteFormattingProps {
  view: EditorView | null
  /** Bumped on every editor update the layer should look at. */
  version: number
  quote: readonly QuoteAction[]
  handle: { current: NoteFormattingHandle | null }
}

const GAP = 8
const INSET = 8
/** The Turn into menu's height with all its rows, for choosing which way it opens. */
const MENU_HEIGHT = 340

/** Past this, the bar stops reading the selection on every update and shows plain controls. */
const STATE_LIMIT = { chars: 5_000, lines: 200 }

const NO_MARKS: Record<InlineMark, boolean> = { bold: false, italic: false, strike: false, code: false }
const ALL_MARKS: Record<InlineMark, boolean> = { bold: true, italic: true, strike: true, code: true }

/**
 * The bar's pressed and disabled states. A selection beyond `STATE_LIMIT` skips the
 * work: nothing shows pressed, everything enabled, and a command that cannot act
 * still declines when pressed.
 */
export function markStates(state: EditorState): { marks: Record<InlineMark, boolean>; available: Record<InlineMark, boolean>; linkAvailable: boolean } {
  const range = state.selection.main
  const lines = state.doc.lineAt(range.to).number - state.doc.lineAt(range.from).number
  if (range.to - range.from > STATE_LIMIT.chars || lines > STATE_LIMIT.lines) return { marks: NO_MARKS, available: ALL_MARKS, linkAvailable: true }
  const available = {
    bold: markAvailable(state, 'bold'),
    italic: markAvailable(state, 'italic'),
    strike: markAvailable(state, 'strike'),
    code: markAvailable(state, 'code'),
  }
  const linkAvailable = linkAt(state, range.from, range.to) !== null || setLink('https://example.com')(state) !== null
  return { marks: activeMarks(state), available, linkAvailable }
}

/** The note's own region, which the bar and menu stay inside: the dock panel or the page. */
export function boundsOf(view: EditorView): DOMRect {
  const region = view.dom.closest('[aria-label="Note document"]') ?? view.dom
  return region.getBoundingClientRect()
}

export function NoteFormatting({ view, version, quote, handle }: NoteFormattingProps) {
  const reduce = useReducedMotion() ?? false
  const bar = useRef<HTMLDivElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const fullWidth = useRef(0)
  const [compact, setCompact] = useState(false)
  const [menuPlace, setMenuPlace] = useState<MenuPlace>(MENU_DOWN)
  const [barFocused, setBarFocused] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [linkDraft, setLinkDraft] = useState<(LinkDraftView & { from: number; to: number; at: number }) | null>(null)
  const [, setTick] = useState(0)

  const state = view?.state ?? null
  const range = state?.selection.main ?? null
  const focused = view?.hasFocus ?? false
  const slash = state !== null && focused ? openSlashMenu(state) : null
  const showBar = view !== null && state !== null && range !== null && slash === null && (
    linkDraft !== null || (!range.empty && (focused || barFocused) && !dragging && !view.composing)
  )

  // A selection made with the mouse shows its bar on release, the way Notion does.
  useEffect(() => {
    if (view === null) return
    const down = (event: MouseEvent) => { if (event.button === 0) setDragging(true) }
    const up = () => setDragging(false)
    view.contentDOM.addEventListener('mousedown', down)
    window.addEventListener('mouseup', up)
    return () => {
      view.contentDOM.removeEventListener('mousedown', down)
      window.removeEventListener('mouseup', up)
    }
  }, [view])

  // Scrolling the note or resizing the window moves the anchor; follow it.
  useEffect(() => {
    if (!showBar && slash === null) return
    const move = () => setTick((tick) => tick + 1)
    window.addEventListener('scroll', move, true)
    window.addEventListener('resize', move)
    return () => {
      window.removeEventListener('scroll', move, true)
      window.removeEventListener('resize', move)
    }
  }, [showBar, slash === null])

  // A collapsed or replaced selection ends the link edit.
  useEffect(() => {
    if (linkDraft === null || view === null) return
    if (linkDraft.to > view.state.doc.length) setLinkDraft(null)
  }, [linkDraft, view, version])

  useLayoutEffect(() => {
    const element = bar.current
    if (!showBar || element === null || view === null || range === null) return
    const from = linkDraft?.from ?? range.from
    const to = linkDraft?.to ?? range.to
    const start = view.coordsAtPos(from, 1)
    const end = view.coordsAtPos(to, -1) ?? start
    const box = boundsOf(view)
    if (start === null || end === null || start.bottom < box.top || start.top > box.bottom) {
      element.style.visibility = 'hidden'
      return
    }
    const available = Math.max(160, box.width - INSET * 2)
    if (!compact) fullWidth.current = element.offsetWidth
    const wantCompact = fullWidth.current > available
    if (wantCompact !== compact) setCompact(wantCompact)
    const width = Math.min(element.offsetWidth, available)
    const height = element.offsetHeight
    const sameLine = Math.abs(start.top - end.top) < 4
    const centre = sameLine ? (start.left + end.left) / 2 : start.left + width / 2
    const left = Math.max(box.left + INSET, Math.min(centre - width / 2, box.right - INSET - width))
    const above = Math.min(start.top, end.top) - GAP - height
    const placeAbove = above >= Math.max(box.top, 0) + 4
    const top = placeAbove ? above : Math.max(start.bottom, end.bottom) + GAP
    // The Turn into menu is the tallest; it opens away from the selection where it fits,
    // otherwise on the selection's far side.
    const selectionTop = Math.min(start.top, end.top)
    const selectionBottom = Math.max(start.bottom, end.bottom)
    const place: MenuPlace = placeAbove
      ? top - Math.max(box.top, 0) >= MENU_HEIGHT ? { side: 'up', clear: 0 } : { side: 'down', clear: Math.max(0, Math.round(selectionBottom - top - height)) }
      : window.innerHeight - top - height >= MENU_HEIGHT ? { side: 'down', clear: 0 } : { side: 'up', clear: Math.max(0, Math.round(top - selectionTop)) }
    if (place.side !== menuPlace.side || place.clear !== menuPlace.clear) setMenuPlace(place)
    element.style.left = `${Math.round(left)}px`
    element.style.top = `${Math.round(top)}px`
    element.style.maxWidth = `${available}px`
    element.style.visibility = 'visible'
  })

  useLayoutEffect(() => {
    const element = menu.current
    if (slash === null || element === null || view === null) return
    const at = view.coordsAtPos(slash.from, 1)
    if (at === null) return
    const box = boundsOf(view)
    const width = Math.min(320, box.width - INSET * 2)
    const below = window.innerHeight - at.bottom - GAP - INSET
    const downward = below >= 240 || below >= at.top - GAP - INSET
    element.style.width = `${Math.max(220, width)}px`
    element.style.left = `${Math.round(Math.max(box.left + INSET, Math.min(at.left - 8, box.right - INSET - Math.max(220, width))))}px`
    element.style.top = downward ? `${Math.round(at.bottom + 4)}px` : ''
    element.style.bottom = downward ? '' : `${Math.round(window.innerHeight - at.top + 4)}px`
    element.style.maxHeight = `${Math.round(Math.min(320, downward ? below : at.top - GAP - INSET))}px`
  })

  const finish = (spec: TransactionSpec | null) => {
    if (view === null) return
    if (spec !== null) view.dispatch(spec)
    view.focus()
  }

  const openLink = (target: EditorView): boolean => {
    const current = target.state
    const head = current.selection.main.head
    // A caret in a link edits that link whole: its text and where it points.
    const wiki = current.selection.main.empty ? wikilinkAt(current, head) : null
    const here = current.selection.main.empty && wiki === null ? linkAt(current, head) : null
    if (wiki !== null || here !== null) {
      const from = wiki?.labelFrom ?? here!.textFrom
      const to = wiki?.labelTo ?? here!.textTo
      target.dispatch({ effects: linkDraftEffect.of({ from, to }) })
      setLinkDraft({ from, to, at: head, url: wiki?.target ?? here!.url, existing: true, text: linkLabelText(current.doc.sliceString(from, to)), wiki: wiki !== null })
      return true
    }
    const existing = linkAt(current, current.selection.main.from, current.selection.main.to)
    const span = existing === null ? linkTarget(current) : { from: existing.textFrom, to: existing.textTo }
    const from = span?.from ?? current.selection.main.head
    const to = span?.to ?? current.selection.main.head
    target.dispatch({ selection: EditorSelection.range(from, to), effects: linkDraftEffect.of({ from, to }) })
    setLinkDraft({ from, to, at: head, url: existing?.url ?? '', existing: existing !== null })
    return true
  }

  handle.current = {
    openLink,
    focusToolbar: (target) => {
      if (target.state.selection.main.empty || bar.current === null) return false
      bar.current.querySelector<HTMLElement>('[data-bar-control]')?.focus()
      return true
    },
  }

  const endLink = () => {
    setLinkDraft(null)
    view?.dispatch({ effects: linkDraftEffect.of(null) })
  }

  const toolbar = !showBar || state === null || range === null || view === null ? null : (
    <motion.div
      key="note-format-bar"
      ref={bar}
      data-note-toolbar
      // Placed by the layout effect above before the first paint; hidden until then.
      className="invisible fixed top-0 left-0 z-40 flex items-center rounded-xl border border-line surface-floating p-1 shadow-popover"
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? { opacity: 0, transition: { duration: 0.08 } } : { opacity: 0, y: 2, transition: { duration: 0.1 } }}
      transition={reduce ? { duration: 0.1 } : { duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
      onFocus={() => setBarFocused(true)}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setBarFocused(false)
        if (linkDraft !== null) endLink()
      }}
    >
      <FormatToolbar
        block={blockKindAt(state, range.from)}
        {...markStates(state)}
        link={linkAt(state, range.from, range.to) !== null}
        compact={compact}
        menuPlace={menuPlace}
        quote={quote}
        linkDraft={linkDraft}
        onTurnInto={(kind) => finish(turnInto(kind)(view.state))}
        onToggle={(mark) => finish(toggleMark(mark)(view.state))}
        onLink={() => { openLink(view) }}
        onLinkSubmit={(url, text) => {
          const draft = linkDraft
          endLink()
          if (draft === null) return
          if (text !== undefined) { finish(editLinkAt(draft.at, text, url)(view.state)); return }
          const scoped = view.state.update({ selection: EditorSelection.range(draft.from, draft.to) }).state
          const spec = setLink(url)(scoped)
          finish(spec === null ? null : { ...spec, selection: spec.selection ?? EditorSelection.range(draft.from, draft.to) })
        }}
        onLinkRemove={() => {
          const draft = linkDraft
          endLink()
          if (draft === null) return
          if (draft.wiki === true) { finish(editLinkAt(draft.at, draft.text ?? '', '')(view.state)); return }
          const scoped = view.state.update({ selection: EditorSelection.range(draft.from, draft.to) }).state
          finish(removeLink(scoped))
        }}
        onLinkCancel={() => {
          endLink()
          view.focus()
        }}
        onQuote={(action) => {
          const text = view.state.sliceDoc(range.from, range.to)
          action.run(text)
          view.dispatch({ selection: EditorSelection.cursor(range.head) })
        }}
        onLeave={() => view.focus()}
      />
    </motion.div>
  )

  const slashMenu = view === null ? null : (
    <Popover
      ref={menu}
      open={slash !== null}
      element="ul"
      origin="top-left"
      role="listbox"
      id="manor-slash-menu"
      aria-label="Insert a block"
      className="fixed z-40 overflow-y-auto rounded-panel border border-line surface-floating p-1 shadow-popover"
      contentClassName="m-0 list-none p-0"
    >
      {slash === null ? null : (
        <SlashMenuList
          items={slash.items}
          index={slash.index}
          onPick={(item) => finish(applySlashItem(view.state, item))}
          onHover={(index) => view.dispatch({ effects: slashEffect.of({ type: 'move', index }) })}
        />
      )}
    </Popover>
  )

  // A caret resting in a link gets a small chip naming where it goes, with the way in
  // to change it: the link's own markdown is never on screen to edit.
  const peekWiki = view !== null && state !== null && range !== null && focused && range.empty && linkDraft === null && slash === null ? wikilinkAt(state, range.head) : null
  const peekLink = view !== null && state !== null && range !== null && focused && range.empty && linkDraft === null && slash === null && peekWiki === null ? linkAt(state, range.head) : null
  const peek = view === null || (peekWiki === null && peekLink === null) ? null : (
    <LinkPeek
      view={view}
      from={peekWiki?.labelFrom ?? peekLink!.textFrom}
      destination={peekWiki?.target ?? peekLink!.url}
      onEdit={() => { openLink(view) }}
    />
  )

  return createPortal(
    <>
      <AnimatePresence>{toolbar}</AnimatePresence>
      {slashMenu}
      {peek}
    </>,
    document.body,
  )
}

/** Where the link at the caret points, and Edit (⌘K), just under the link. */
function LinkPeek({ view, from, destination, onEdit }: { view: EditorView; from: number; destination: string; onEdit: () => void }) {
  const chip = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = chip.current
    const at = view.coordsAtPos(from, 1)
    if (element === null) return
    const box = boundsOf(view)
    if (at === null || at.bottom < box.top || at.top > box.bottom) {
      element.style.visibility = 'hidden'
      return
    }
    const width = element.offsetWidth
    element.style.left = `${Math.round(Math.max(box.left + INSET, Math.min(at.left, box.right - INSET - width)))}px`
    element.style.top = `${Math.round(at.bottom + 6)}px`
    element.style.visibility = 'visible'
  })
  return (
    <div
      ref={chip}
      data-link-peek
      className="invisible fixed top-0 left-0 z-40 flex max-w-[22rem] items-center gap-1 rounded-lg border border-line surface-floating py-0.5 pr-0.5 pl-2 shadow-popover"
    >
      <Icon icon={Link01Icon} size={13} className="flex-none text-muted" />
      <span className="min-w-0 flex-1 truncate text-meta text-muted" title={destination}>{destination}</span>
      <button type="button" title="Edit link (⌘K)" className={`${barButton} text-label text-text`} onMouseDown={keep} onClick={onEdit}>
        Edit
      </button>
    </div>
  )
}
