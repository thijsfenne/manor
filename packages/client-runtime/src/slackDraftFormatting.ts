import { slackMentionLabel, splitSlackMentions, type SlackRichText, type SlackRichTextInline } from '@manor/contracts'

export type InlineStyle = NonNullable<Extract<SlackRichTextInline, { type: 'text' }>['style']>
/** Mentions never carry code (Slack's user element rejects it), so they do not count for it. */
const hasStyle = (run: SlackRichTextInline, key: keyof InlineStyle) => key === 'code' ? run.type !== 'user' && run.style?.code === true : run.style?.[key] === true
const counts = (run: SlackRichTextInline, key: keyof InlineStyle) => key !== 'code' || run.type !== 'user'
export type BlockKind = 'paragraph' | 'bullet' | 'ordered' | 'quote' | 'code'
export interface DraftBlock {
  id: number
  group: number
  kind: BlockKind
  indent: number
  number: number
  elements: SlackRichTextInline[]
}
export interface DraftSelection { block: number; start: number; end: number }
let nextId = 0
const block = (kind: BlockKind, elements: SlackRichTextInline[]): DraftBlock => {
  const id = ++nextId
  return { id, group: id, kind, indent: 0, number: 1, elements }
}
export const inlineText = (item: SlackRichTextInline) => item.type === 'user' ? slackMentionLabel(item) : item.type === 'link' ? item.text ?? item.url : item.text
/** A plain-text line with Slack's `<@U…>` syntax turned into real user runs. */
const lineRuns = (line: string): SlackRichTextInline[] => splitSlackMentions(line).map((part) => 'text' in part ? { type: 'text', text: part.text } : { type: 'user', ...part })
export const blockText = (value: DraftBlock) => value.elements.map(inlineText).join('')

export function draftBlocks(body: string, document?: SlackRichText): DraftBlock[] {
  if (!document) return body.split('\n').map((line) => block('paragraph', lineRuns(line)))
  return document.elements.flatMap((element) => {
    if (element.type !== 'rich_text_list') {
      return [block(element.type === 'rich_text_quote' ? 'quote' : element.type === 'rich_text_preformatted' ? 'code' : 'paragraph', element.elements)]
    }
    const group = ++nextId
    return element.elements.map((item, index) => ({
      ...block(element.style, item.elements), group, indent: element.indent ?? 0, number: (element.offset ?? 0) + index + 1,
    }))
  })
}

/** Empty editing rows remain visible; Slack requires a nonempty text node. */
const nonempty = (elements: SlackRichTextInline[]): SlackRichTextInline[] => elements.length ? elements : [{ type: 'text', text: '\n' }]
export function draftDocument(blocks: DraftBlock[]): SlackRichText {
  const elements: SlackRichText['elements'] = []
  for (const [index, item] of blocks.entries()) {
    const runs = nonempty(item.elements)
    if (item.kind === 'ordered' || item.kind === 'bullet') {
      const previous = elements.at(-1)
      const before = blocks[index - 1]
      if (previous?.type === 'rich_text_list' && before?.group === item.group && previous.style === item.kind && (previous.indent ?? 0) === item.indent && (item.kind === 'bullet' || before.number + 1 === item.number)) {
        previous.elements.push({ type: 'rich_text_section', elements: runs })
      } else {
        elements.push({ type: 'rich_text_list', style: item.kind, indent: item.indent, ...(item.kind === 'ordered' ? { offset: item.number - 1 } : {}), elements: [{ type: 'rich_text_section', elements: runs }] })
      }
    } else if (item.kind === 'code') {
      elements.push({ type: 'rich_text_preformatted', elements: [{ type: 'text', text: blockText(item) || '\n' }] })
    } else {
      elements.push({ type: item.kind === 'quote' ? 'rich_text_quote' : 'rich_text_section', elements: runs })
    }
  }
  return { type: 'rich_text', elements }
}

function compact(elements: SlackRichTextInline[]) {
  const result: SlackRichTextInline[] = []
  for (const item of elements) {
    if (!inlineText(item)) continue
    const previous = result.at(-1)
    if (item.type !== 'user' && previous !== undefined && previous.type !== 'user' && previous.type === item.type && JSON.stringify(previous.style) === JSON.stringify(item.style) && (previous.type !== 'link' || (item.type === 'link' && previous.url === item.url))) {
      result[result.length - 1] = { ...previous, text: inlineText(previous) + inlineText(item) }
    } else result.push(item)
  }
  return result
}
export function sliceInline(elements: SlackRichTextInline[], start: number, end: number): SlackRichTextInline[] {
  let offset = 0
  return elements.flatMap((item): SlackRichTextInline[] => {
    const text = inlineText(item)
    const part = text.slice(Math.max(0, start - offset), Math.max(0, Math.min(text.length, end - offset)))
    offset += text.length
    if (!part) return []
    // A mention is atomic: cutting or editing into it leaves plain text, never a half tag.
    if (item.type === 'user') return part === text ? [item] : [{ type: 'text', text: part, ...(item.style ? { style: item.style } : {}) }]
    return [{ ...item, text: part }]
  })
}

/** Apply the native input's text diff without rebuilding its styled runs or links. */
export function editDraftBlock(blocks: DraftBlock[], selection: DraftSelection, text: string, pending?: InlineStyle, softBreak = false) {
  const item = blocks[selection.block]!
  const previous = blockText(item)
  let start = 0
  while (start < previous.length && start < text.length && previous[start] === text[start]) start++
  let oldEnd = previous.length
  let newEnd = text.length
  while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === text[newEnd - 1]) { oldEnd--; newEnd-- }
  // Selection disambiguates typing beside identical characters, including newlines.
  const insertedLength = text.length - previous.length + selection.end - selection.start
  if (insertedLength >= 0 && text.slice(0, selection.start) === previous.slice(0, selection.start) && text.slice(selection.start + insertedLength) === previous.slice(selection.end)) {
    start = selection.start; oldEnd = selection.end; newEnd = start + insertedLength
  }
  const inserted = text.slice(start, newEnd)
  const inherited = sliceInline(item.elements, Math.max(0, start - 1), start)[0]
  const style = pending ?? inherited?.style
  const following = sliceInline(item.elements, start, start + 1)[0]
  const link = inherited?.type === 'link' && following?.type === 'link' && inherited.url === following.url ? { type: 'link' as const, url: inherited.url } : { type: 'text' as const }
  const middle: SlackRichTextInline[] = inserted ? [{ ...link, text: inserted, ...(style ? { style } : {}) }] : []
  const elements = compact([...sliceInline(item.elements, 0, start), ...middle, ...sliceInline(item.elements, oldEnd, previous.length)])
  const result = [...blocks]
  result[selection.block] = { ...item, elements }
  if (inserted === '\n' && item.kind !== 'code' && !softBreak) return breakDraftBlock(blocks, { ...selection, start, end: oldEnd })
  if (inserted.includes('\n') && inserted !== '\n' && item.kind !== 'code' && !softBreak) {
    let offset = 0
    const rows = text.split('\n').map((line, index) => {
      const row = { ...item, id: index === 0 ? item.id : ++nextId, number: item.number + index, elements: sliceInline(elements, offset, offset + line.length) }
      offset += line.length + 1
      return row
    })
    const caretLines = text.slice(0, newEnd).split('\n')
    const tail = blocks.slice(selection.block + 1).map((row) => row.group === item.group && row.kind === 'ordered' ? { ...row, number: row.number + rows.length - 1 } : row)
    return { blocks: [...blocks.slice(0, selection.block), ...rows, ...tail], selection: { block: selection.block + caretLines.length - 1, start: caretLines.at(-1)!.length, end: caretLines.at(-1)!.length } }
  }
  // Markdown list shortcuts are an editing gesture, not the storage format.
  if (item.kind === 'paragraph' && inserted === ' ') {
    const match = /^(\s*)([-*•]|\d+\.) $/.exec(text)
    if (match) {
      const kind = match[2]!.endsWith('.') ? 'ordered' : 'bullet'
      result[selection.block] = { ...item, kind, number: kind === 'ordered' ? Math.max(1, Math.min(20_001, parseInt(match[2]!, 10))) : 1, indent: Math.min(8, Math.floor(match[1]!.length / 2)), elements: [] }
      return { blocks: result, selection: { ...selection, start: 0, end: 0 } }
    }
  }
  return { blocks: result, selection: { ...selection, start: newEnd, end: newEnd } }
}

/** Both Enter and the toolbar consume the marker without flattening styled content. */
function paragraphListMarker(item: DraftBlock) {
  if (item.kind !== 'paragraph') return null
  const text = blockText(item)
  const match = /^(\s*)([-*•]|\d+\.) (.*)$/s.exec(text)
  if (!match) return null
  const prefix = match[1]!.length + match[2]!.length + 1
  const kind = match[2]!.endsWith('.') ? 'ordered' as const : 'bullet' as const
  return {
    prefix,
    format: {
      kind,
      number: kind === 'ordered' ? Math.max(1, Math.min(20_001, parseInt(match[2]!, 10))) : 1,
      indent: Math.min(8, Math.floor(match[1]!.length / 2)),
      elements: sliceInline(item.elements, prefix, text.length),
    },
  }
}

export function breakDraftBlock(blocks: DraftBlock[], selection: DraftSelection) {
  let item = blocks[selection.block]!
  const marker = paragraphListMarker(item)
  if (marker) {
    item = { ...item, ...marker.format }
    selection = { ...selection, start: Math.max(0, selection.start - marker.prefix), end: Math.max(0, selection.end - marker.prefix) }
  }
  if (!blockText(item).trim() && item.kind !== 'paragraph') {
    const result = [...blocks]
    result[selection.block] = { ...item, kind: 'paragraph', indent: 0, elements: [] }
    return { blocks: result, selection: { ...selection, start: 0, end: 0 } }
  }
  const before = { ...item, elements: sliceInline(item.elements, 0, selection.start) }
  const after = { ...item, id: ++nextId, number: item.number + 1, elements: sliceInline(item.elements, selection.end, blockText(item).length) }
  const tail = blocks.slice(selection.block + 1).map((row) => row.group === item.group && row.kind === 'ordered' ? { ...row, number: row.number + 1 } : row)
  return { blocks: [...blocks.slice(0, selection.block), before, after, ...tail], selection: { block: selection.block + 1, start: 0, end: 0 } }
}

export function joinDraftBlock(blocks: DraftBlock[], index: number) {
  if (index === 0) return { blocks, selection: { block: 0, start: 0, end: 0 } }
  const previous = blocks[index - 1]!
  const item = blocks[index]!
  const caret = blockText(previous).length
  const tail = blocks.slice(index + 1).map((row) => row.group === item.group && row.kind === 'ordered' ? { ...row, number: Math.max(1, row.number - 1) } : row)
  return { blocks: [...blocks.slice(0, index - 1), { ...previous, elements: compact([...previous.elements, ...item.elements]) }, ...tail], selection: { block: index - 1, start: caret, end: caret } }
}

export function selectionStyle(blocks: DraftBlock[], selection: DraftSelection): InlineStyle {
  const item = blocks[selection.block]!
  const runs = sliceInline(item.elements, selection.start === selection.end ? Math.max(0, selection.start - 1) : selection.start, selection.end)
  return Object.fromEntries((['bold', 'italic', 'strike', 'code'] as const).map((key) => {
    const relevant = runs.filter((run) => counts(run, key))
    return [key, relevant.length > 0 && relevant.every((run) => hasStyle(run, key))]
  }))
}

/** Formatting a slice of a mention applies to the whole mention; a half tag would stop tagging. */
function wholeMentions(elements: SlackRichTextInline[], selection: DraftSelection): DraftSelection {
  let { start, end } = selection
  let offset = 0
  for (const run of elements) {
    const length = inlineText(run).length
    if (run.type === 'user' && offset < selection.end && offset + length > selection.start) {
      start = Math.min(start, offset); end = Math.max(end, offset + length)
    }
    offset += length
  }
  return { ...selection, start, end }
}
export function formatDraftInline(blocks: DraftBlock[], selection: DraftSelection, format: keyof InlineStyle | 'clear' | 'link', url?: string) {
  const item = blocks[selection.block]!
  selection = wholeMentions(item.elements, selection)
  const selected = sliceInline(item.elements, selection.start, selection.end)
  const enabled = format !== 'link' && format !== 'clear' && !selected.filter((run) => counts(run, format)).every((run) => hasStyle(run, format))
  const formatted = selected.map((run): SlackRichTextInline => {
    if (run.type === 'user' && format === 'code') return run
    if (format === 'clear') return run.type === 'user' ? { type: 'user', user_id: run.user_id, ...(run.name ? { name: run.name } : {}) } : { type: 'text', text: inlineText(run) }
    if (run.type === 'user' && format === 'link') return run
    if (format === 'link') return url ? { type: 'link', text: inlineText(run), url, ...(run.style ? { style: run.style } : {}) } : { type: 'text', text: inlineText(run), ...(run.style ? { style: run.style } : {}) }
    return { ...run, style: { ...run.style, [format]: enabled } }
  })
  return blocks.map((row, index) => index === selection.block ? { ...row, elements: compact([...sliceInline(row.elements, 0, selection.start), ...formatted, ...sliceInline(row.elements, selection.end, blockText(row).length)]) } : row)
}

export function formatDraftBlock(blocks: DraftBlock[], index: number, kind: BlockKind) {
  const previous = blocks[index - 1]
  return blocks.map((row, at) => {
    if (at !== index) return row
    const marker = kind === 'bullet' || kind === 'ordered' ? paragraphListMarker(row) : null
    return {
      ...row, kind, indent: marker?.format.indent ?? (kind === 'bullet' || kind === 'ordered' ? row.indent : 0),
      group: previous?.kind === kind ? previous.group : row.id,
      number: marker?.format.number ?? (previous?.kind === kind ? previous.number + 1 : 1),
      elements: marker?.format.elements ?? (kind === 'code' ? (blockText(row) ? [{ type: 'text' as const, text: blockText(row) }] : []) : row.elements),
    }
  })
}

export function validDraftLink(url: string) {
  try { return url.length <= 3000 && ['https:', 'http:', 'mailto:'].includes(new URL(url).protocol) } catch { return false }
}

export interface DraftEditorState {
  blocks: DraftBlock[]
  selection: DraftSelection
  pending?: InlineStyle
  undo: { blocks: DraftBlock[]; selection: DraftSelection }[]
  redo: { blocks: DraftBlock[]; selection: DraftSelection }[]
}
export const createDraftEditor = (body: string, document?: SlackRichText): DraftEditorState => ({ blocks: draftBlocks(body, document), selection: { block: 0, start: 0, end: 0 }, undo: [], redo: [] })
export function commitDraftEdit(state: DraftEditorState, blocks: DraftBlock[], selection = state.selection): DraftEditorState {
  if (selection === state.selection) {
    const before = state.blocks[selection.block]!
    const after = blocks[selection.block]!
    const marker = paragraphListMarker(before)
    if (marker && (after.kind === 'ordered' || after.kind === 'bullet') && blockText(after) === blockText(before).slice(marker.prefix)) {
      selection = { ...selection, start: Math.max(0, selection.start - marker.prefix), end: Math.max(0, selection.end - marker.prefix) }
    }
  }
  return { blocks, selection, ...(state.pending ? { pending: state.pending } : {}), undo: [...state.undo.slice(-49), { blocks: state.blocks, selection: state.selection }], redo: [] }
}
export function travelDraftHistory(state: DraftEditorState, direction: 'undo' | 'redo'): DraftEditorState {
  const stack = state[direction]
  const target = stack.at(-1)
  if (!target) return state
  const other = direction === 'undo' ? 'redo' : 'undo'
  return { ...state, ...target, pending: undefined, [direction]: stack.slice(0, -1), [other]: [...state[other], { blocks: state.blocks, selection: state.selection }] }
}
