import { describe, expect, it } from 'vitest'
import { SlackRichTextSchema, slackRichTextFallback, type SlackRichText } from '@manor/contracts'
import { blockText, breakDraftBlock, commitDraftEdit, createDraftEditor, draftBlocks, draftDocument, editDraftBlock, formatDraftBlock, formatDraftInline, joinDraftBlock, selectionStyle, travelDraftHistory, validDraftLink } from './slackDraftFormatting'

const rich: SlackRichText = { type: 'rich_text', elements: [
  { type: 'rich_text_section', elements: [{ type: 'text', text: 'Bold', style: { bold: true, italic: true, strike: true, code: true } }, { type: 'link', url: 'https://example.com', text: 'label', style: { bold: true } }] },
  { type: 'rich_text_list', style: 'ordered', indent: 2, offset: 7, elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'eight' }] }, { type: 'rich_text_section', elements: [{ type: 'text', text: 'nine' }] }] },
  { type: 'rich_text_list', style: 'bullet', indent: 3, elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'nested' }] }] },
  { type: 'rich_text_quote', elements: [{ type: 'text', text: 'quoted\nline', style: { italic: true } }] },
  { type: 'rich_text_preformatted', elements: [{ type: 'text', text: 'const x = 1\n' }] },
] }

describe('Slack draft editing', () => {
  it('shows a Slack mention as a readable tag and keeps it a real tag through edits', () => {
    const blocks = draftBlocks('<@U053J6TH7RN|Sander> about your questions')
    expect(blockText(blocks[0]!)).toBe('@Sander about your questions')
    expect(draftDocument(blocks).elements[0]).toEqual({ type: 'rich_text_section', elements: [{ type: 'user', user_id: 'U053J6TH7RN', name: 'Sander' }, { type: 'text', text: ' about your questions' }] })
    const typed = editDraftBlock(blocks, { block: 0, start: 7, end: 7 }, '@Sander, about your questions').blocks
    expect(typed[0]!.elements[0]).toEqual({ type: 'user', user_id: 'U053J6TH7RN', name: 'Sander' })
    const broken = editDraftBlock(blocks, { block: 0, start: 4, end: 4 }, '@Sanxder about your questions').blocks
    expect(broken[0]!.elements.every((run) => run.type === 'text')).toBe(true)
  })

  it('keeps a mention whole and sendable when formatting touches part of it', () => {
    const blocks = draftBlocks('hi <@U053J6TH7RN|Sander> there')
    const mention = { type: 'user', user_id: 'U053J6TH7RN', name: 'Sander' }
    for (const format of ['clear', 'link', 'bold', 'code'] as const) {
      const [row] = formatDraftInline(blocks, { block: 0, start: 5, end: 7 }, format, 'https://example.com')
      expect(row!.elements.find((run) => run.type === 'user')).toMatchObject(mention)
      expect(blockText(row!)).toBe('hi @Sander there')
      expect(SlackRichTextSchema.safeParse(draftDocument([row!])).success).toBe(true)
    }
    const [bold] = formatDraftInline(blocks, { block: 0, start: 5, end: 7 }, 'bold')
    expect(bold!.elements).toEqual([{ type: 'text', text: 'hi ' }, { ...mention, style: { bold: true } }, { type: 'text', text: ' there' }])
    const [code] = formatDraftInline(blocks, { block: 0, start: 0, end: 16 }, 'code')
    expect(code!.elements.find((run) => run.type === 'user')).toEqual(mention)
  })

  it('leaves <@U…> inside inline code literal', () => {
    const parsed = SlackRichTextSchema.parse({ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: '<@U053J6TH7RN>', style: { code: true } }] }] })
    expect(parsed.elements[0]).toEqual({ type: 'rich_text_section', elements: [{ type: 'text', text: '<@U053J6TH7RN>', style: { code: true } }] })
    const unstyled = SlackRichTextSchema.safeParse({ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: '<@U053J6TH7RN>', style: { code: false, bold: true } }] }] })
    expect(unstyled.success && unstyled.data.elements[0]).toEqual({ type: 'rich_text_section', elements: [{ type: 'user', user_id: 'U053J6TH7RN', style: { bold: true } }] })
  })

  it('turns agent-written <@U…> text into user elements when the draft is parsed', () => {
    const parsed = SlackRichTextSchema.parse({ type: 'rich_text', elements: [{ type: 'rich_text_list', style: 'ordered', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'ask <@U053J6TH7RN> first', style: { bold: true } }] }] }] })
    expect(parsed.elements[0]).toMatchObject({ elements: [{ elements: [{ type: 'text', text: 'ask ', style: { bold: true } }, { type: 'user', user_id: 'U053J6TH7RN', style: { bold: true } }, { type: 'text', text: ' first', style: { bold: true } }] }] })
    expect(slackRichTextFallback(parsed)).toBe('1. ask @U053J6TH7RN first')
  })

  it('preserves every supported format and list offset through editing state', () => {
    expect(draftDocument(draftBlocks('', rich))).toEqual(rich)
    expect(SlackRichTextSchema.safeParse(draftDocument(draftBlocks('', rich))).success).toBe(true)
  })

  it('edits inside a link without losing its URL or surrounding formatting', () => {
    const blocks = draftBlocks('', rich)
    const edited = editDraftBlock(blocks, { block: 0, start: 6, end: 6 }, 'BoldlaXbel')
    const document = draftDocument(edited.blocks)
    expect(document.elements[0]).toEqual({ type: 'rich_text_section', elements: [rich.elements[0]!.type === 'rich_text_section' && rich.elements[0]!.elements[0], { type: 'link', url: 'https://example.com', text: 'laXbel', style: { bold: true } }] })
    expect(document.elements.slice(1)).toEqual(rich.elements.slice(1))
  })

  it('formats only the selected text, and can remove links and styles', () => {
    let blocks = draftBlocks('one two three')
    const selection = { block: 0, start: 4, end: 7 }
    blocks = formatDraftInline(blocks, selection, 'bold')
    blocks = formatDraftInline(blocks, selection, 'italic')
    blocks = formatDraftInline(blocks, selection, 'link', 'https://example.com')
    expect(blocks[0]!.elements[1]).toEqual({ type: 'link', text: 'two', url: 'https://example.com', style: { bold: true, italic: true } })
    expect(selectionStyle(blocks, selection).bold).toBe(true)
    blocks = formatDraftInline(blocks, selection, 'clear')
    expect(blocks[0]!.elements).toEqual([{ type: 'text', text: 'one two three' }])
  })

  it('continues typed numbering, including an old plain-text draft, and leaves an empty item', () => {
    const blocks = draftBlocks('Manor draft card test\n1. hallo')
    const continued = breakDraftBlock(blocks, { block: 1, start: 8, end: 8 })
    expect(continued.blocks.map((row) => [row.kind, row.number, blockText(row)])).toEqual([['paragraph', 1, 'Manor draft card test'], ['ordered', 1, 'hallo'], ['ordered', 2, '']])
    const exited = breakDraftBlock(continued.blocks, continued.selection)
    expect(exited.blocks[2]!.kind).toBe('paragraph')
    expect(SlackRichTextSchema.safeParse(draftDocument(exited.blocks)).success).toBe(true)
  })

  it('recognizes bullet and numbered shortcuts while typing', () => {
    for (const [prefix, kind, number] of [['-', 'bullet', 1], ['8.', 'ordered', 8]] as const) {
      const edited = editDraftBlock(draftBlocks(prefix), { block: 0, start: prefix.length, end: prefix.length }, `${prefix} `)
      expect(edited.blocks[0]).toMatchObject({ kind, number, elements: [] })
      expect(edited.selection).toEqual({ block: 0, start: 0, end: 0 })
    }
  })

  it.each([
    ['1. hallo', 'ordered', 1, 0],
    ['  8. hallo', 'ordered', 8, 1],
    ['- hallo', 'bullet', 1, 0],
    ['  • hallo', 'ordered', 1, 1],
  ] as const)('converts the existing marker with the list button: %s', (text, kind, number, indent) => {
    const blocks = draftBlocks(text)
    expect(blockText(blocks[0]!)).toBe(text)
    expect(blocks[0]!.kind).toBe('paragraph')
    const formatted = formatDraftBlock(blocks, 0, kind)
    expect(blockText(formatted[0]!)).toBe('hallo')
    expect(formatted[0]).toMatchObject({ kind, number, indent })
    const document = draftDocument(formatted)
    expect(document.elements[0]).toMatchObject({ type: 'rich_text_list', style: kind, elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'hallo' }] }] })
    expect(SlackRichTextSchema.safeParse(document).success).toBe(true)
  })

  it('preserves styled list content and moves the selection past the removed marker', () => {
    const state = createDraftEditor('1. hallo')
    state.blocks = formatDraftInline(state.blocks, { block: 0, start: 3, end: 8 }, 'bold')
    state.selection = { block: 0, start: 3, end: 8 }
    const edited = commitDraftEdit(state, formatDraftBlock(state.blocks, 0, 'ordered'))
    expect(edited.blocks[0]!.elements).toEqual([{ type: 'text', text: 'hallo', style: { bold: true } }])
    expect(edited.selection).toEqual({ block: 0, start: 0, end: 5 })
  })

  it('renumbers the following items on split and joins them on backspace', () => {
    const blocks = draftBlocks('', rich)
    const split = breakDraftBlock(blocks, { block: 1, start: 2, end: 2 })
    expect(split.blocks.slice(1, 4).map((row) => row.number)).toEqual([8, 9, 10])
    const joined = joinDraftBlock(split.blocks, 2)
    expect(draftDocument(joined.blocks)).toEqual(rich)
  })

  it('keeps a soft break inside a list item and Enter inside code', () => {
    const blocks = formatDraftBlock(draftBlocks('first'), 0, 'bullet')
    const edited = editDraftBlock(blocks, { block: 0, start: 5, end: 5 }, 'first\n', undefined, true)
    expect(edited.blocks).toHaveLength(1)
    expect(blockText(edited.blocks[0]!)).toBe('first\n')
    const code = formatDraftBlock(draftBlocks('code'), 0, 'code')
    expect(editDraftBlock(code, { block: 0, start: 4, end: 4 }, 'code\n').blocks).toHaveLength(1)
  })

  it('preserves literal markers and clipboard text, with no inline Markdown reconstruction', () => {
    const blocks = draftBlocks('literal *stars*')
    const pasted = editDraftBlock(blocks, { block: 0, start: 15, end: 15 }, 'literal *stars* <tag> & value')
    expect(slackRichTextFallback(draftDocument(pasted.blocks))).toBe('literal *stars* <tag> & value')
    expect(pasted.blocks[0]!.elements.every((run) => !run.style && run.type === 'text')).toBe(true)
  })

  it('pastes multiple list items and preserves following numbering', () => {
    const blocks = draftBlocks('', rich)
    const pasted = editDraftBlock(blocks, { block: 1, start: 5, end: 5 }, 'eight\ninserted')
    expect(pasted.blocks.slice(1, 4).map((row) => [row.number, blockText(row)])).toEqual([[8, 'eight'], [9, 'inserted'], [10, 'nine']])
    expect(pasted.selection).toEqual({ block: 2, start: 8, end: 8 })
  })

  it('undoes and redoes document changes together with their selection', () => {
    const initial = createDraftEditor('hello')
    const next = commitDraftEdit(initial, formatDraftBlock(initial.blocks, 0, 'bullet'))
    const undo = travelDraftHistory(next, 'undo')
    expect(undo.blocks).toEqual(initial.blocks)
    expect(travelDraftHistory(undo, 'redo').blocks).toEqual(next.blocks)
  })

  it('refuses an empty document, oversized text and unsafe links', () => {
    expect(SlackRichTextSchema.safeParse(draftDocument(draftBlocks(''))).success).toBe(false)
    expect(SlackRichTextSchema.safeParse(draftDocument(draftBlocks('x'.repeat(20001)))).success).toBe(false)
    expect(validDraftLink('javascript:alert(1)')).toBe(false)
    expect(validDraftLink('https://example.com')).toBe(true)
  })
})
