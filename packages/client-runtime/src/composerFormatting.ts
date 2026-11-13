export interface TextSelection {
  text: string
  selectionStart: number
  selectionEnd: number
}

/** Turns a newly typed Markdown bullet shortcut into the composer's visible marker. */
export function startComposerList(text: string, caret: number): TextSelection | null {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1
  const beforeCaret = text.slice(lineStart, caret)
  const match = /^(\s*)- $/.exec(beforeCaret)
  if (!match) return null

  const indent = match[1] ?? ''
  const markerStart = lineStart + indent.length
  const nextText = `${text.slice(0, markerStart)}• ${text.slice(caret)}`
  const nextCaret = markerStart + 2
  return { text: nextText, selectionStart: nextCaret, selectionEnd: nextCaret }
}

/** The transcript stores portable Markdown, not the composer's typographic bullet. */
export function normalizeComposerLists(text: string) {
  return text.replace(/^(\s*)• /gm, '$1- ')
}

/** Continues a bullet list on Shift + Enter, or leaves it when the item is empty. */
export function continueComposerList(text: string, caret: number): TextSelection | null {
  const lineStart = text.lastIndexOf('\n', caret - 1) + 1
  const beforeCaret = text.slice(lineStart, caret)
  const match = /^(\s*)([-*+•])\s+(.*)$/.exec(beforeCaret)
  if (!match) return null

  const indent = match[1] ?? ''
  const marker = match[2] ?? ''
  const content = match[3] ?? ''
  const lineEnd = text.indexOf('\n', caret)
  const afterCaret = text.slice(caret, lineEnd === -1 ? text.length : lineEnd)

  if (content.trim() === '' && afterCaret.trim() === '') {
    const nextText = `${text.slice(0, lineStart)}${indent}${text.slice(caret)}`
    const nextCaret = lineStart + indent.length
    return { text: nextText, selectionStart: nextCaret, selectionEnd: nextCaret }
  }

  const nextMarker = marker === '•' ? '•' : '-'
  const inserted = `\n${indent}${nextMarker} `
  const nextCaret = caret + inserted.length
  return {
    text: `${text.slice(0, caret)}${inserted}${text.slice(caret)}`,
    selectionStart: nextCaret,
    selectionEnd: nextCaret,
  }
}

/**
 * Where the caret sits after an edit, read from the two strings alone. The common
 * prefix and the common suffix bracket what actually moved, which is exact until
 * the inserted character also sits next to an identical one — typing Enter at the
 * end of `• item` in `• item\nnext` is indistinguishable from typing it one
 * character later. `composerCaret` resolves that with the caret the input reported
 * before the edit; this is the fallback for everything it cannot vouch for.
 */
export function caretAfterEdit(previous: string, next: string): number {
  const max = Math.min(previous.length, next.length)
  let head = 0
  while (head < max && previous[head] === next[head]) head += 1
  let tail = 0
  while (tail < max - head && previous[previous.length - 1 - tail] === next[next.length - 1 - tail]) tail += 1
  return next.length - tail
}

/**
 * Where the caret sits after an edit, preferring the caret the input reported
 * before it. A native input fires its change before its selection change, so
 * `before` is where the caret stood when the key was pressed; it is only trusted
 * where the two strings prove the edit was exactly one character typed there,
 * which is the case the diff cannot resolve on its own. Everything else — a
 * backspace, a paste, an autocorrect replacing a whole word — falls back to the
 * diff, which handles those exactly.
 *
 * `before` must be a collapsed caret. Replacing a selection can grow the text by
 * one character while leaving both ends of it intact, which reads here as a single
 * character typed at the selection's start; the caller withholds the value instead.
 */
export function composerCaret(previous: string, next: string, before?: number): number {
  if (
    before !== undefined &&
    before >= 0 &&
    before <= previous.length &&
    next.length === previous.length + 1 &&
    next.slice(0, before) === previous.slice(0, before) &&
    next.slice(before + 1) === previous.slice(before)
  ) {
    return before + 1
  }
  return caretAfterEdit(previous, next)
}

/**
 * One keystroke's worth of composer text with the list rules already applied: a
 * newline inside a list item continues it, an empty item ends the list, and `- `
 * at the head of a line opens one.
 *
 * This is the phone's whole formatting path, because a native input hands over a
 * string and nothing else. The Mac keeps the same two rules in separate handlers,
 * where a browser gives it a selection with every event and Enter means send.
 */
export function editComposerText(previous: string, next: string, before?: number): TextSelection {
  const caret = composerCaret(previous, next, before)
  if (next.length - previous.length === 1 && next[caret - 1] === '\n') {
    const continued = continueComposerList(previous, caret - 1)
    if (continued) return continued
  }
  return startComposerList(next, caret) ?? { text: next, selectionStart: caret, selectionEnd: caret }
}
