import { syntaxTree } from '@codemirror/language'
import { Facet, Prec, StateEffect, StateField, Transaction, type EditorState, type Range, type TransactionSpec } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, keymap, type DecorationSet } from '@codemirror/view'
import { MAX_VAULT_IMAGE_BYTES, MAX_VAULT_IMAGE_NAME, embedWithWidth, imageEmbeds, resolveVaultImage, type ImageEmbed } from '@manor/contracts'
import { useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ImageLightbox } from '../ui/ZoomableImage'
import { enclosing, frontmatterRange, inFrontmatter, ownStep } from './noteSyntax'

/**
 * Pictures in a note, the way a block editor handles them, while the file stays plain
 * Obsidian markdown. A line that holds one picture embed and nothing else draws as the
 * picture; with the caret on that line the source shows above it, like every other
 * marker in the live preview. The picture can be dragged to another line (its source
 * line moves), resized from its right edge (the width lands in the embed as `|400`),
 * and opened large. A paste or drop saves the file through the server into Obsidian's
 * attachment folder and inserts `![[name]]` where it landed.
 */

export interface NoteImageConfig {
  notePath: string
  /** Every picture in the vault by vault path, to its signed link. */
  images: Readonly<Record<string, string>>
  /** Obsidian's `attachmentFolderPath`, as written. */
  attachmentFolder: string | null
  /** Sends one picture to be saved under request `id`; false when nothing went out. */
  save: ((id: string, name: string, dataUrl: string) => boolean) | null
}

export const noteImageConfig = Facet.define<NoteImageConfig, NoteImageConfig | null>({ combine: (values) => values[0] ?? null })

/** The narrowest a picture can be resized to, in pixels. */
const MIN_WIDTH = 48
/** How far the pointer travels before a press on a picture becomes a drag. */
const DRAG_SLOP = 4
const SAVE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif'])
/** How long a sent picture waits for the Mac's answer before it reads as failed. */
const ANSWER_TIMEOUT_MS = 60_000
const CODE_NODES = new Set(['FencedCode', 'CodeBlock', 'HTMLBlock', 'CommentBlock'])

interface ImageLine {
  /** The whole line, from its start to its end. */
  from: number
  to: number
  embed: ImageEmbed
  src: string
}

const setFocus = StateEffect.define<boolean>()

/** Whether the editor has focus. Without it no line counts as being edited, as in the live preview. */
const focusField = StateField.define<boolean>({
  create: () => false,
  update: (value, transaction) => {
    for (const effect of transaction.effects) if (effect.is(setFocus)) return effect.value
    return value
  },
})

function inCode(state: EditorState, pos: number): boolean {
  for (let node: { name: string; parent: unknown } | null = syntaxTree(state).resolveInner(pos, 1); node !== null; node = node.parent as typeof node) {
    if (CODE_NODES.has(node.name)) return true
  }
  return false
}

/** Every line that is one picture embed and nothing else, resolved against the vault. */
export function imageLines(state: EditorState): ImageLine[] {
  const config = state.facet(noteImageConfig)
  if (config === null) return []
  const found: ImageLine[] = []
  let pos = 0
  for (const iter = state.doc.iterLines(); !iter.next().done;) {
    const text = iter.value
    const from = pos
    pos += text.length + 1
    if (!text.includes('![')) continue
    const lead = text.length - text.trimStart().length
    const trimmed = text.trim()
    const embeds = imageEmbeds(trimmed)
    if (embeds.length !== 1 || embeds[0]!.from !== 0 || embeds[0]!.to !== trimmed.length) continue
    if (inFrontmatter(state, from) || inCode(state, from)) continue
    const embed = embeds[0]!
    const path = resolveVaultImage(embed.target, config.notePath, config.images, config.attachmentFolder ?? undefined)
    if (path === undefined) continue
    found.push({ from, to: from + text.length, embed: { ...embed, from: from + lead + embed.from, to: from + lead + embed.to }, src: config.images[path]! })
  }
  return found
}

function revealed(state: EditorState, line: ImageLine): boolean {
  if (!state.field(focusField)) return false
  return state.selection.ranges.some((range) => range.from <= line.to && range.to >= line.from)
}

function imageDecorations(state: EditorState, lines: readonly ImageLine[]): DecorationSet {
  const ranges: Range<Decoration>[] = []
  for (const line of lines) {
    const open = revealed(state, line)
    const widget = new ImageWidget(line.src, line.embed.alt, line.embed.width ?? null, open)
    ranges.push(open
      ? Decoration.widget({ widget, block: true, side: 1 }).range(line.to)
      : Decoration.replace({ widget, block: true }).range(line.from, line.to))
  }
  return Decoration.set(ranges, true)
}

/**
 * Lines are found again only when the text, the parse or the vault's pictures change;
 * a caret move only decides which of them show their source.
 */
const imageField = StateField.define<{ lines: ImageLine[]; decorations: DecorationSet }>({
  create: (state) => {
    const lines = imageLines(state)
    return { lines, decorations: imageDecorations(state, lines) }
  },
  update: (value, transaction) => {
    const { state } = transaction
    const relist = transaction.docChanged || transaction.reconfigured || syntaxTree(transaction.startState) !== syntaxTree(state)
    if (relist) {
      const lines = imageLines(state)
      return { lines, decorations: imageDecorations(state, lines) }
    }
    const moved = transaction.selection !== undefined || transaction.effects.some((effect) => effect.is(setFocus))
    return moved ? { lines: value.lines, decorations: imageDecorations(state, value.lines) } : value
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
})

/** The image line a widget's DOM belongs to, read fresh: the text may have moved since it drew. */
function lineOf(view: EditorView, dom: HTMLElement): ImageLine | null {
  const pos = view.posAtDOM(dom)
  return view.state.field(imageField).lines.find((line) => pos >= line.from && pos <= line.to) ?? null
}

/** Moves one image line before the line that starts at `at` (or to the end at `doc.length`). */
export function moveLine(state: EditorState, line: { from: number; to: number }, at: number) {
  const { doc } = state
  const text = doc.sliceString(line.from, line.to)
  if (at >= line.from && at <= line.to + 1) return null
  const remove = line.to < doc.length ? { from: line.from, to: line.to + 1 } : { from: Math.max(0, line.from - 1), to: line.to }
  const insert = at >= doc.length && doc.length > 0 && doc.sliceString(doc.length - 1) !== '\n' ? `\n${text}` : `${text}\n`
  return { changes: [{ ...remove, insert: '' }, { from: at, insert }] }
}

/** Where a picture dropped at `y` (client pixels) goes: the start of a line, before or after the one under the pointer. */
function dropTarget(view: EditorView, y: number): { at: number; top: number } {
  const height = y - view.documentTop
  const block = view.lineBlockAtHeight(Math.max(0, height))
  const after = height > block.top + block.height / 2
  const doc = view.state.doc
  const last = doc.lineAt(block.to)
  const at = after ? (last.number < doc.lines ? doc.line(last.number + 1).from : doc.length) : block.from
  return { at, top: after ? block.bottom : block.top }
}

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY
    if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) return node
  }
  return null
}

interface NoteImageProps {
  view: EditorView
  dom: HTMLElement
  src: string
  alt: string
  width: number | null
  revealed: boolean
}

function NoteImage({ view, dom, src, alt, width, revealed: open }: NoteImageProps) {
  const [zoomed, setZoomed] = useState(false)
  const [failed, setFailed] = useState(false)
  const label = alt === '' ? 'image' : alt

  // A press either becomes a drag (past the slop) or, released in place, opens the picture.
  const press = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || view.state.readOnly) return
    event.preventDefault()
    const picture = event.currentTarget
    const startX = event.clientX
    const startY = event.clientY
    let dragging = false
    let target: { at: number; top: number } | null = null
    let lastY = startY
    let frame = 0
    const marker = view.dom.ownerDocument.createElement('div')
    marker.className = 'cm-manor-image-drop'
    const scroller = scrollParent(view.dom)

    const place = () => {
      target = dropTarget(view, lastY)
      const base = view.dom.getBoundingClientRect().top
      marker.style.top = `${target.top + view.documentTop - base - 1}px`
    }
    // Near the scroller's edge the note scrolls under the drag, so a picture can travel far.
    const edgeScroll = () => {
      frame = 0
      if (!dragging || scroller === null || !picture.isConnected) return
      const box = scroller.getBoundingClientRect()
      const speed = lastY < box.top + 48 ? -12 : lastY > box.bottom - 48 ? 12 : 0
      if (speed === 0) return
      scroller.scrollTop += speed
      place()
      frame = requestAnimationFrame(edgeScroll)
    }
    const move = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== event.pointerId) return
      lastY = moveEvent.clientY
      if (!dragging) {
        if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < DRAG_SLOP) return
        dragging = true
        dom.classList.add('cm-manor-image-dragging')
        view.dom.append(marker)
      }
      place()
      if (frame === 0) frame = requestAnimationFrame(edgeScroll)
    }
    const doc = view.dom.ownerDocument
    const end = (upEvent: PointerEvent) => {
      if (upEvent.pointerId !== event.pointerId) return
      if (picture.hasPointerCapture(upEvent.pointerId)) picture.releasePointerCapture(upEvent.pointerId)
      doc.removeEventListener('pointermove', move)
      doc.removeEventListener('pointerup', end)
      doc.removeEventListener('pointercancel', end)
      if (frame !== 0) cancelAnimationFrame(frame)
      marker.remove()
      dom.classList.remove('cm-manor-image-dragging')
      if (!dragging) {
        if (upEvent.type === 'pointerup') setZoomed(true)
        return
      }
      // A picture redrawn away mid-drag has no line left to move.
      const line = picture.isConnected ? lineOf(view, dom) : null
      if (line === null || target === null || upEvent.type !== 'pointerup') return
      const spec = moveLine(view.state, line, target.at)
      if (spec === null) return
      view.dispatch({ ...spec, annotations: [Transaction.userEvent.of('move.drop'), ownStep], scrollIntoView: false })
    }
    // Captured events bubble to the document, and so do the ones after a redraw removed the picture.
    picture.setPointerCapture(event.pointerId)
    doc.addEventListener('pointermove', move)
    doc.addEventListener('pointerup', end)
    doc.addEventListener('pointercancel', end)
  }

  // The width follows the pointer live; the embed is rewritten once, on release.
  const resize = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || view.state.readOnly) return
    event.preventDefault()
    event.stopPropagation()
    const handle = event.currentTarget
    const figure = handle.parentElement
    if (figure === null) return
    const column = dom.clientWidth
    const start = figure.getBoundingClientRect().width
    const startX = event.clientX
    let next = start
    const move = (moveEvent: PointerEvent) => {
      next = Math.round(Math.min(column, Math.max(MIN_WIDTH, start + moveEvent.clientX - startX)))
      figure.style.width = `${next}px`
    }
    const end = (upEvent: PointerEvent) => {
      handle.releasePointerCapture(upEvent.pointerId)
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', end)
      handle.removeEventListener('pointercancel', end)
      dom.classList.remove('cm-manor-image-resizing')
      const line = lineOf(view, dom)
      if (line === null || upEvent.type !== 'pointerup' || Math.abs(next - start) < 1) {
        figure.style.width = width === null ? '' : `${width}px`
        return
      }
      const source = view.state.doc.sliceString(0, view.state.doc.length)
      view.dispatch({
        changes: { from: line.embed.from, to: line.embed.to, insert: embedWithWidth(source, line.embed, next) },
        annotations: [Transaction.userEvent.of('input.resize'), ownStep],
      })
    }
    dom.classList.add('cm-manor-image-resizing')
    handle.setPointerCapture(event.pointerId)
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', end)
    handle.addEventListener('pointercancel', end)
  }

  // A click beside the picture puts the caret on its line, which shows the source.
  const edit = (event: React.MouseEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget || view.state.readOnly) return
    event.preventDefault()
    const line = lineOf(view, dom)
    if (line === null) return
    view.dispatch({ selection: { anchor: line.embed.to } })
    view.focus()
  }

  if (failed) {
    return (
      <div className="cm-manor-image-row" onMouseDown={edit}>
        <span className="cm-manor-image-failed">{`${label} could not be loaded`}</span>
      </div>
    )
  }
  return (
    <div className={`cm-manor-image-row${open ? ' cm-manor-image-open' : ''}`} onMouseDown={edit}>
      <figure className="cm-manor-image-figure" style={width === null ? undefined : { width: `${width}px` }}>
        <img
          src={src}
          alt={alt}
          draggable={false}
          role="button"
          tabIndex={0}
          aria-label={`Enlarge ${label}. Drag to move it.`}
          title="Click to enlarge, drag to move"
          className="cm-manor-image"
          onPointerDown={press}
          onKeyDown={(event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return
            event.preventDefault()
            setZoomed(true)
          }}
          // The picture's height arrives with its bytes; the height map has to hear about it.
          onLoad={() => view.requestMeasure()}
          onError={() => setFailed(true)}
        />
        {view.state.readOnly ? null : (
          <span
            className="cm-manor-image-handle"
            role="separator"
            aria-orientation="vertical"
            aria-label={`Resize ${label}`}
            title="Drag to resize"
            onPointerDown={resize}
          />
        )}
      </figure>
      {zoomed ? <ImageLightbox src={src} alt={alt} className="" onClose={() => setZoomed(false)} /> : null}
    </div>
  )
}

const roots = new WeakMap<HTMLElement, Root>()

class ImageWidget extends WidgetType {
  constructor(
    private readonly src: string,
    private readonly alt: string,
    private readonly width: number | null,
    private readonly open: boolean,
  ) {
    super()
  }

  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt && other.width === this.width && other.open === this.open
  }

  get estimatedHeight() {
    return 240
  }

  toDOM(view: EditorView) {
    const wrap = view.dom.ownerDocument.createElement('div')
    wrap.className = 'cm-manor-image-block'
    roots.set(wrap, createRoot(wrap))
    this.updateDOM(wrap, view)
    return wrap
  }

  updateDOM(dom: HTMLElement, view: EditorView) {
    const root = roots.get(dom)
    if (root === undefined) return false
    root.render(<NoteImage key={this.src} view={view} dom={dom} src={this.src} alt={this.alt} width={this.width} revealed={this.open} />)
    return true
  }

  destroy(dom: HTMLElement) {
    roots.get(dom)?.unmount()
    roots.delete(dom)
  }

  // A file dragged onto a picture still reaches the note's drop handler; the browser would open it otherwise.
  ignoreEvent(event: Event) {
    return event.type !== 'dragover' && event.type !== 'drop'
  }
}

/**
 * Up and Down stop on a picture's line instead of jumping the block, so the keyboard
 * reaches its source the way a click beside it does.
 */
function stepOntoPicture(view: EditorView, forward: boolean): boolean {
  const { selection, doc } = view.state
  if (selection.ranges.length > 1 || !selection.main.empty) return false
  const number = doc.lineAt(selection.main.head).number + (forward ? 1 : -1)
  if (number < 1 || number > doc.lines) return false
  const next = doc.line(number)
  if (!view.state.field(imageField).lines.some((line) => line.from === next.from)) return false
  const target = view.moveVertically(selection.main, forward)
  if (target.head >= next.from && target.head <= next.to) return false
  view.dispatch({ selection: { anchor: next.to }, scrollIntoView: true, userEvent: 'select' })
  return true
}

const pictureKeys = Prec.high(keymap.of([
  { key: 'ArrowDown', run: (view) => stepOntoPicture(view, true) },
  { key: 'ArrowUp', run: (view) => stepOntoPicture(view, false) },
]))

// ---------------------------------------------------------------------------
// Paste and drop: the file is saved first, and the embed lands where it was asked for.
// ---------------------------------------------------------------------------

interface PendingImage {
  id: string
  /** The range the picture replaces: a pasted-over selection, or empty at the caret or drop point. */
  from: number
  to: number
  error?: string
}

/** Pins a save's chip to the range its picture replaces; `sendPictures` adds one per file. */
export const addPending = StateEffect.define<PendingImage>()
const settlePending = StateEffect.define<{ id: string; error?: string }>()
const dismissPending = StateEffect.define<string>()

/** Saves in flight (and refusals not yet dismissed), each pinned to the spot it lands, mapped through edits. */
const pendingField = StateField.define<PendingImage[]>({
  create: () => [],
  update: (value, transaction) => {
    let next = transaction.docChanged
      ? value.map((item) => {
        // Text written inside the selection a picture was pasted over is kept; the picture lands after it.
        let inside = false
        transaction.changes.iterChangedRanges((fromA, toA) => { if (fromA < item.to && toA > item.from) inside = true })
        if (inside) {
          const end = transaction.changes.mapPos(item.to, 1)
          return { ...item, from: end, to: end }
        }
        const from = transaction.changes.mapPos(item.from, 1)
        return { ...item, from, to: Math.max(from, transaction.changes.mapPos(item.to, -1)) }
      })
      : value
    for (const effect of transaction.effects) {
      if (effect.is(addPending)) next = [...next, effect.value]
      else if (effect.is(settlePending)) {
        const { id, error } = effect.value
        next = error === undefined ? next.filter((item) => item.id !== id) : next.map((item) => (item.id === id ? { ...item, error } : item))
      } else if (effect.is(dismissPending)) next = next.filter((item) => item.id !== effect.value)
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field, (items) =>
    Decoration.set(items.map((item) => Decoration.widget({ widget: new PendingWidget(item.id, item.error ?? null), side: 1 }).range(item.to)), true)),
})

class PendingWidget extends WidgetType {
  constructor(private readonly id: string, private readonly error: string | null) {
    super()
  }

  eq(other: PendingWidget) {
    return other.id === this.id && other.error === this.error
  }

  toDOM(view: EditorView) {
    const chip = view.dom.ownerDocument.createElement('span')
    chip.className = `cm-manor-image-pending${this.error === null ? '' : ' cm-manor-image-pending-error'}`
    chip.setAttribute('role', 'status')
    chip.textContent = this.error === null ? 'Saving image…' : `${this.error} Click to dismiss.`
    if (this.error !== null) {
      chip.style.cursor = 'pointer'
      chip.addEventListener('mousedown', (event) => {
        event.preventDefault()
        view.dispatch({ effects: dismissPending.of(this.id) })
      })
    }
    return chip
  }

  ignoreEvent() {
    return this.error !== null
  }
}


/**
 * Lands a saved picture where its paste or drop asked, on a line of its own so it draws
 * as a block, with the caret on the line after it.
 */
export function landImage(view: EditorView, id: string, result: { status: 'saved'; name: string } | { status: 'rejected'; message: string }) {
  const spec = landing(view.state, id, result)
  if (spec !== null) view.dispatch(spec)
}

/** The transaction that lands a save's answer, or null when no chip waits for it. */
export function landing(state: EditorState, id: string, result: { status: 'saved'; name: string } | { status: 'rejected'; message: string }): TransactionSpec | null {
  const item = state.field(pendingField).find((entry) => entry.id === id)
  if (item === undefined) return null
  if (result.status === 'rejected') return { effects: settlePending.of({ id, error: result.message }) }
  const line = state.doc.lineAt(item.from)
  // A line right under a table reads as one more row, so a blank line keeps the picture out.
  const above = item.from > line.from ? line : line.number > 1 ? state.doc.line(line.number - 1) : null
  const table = above === null ? null : enclosing(state, above.to, TABLES)
  const underTable = above !== null && table !== null && table.to <= above.to
  const before = `${item.from > line.from ? '\n' : ''}${underTable ? '\n' : ''}`
  const insert = `${before}![[${result.name}]]\n`
  return {
    changes: { from: item.from, to: item.to, insert },
    selection: { anchor: item.from + insert.length },
    effects: settlePending.of({ id }),
    annotations: [Transaction.userEvent.of('input.paste'), ownStep],
    scrollIntoView: true,
  }
}

/** Obsidian's own name for a pasted picture, so a paste here reads the same in the vault. */
function pastedName(type: string, now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  const extension = type === 'image/jpeg' ? 'jpg' : type.slice('image/'.length)
  return `Pasted image ${stamp}.${extension}`
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('unreadable')))
    reader.onerror = () => reject(reader.error ?? new Error('unreadable'))
    reader.readAsDataURL(file)
  })
}

function pictures(files: FileList | undefined | null): File[] {
  return [...(files ?? [])].filter((file) => SAVE_TYPES.has(file.type))
}

function sendPictures(view: EditorView, files: File[], from: number, to: number, pasted: boolean) {
  const config = view.state.facet(noteImageConfig)
  if (config === null || config.save === null) return
  // Several pictures replace a selection once: the first takes it, the rest follow it.
  let range = { from, to }
  for (const file of files) {
    const id = `image-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    view.dispatch({ effects: addPending.of({ id, ...range }) })
    range = { from: to, to }
    if (file.size > MAX_VAULT_IMAGE_BYTES) {
      view.dispatch({ effects: settlePending.of({ id, error: `Pictures up to ${MAX_VAULT_IMAGE_BYTES / 1024 / 1024} MB can be added.` }) })
      continue
    }
    const name = pasted || file.name === '' || file.name.length > MAX_VAULT_IMAGE_NAME ? pastedName(file.type) : file.name
    const waiting = () => view.state.field(pendingField).some((item) => item.id === id && item.error === undefined)
    void readDataUrl(file).then((dataUrl) => {
      // The note may have closed while the file was read; then nothing is sent.
      if (!view.dom.isConnected || !waiting()) return
      const sent = view.state.facet(noteImageConfig)?.save?.(id, name, dataUrl) ?? false
      if (!sent) {
        view.dispatch({ effects: settlePending.of({ id, error: 'The picture could not be sent. Check the connection.' }) })
        return
      }
      // A lost connection never answers, so the chip does not wait forever.
      setTimeout(() => {
        if (waiting()) view.dispatch({ effects: settlePending.of({ id, error: 'The Mac did not answer, so the picture may not be saved.' }) })
      }, ANSWER_TIMEOUT_MS)
    }, () => view.dispatch({ effects: settlePending.of({ id, error: 'That picture could not be read.' }) }))
  }
}

const WHOLE_BLOCKS: ReadonlySet<string> = new Set([...CODE_NODES, 'Table', 'SetextHeading1', 'SetextHeading2'])
const TABLES: ReadonlySet<string> = new Set(['Table'])

/**
 * Where a dropped picture lands for a drop over `pos`: on the line after the one under the
 * pointer, so it never splits a line. A table, code block or underlined heading counts as
 * one line, and a drop on the properties lands after them.
 */
export function dropSpot(state: EditorState, pos: number): number {
  const meta = frontmatterRange(state)
  if (meta !== null && pos <= meta.to) return Math.min(meta.to + 1, state.doc.length)
  const under = state.doc.lineAt(pos)
  const line = state.doc.lineAt(enclosing(state, under.to, WHOLE_BLOCKS)?.to ?? under.to)
  return Math.min(line.to + 1, state.doc.length)
}

/** Takes the pictures among files dropped on the note, at `dropSpot` of the pointer. */
export function dropPictures(view: EditorView, event: DragEvent): boolean {
  const files = pictures(event.dataTransfer?.files)
  if (files.length === 0 || view.state.readOnly || view.state.facet(noteImageConfig)?.save == null) return false
  event.preventDefault()
  const pos = dropSpot(view.state, view.posAtCoords({ x: event.clientX, y: event.clientY }, false))
  sendPictures(view, files, pos, pos, false)
  return true
}

/**
 * For the scrolling page around a note: the editor only hears drags over its text, so a
 * file dragged into the margin or below a short note would otherwise open in the window.
 */
export function pageFileDrag(page: HTMLElement, event: DragEvent) {
  // React also bubbles drags from portaled layers, such as the comment field, through here.
  if (event.defaultPrevented || !(event.target instanceof Node) || !page.contains(event.target)) return
  if (!event.dataTransfer?.types.includes('Files')) return
  const editor = page.querySelector<HTMLElement>('.cm-editor')
  const view = editor === null ? null : EditorView.findFromDOM(editor)
  if (view === null || view.state.readOnly) return
  event.preventDefault()
  if (event.type === 'drop') dropPictures(view, event)
}

const pasteAndDrop = EditorView.domEventHandlers({
  // Without this the browser opens a dropped file itself instead of handing it to the note.
  dragover(event, view) {
    if (view.state.readOnly || !event.dataTransfer?.types.includes('Files')) return false
    event.preventDefault()
    return false
  },
  paste(event, view) {
    const files = pictures(event.clipboardData?.files)
    if (files.length === 0 || view.state.readOnly || view.state.facet(noteImageConfig)?.save == null) return false
    event.preventDefault()
    const { main } = view.state.selection
    sendPictures(view, files, main.from, main.to, true)
    return true
  },
  drop: (event, view) => dropPictures(view, event),
})

const imageTheme = EditorView.theme({
  '.cm-manor-image-block': { maxWidth: '46rem', marginLeft: 'auto', marginRight: 'auto', padding: '6px 0' },
  '.cm-manor-image-row': { display: 'flex', minWidth: '0', cursor: 'text' },
  '.cm-manor-image-open': { paddingTop: '2px' },
  '.cm-manor-image-figure': { position: 'relative', margin: '0', maxWidth: '100%', minWidth: `${MIN_WIDTH}px`, lineHeight: '0' },
  '.cm-manor-image': {
    display: 'block',
    width: '100%',
    maxWidth: '100%',
    height: 'auto',
    borderRadius: 'var(--radius-lg)',
    cursor: 'grab',
    userSelect: 'none',
    touchAction: 'none',
  },
  '.cm-manor-image:focus-visible': { outline: '2px solid var(--accent-fg)', outlineOffset: '2px' },
  '.cm-manor-image-dragging .cm-manor-image': { opacity: '0.45', cursor: 'grabbing' },
  // Hangs inside the right edge, shown on hover and while dragging.
  '.cm-manor-image-handle': {
    position: 'absolute',
    top: '50%',
    right: '6px',
    width: '6px',
    height: '40px',
    maxHeight: 'calc(100% - 12px)',
    transform: 'translateY(-50%)',
    borderRadius: '999px',
    background: 'var(--color-surface)',
    boxShadow: '0 0 0 1px var(--color-line)',
    cursor: 'ew-resize',
    opacity: '0',
    touchAction: 'none',
    transition: 'opacity 120ms ease-out',
  },
  '.cm-manor-image-figure:hover .cm-manor-image-handle, .cm-manor-image-resizing .cm-manor-image-handle': { opacity: '1' },
  '@media (prefers-reduced-motion: reduce)': { '.cm-manor-image-handle': { transition: 'none' } },
  '.cm-manor-image-drop': {
    position: 'absolute',
    left: '0',
    right: '0',
    height: '2px',
    borderRadius: '1px',
    background: 'var(--accent)',
    pointerEvents: 'none',
    zIndex: '2',
  },
  '.cm-manor-image-failed': { fontSize: '13px', lineHeight: '20px', color: 'var(--color-muted)' },
  '.cm-manor-image-pending': {
    display: 'inline-block',
    marginLeft: '4px',
    padding: '0 8px',
    borderRadius: 'var(--radius-md)',
    background: 'var(--color-surface-2)',
    color: 'var(--color-muted)',
    fontSize: '12px',
    lineHeight: '20px',
  },
  '.cm-manor-image-pending-error': { color: 'var(--color-danger)' },
})

/** Everything the note editor needs for pictures; `noteImageConfig` comes from the editor. */
export const noteImageExtensions = () => [
  focusField,
  EditorView.focusChangeEffect.of((_state, focusing) => setFocus.of(focusing)),
  imageField,
  pictureKeys,
  pendingField,
  pasteAndDrop,
  imageTheme,
]
