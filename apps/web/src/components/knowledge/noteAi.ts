import { Annotation, EditorState, StateEffect, StateField, type Extension, type Range, type Text } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'

/**
 * AI edits of a note, as a proposal the editor shows and never holds. The buffer is
 * what autosave writes, so proposed text stays out of it: the old text is decorated
 * where it stands and the new text is a widget beside it. Only accepting turns a
 * proposal into document changes, after the save has gone through.
 */

/** One replacement in the note: `insert` goes where `from` to `to` stands now. */
export interface NoteChange {
  from: number
  to: number
  insert: string
}

interface Span {
  from: number
  to: number
}

/** The proposed note: every change applied at once, each offset read against `text`. */
export function applyChanges(text: string, changes: readonly NoteChange[]): string {
  let out = ''
  let at = 0
  for (const change of [...changes].sort((a, b) => a.from - b.from)) {
    out += text.slice(at, change.from) + change.insert
    at = change.to
  }
  return out + text.slice(at)
}

/** Where each inserted text ends up once all changes are applied, for the settle tint. */
export function insertedSpans(changes: readonly NoteChange[]): Span[] {
  let shift = 0
  return [...changes].sort((a, b) => a.from - b.from).flatMap((change) => {
    const from = change.from + shift
    shift += change.insert.length - (change.to - change.from)
    return change.insert === '' ? [] : [{ from, to: from + change.insert.length }]
  })
}

/** What opens a markdown line before its text: indent, a list marker, a task box, a heading or quote mark. */
const LINE_MARK = /^\s*(?:(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?|#{1,6}\s+|>\s?)/

/**
 * The edited note as changes against the one it came from, by line: a rewritten
 * paragraph is one change, an added one an insertion, a dropped one a deletion. Lines
 * the model left alone are not touched, so `applyChanges` gives back exactly `after`.
 */
export function diffNote(before: string, after: string): NoteChange[] {
  if (before === after) return []
  const a = before.split('\n')
  const b = after.split('\n')
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1

  // Where each line of `before` starts; one past the end stands for the end of the note.
  const starts: number[] = [0]
  for (const line of a) starts.push(starts[starts.length - 1]! + line.length + 1)
  const changes: NoteChange[] = []
  const hunk = (i0: number, i1: number, j0: number, j1: number) => {
    if (i0 === i1 && j0 === j1) return
    const lines = b.slice(j0, j1)
    if (i0 === i1) {
      // Added lines go in front of the line that follows them, or after the last one.
      if (i0 < a.length) changes.push({ from: starts[i0]!, to: starts[i0]!, insert: `${lines.join('\n')}\n` })
      else changes.push({ from: before.length, to: before.length, insert: `\n${lines.join('\n')}` })
    } else if (j0 === j1) {
      // Dropped lines take one line break with them: their own, or the one before the last.
      if (i1 < a.length) changes.push({ from: starts[i0]!, to: starts[i1]!, insert: '' })
      else changes.push({ from: Math.max(0, starts[i0]! - 1), to: before.length, insert: '' })
    } else if (i1 - i0 === j1 - j0) {
      // Rewritten in place, line for line: one change each, so each reads as its own diff.
      for (let k = 0; k < i1 - i0; k += 1) {
        const was = a[i0 + k]!
        const now = b[j0 + k]!
        if (was === now) continue
        // A list marker or heading mark both lines share stays out of the diff: the live
        // preview draws it as a bullet, and the proposed text would show it raw beside that.
        const mark = LINE_MARK.exec(was)?.[0] ?? ''
        const skip = mark !== '' && now.startsWith(mark) && now.length > mark.length && was.length > mark.length ? mark.length : 0
        changes.push({ from: starts[i0 + k]! + skip, to: starts[i0 + k]! + was.length, insert: now.slice(skip) })
      }
    } else {
      changes.push({ from: starts[i0]!, to: starts[i1]! - 1, insert: lines.join('\n') })
    }
  }

  const n = a.length - head - tail
  const m = b.length - head - tail
  // Longest common subsequence over the lines between the shared head and tail. A note
  // is a few hundred lines; past this the table is not worth it and the middle is one hunk.
  if (n * m > 4_000_000) {
    hunk(head, head + n, head, head + m)
    return changes
  }
  const width = m + 1
  const table = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = a[head + i] === b[head + j]
        ? table[(i + 1) * width + j + 1]! + 1
        : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
    }
  }
  let i = 0
  let j = 0
  let i0 = 0
  let j0 = 0
  while (i < n && j < m) {
    if (a[head + i] === b[head + j]) {
      hunk(head + i0, head + i, head + j0, head + j)
      i += 1
      j += 1
      i0 = i
      j0 = j
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) i += 1
    else j += 1
  }
  hunk(head + i0, head + n, head + j0, head + m)
  return changes
}

/** Every line that has text, the ranges the whole-note job shimmers over. */
export function textLines(doc: Text): Span[] {
  const spans: Span[] = []
  for (let number = 1; number <= doc.lines; number += 1) {
    const line = doc.line(number)
    if (line.text.trim() !== '') spans.push({ from: line.from, to: line.to })
  }
  return spans
}

// ---------------------------------------------------------------------------
// What the editor shows of it.

export type NoteAiMarks =
  /** The passage a comment is being written on. */
  | { kind: 'anchor'; spans: readonly Span[] }
  /** Text the model is working on. */
  | { kind: 'working'; spans: readonly Span[] }
  /** The inline diff. `leaving` fades the old text, the first half of accepting. */
  | { kind: 'proposal'; changes: readonly NoteChange[]; leaving: boolean }
  /** Accepted text, while its tint fades. */
  | { kind: 'settled'; spans: readonly Span[] }

/** Replaces what is marked; null clears it. Positions are read against the new document. */
export const noteAiMarks = StateEffect.define<NoteAiMarks | null>()

/** On the transaction that applies an accepted proposal, so it is not taken for an outside edit. */
export const noteAiApply = Annotation.define<boolean>()

/** Holds the note still while a job or a proposal is out: its offsets are read against this text. */
export const noteAiLock = StateEffect.define<boolean>()

const lockField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    let next = value
    for (const effect of tr.effects) {
      if (effect.is(noteAiLock)) next = effect.value
    }
    return next
  },
  provide: (field) => EditorState.readOnly.from(field),
})

class NewText extends WidgetType {
  constructor(readonly text: string, readonly beside: boolean) {
    super()
  }

  eq(other: NewText) {
    return other.text === this.text && other.beside === this.beside
  }

  toDOM() {
    const span = window.document.createElement('span')
    const block = !this.beside && /^\n|\n$/.test(this.text)
    span.className = `cm-manor-ai-new${this.beside ? ' cm-manor-ai-new-beside' : ''}${block ? ' cm-manor-ai-new-block' : ''}`
    // Whitespace stays text and every word is its own span, so each settles in after the last.
    this.text.replace(/^\n|\n$/g, '').split(/(\s+)/).forEach((part, index) => {
      if (part === '') return
      if (/^\s+$/.test(part)) {
        span.append(part)
        return
      }
      const word = window.document.createElement('span')
      word.className = 'reveal-word reveal-word-new'
      word.style.animationDelay = `${Math.min(index * 11, 1_200)}ms`
      word.style.animationFillMode = 'backwards'
      word.textContent = part
      span.append(word)
    })
    return span
  }

  ignoreEvent() {
    return true
  }
}

const anchorMark = Decoration.mark({ class: 'cm-manor-ai-anchor' })
const workingMark = Decoration.mark({ class: 'shimmer-prose' })
const oldMark = Decoration.mark({ class: 'cm-manor-ai-old' })
const leavingMark = Decoration.mark({ class: 'cm-manor-ai-old cm-manor-ai-leaving' })
const settledMark = Decoration.mark({ class: 'cm-manor-ai-settled' })

function decorate(marks: NoteAiMarks | null, length: number): DecorationSet {
  if (marks === null) return Decoration.none
  const inside = (span: Span) => span.from < span.to && span.to <= length
  if (marks.kind !== 'proposal') {
    const mark = marks.kind === 'anchor' ? anchorMark : marks.kind === 'working' ? workingMark : settledMark
    return Decoration.set(marks.spans.filter(inside).map((span) => mark.range(span.from, span.to)), true)
  }
  const ranges: Range<Decoration>[] = []
  for (const change of marks.changes) {
    if (change.to > length) continue
    if (change.from < change.to) ranges.push((marks.leaving ? leavingMark : oldMark).range(change.from, change.to))
    if (change.insert !== '') ranges.push(Decoration.widget({ widget: new NewText(change.insert, change.from < change.to), side: 1 }).range(change.to))
  }
  return Decoration.set(ranges, true)
}

export const noteAiField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let next = tr.docChanged ? value.map(tr.changes) : value
    for (const effect of tr.effects) {
      if (effect.is(noteAiMarks)) next = decorate(effect.value, tr.newDoc.length)
    }
    return next
  },
  provide: (field) => EditorView.decorations.from(field),
})

const tint = (token: string, share: number) => `color-mix(in srgb, var(${token}) ${share}%, transparent)`

// `shimmer-prose`, the word reveal and the settle keyframes live in styles.css, beside
// the label shimmer and the reply reveal they share their motion with.
const noteAiTheme = EditorView.theme({
  '.cm-manor-ai-anchor': { backgroundColor: 'var(--color-user-bg)', borderRadius: 'var(--radius-xs)' },
  '.cm-manor-ai-old': {
    color: 'var(--color-dim)',
    textDecoration: 'line-through',
    textDecorationColor: tint('--color-danger', 60),
    transition: 'opacity 220ms var(--ease-arrive)',
  },
  '.cm-manor-ai-old *': { color: 'inherit' },
  '.cm-manor-ai-leaving': { opacity: '0' },
  '.cm-manor-ai-new': { backgroundColor: tint('--color-ok', 13), borderRadius: 'var(--radius-xs)', whiteSpace: 'pre-wrap' },
  '.cm-manor-ai-new-beside': { marginLeft: '0.3em' },
  '.cm-manor-ai-new-block': { display: 'block' },
  '.cm-manor-ai-settled': { borderRadius: 'var(--radius-xs)', animation: 'note-ai-settle 400ms ease both' },
  '@media (prefers-reduced-motion: reduce)': {
    '.cm-manor-ai-old': { transition: 'none' },
    '.cm-manor-ai-settled': { animation: 'none' },
  },
})

export const noteAiExtensions = (): Extension[] => [noteAiField, lockField, noteAiTheme]
