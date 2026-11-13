import { EditorState } from '@codemirror/state'
import { draftBlocks } from '@manor/client-runtime/slack-draft-formatting'
import { SlackDraftInput, draftRunDecorations, draftDecorations, replaceDraftDecorations } from './SlackDraftInput'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { slackRichTextFallback, type SlackRichText } from '@manor/contracts'
import { forgetOutboundDraftEdit } from '@manor/client-runtime/outbound-draft-edits'
import { OutboundDraftBubble } from './OutboundDraftBubble'
import { SlackDraftEditor, SlackDraftPreview } from './SlackDraftEditor'

const document: SlackRichText = { type: 'rich_text', elements: [{ type: 'rich_text_list', style: 'ordered', offset: 3, indent: 1, elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'Styled', style: { bold: true } }] }] }] }
beforeEach(() => vi.stubGlobal('window', { clearTimeout }))
let rendered: ReactTestRenderer | undefined
const mount = (element: ReturnType<typeof createElement>) => { act(() => { rendered = create(element) }); return rendered! }
const mountAsync = async (element: ReturnType<typeof createElement>) => { await act(async () => { rendered = create(element) }); return rendered! }
afterEach(() => { act(() => rendered?.unmount()); rendered = undefined; forgetOutboundDraftEdit('format-test'); vi.unstubAllGlobals() })

describe('Slack draft card', () => {
  it('applies the toolbar to selected text and immediately updates the editable styled text', async () => {
    const onChange = vi.fn()
    const editor = await mountAsync(createElement(SlackDraftEditor, { body: 'Hello', onChange }))
    act(() => editor.root.findByType(SlackDraftInput).props.onSelection({ start: 0, end: 5 }))
    act(() => editor.root.findByProps({ 'aria-label': 'Bold', type: 'button' }).props.onClick())
    const edited = onChange.mock.calls[0]![0]
    expect(edited.elements[0].elements[0].style.bold).toBe(true)
    expect(editor.root.findByType(SlackDraftInput).props.block.elements).toEqual(edited.elements[0].elements)
    expect(editor.root.findAllByType(SlackDraftPreview)).toHaveLength(0)
    expect(editor.root.findAllByProps({ 'aria-label': 'Preview' })).toHaveLength(0)
  })

  it('submits the document shown in the editor, including cached edits after remount', () => {
    const onSubmit = vi.fn(() => true)
    const draft = { key: 'test', draftId: 'format-test', channel: 'slack' as const, to: 'Self', slackChannelId: 'D12345678', body: 'Original' }
    const props = { draft, color: 'currentColor', actions: { onSubmit } }
    let card = mount(createElement(OutboundDraftBubble, props))
    act(() => card.root.findByType(SlackDraftEditor).props.onChange(document))
    act(() => card.unmount())
    card = mount(createElement(OutboundDraftBubble, props))
    expect(card.root.findByType(SlackDraftEditor).props.document).toEqual(document)
    act(() => card.root.findByProps({ 'aria-label': 'Submit', type: 'button' }).props.onClick())
    expect(onSubmit).toHaveBeenCalledWith('format-test', slackRichTextFallback(document), undefined, document)
  })

  it('does not submit an empty or oversized edited document', () => {
    const card = mount(createElement(OutboundDraftBubble, { draft: { key: 'test', draftId: 'format-test', channel: 'slack', to: 'Self', slackChannelId: 'D12345678', body: 'Hello' }, color: 'currentColor', actions: { onSubmit: () => true } }))
    for (const text of ['\n', 'x'.repeat(20001)]) {
      act(() => card.root.findByType(SlackDraftEditor).props.onChange({ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text }] }] }))
      expect(card.root.findByProps({ 'aria-label': 'Submit', type: 'button' }).props.disabled).toBe(true)
    }
  })

  it('renders the submitted document while delivery is locked', () => {
    const card = mount(createElement(OutboundDraftBubble, { draft: { key: 'test', draftId: 'format-test', channel: 'slack', to: 'Self', slackChannelId: 'D12345678', body: 'Original', submission: { status: 'uncertain', body: 'Styled', slackRichText: document } }, color: 'currentColor' }))
    expect(card.root.findAllByType(SlackDraftEditor)).toHaveLength(0)
    expect(card.root.findByType(SlackDraftPreview).props.document).toEqual(document)
    expect(card.root.findByType('ol').props.start).toBe(4)
  })
})


describe('editable Slack text styles', () => {
  it('renders styled runs and maps their positions when text is deleted', () => {
    const block = draftBlocks('', document)[0]!
    let state = EditorState.create({ doc: 'Styled', extensions: [draftDecorations] })
    state = state.update({ effects: replaceDraftDecorations.of(draftRunDecorations(block)) }).state
    expect(state.field(draftDecorations).iter().value?.spec.class).toBe('font-semibold')
    state = state.update({ changes: { from: 0, to: 6 } }).state
    expect(state.field(draftDecorations).size).toBe(0)
  })

  it('keeps links, inline code and combined emphasis visible without interpreting markers', () => {
    const runs = draftRunDecorations({ ...draftBlocks('')[0]!, elements: [
      { type: 'text', text: '*literal*', style: { bold: true, italic: true, strike: true, code: true } },
      { type: 'link', text: 'site', url: 'https://example.com' },
    ] })
    const cursor = runs.iter()
    expect(cursor.value?.spec.class).toContain('font-semibold italic line-through')
    expect(cursor.value?.spec.class).toContain('font-mono')
    expect(cursor.to).toBe(9)
    cursor.next()
    expect(cursor.value?.spec.class).toBe('underline')
    expect(cursor.from).toBe(9)
    expect(cursor.to).toBe(13)
  })
})
