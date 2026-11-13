import type { DraftInputHandle } from './SlackDraftInput'
import { lazy, Suspense, useEffect, useRef, useState, type CSSProperties } from 'react'
import { SlackRichTextSchema, type SlackRichText, type SlackRichTextInline } from '@manor/contracts'
import { blockText, breakDraftBlock, commitDraftEdit, createDraftEditor, draftDocument, editDraftBlock, formatDraftBlock, formatDraftInline, inlineText, joinDraftBlock, selectionStyle, travelDraftHistory, validDraftLink, type BlockKind, type DraftEditorState, type DraftSelection, type InlineStyle } from '@manor/client-runtime/slack-draft-formatting'
import { CodeIcon, CodeSquareIcon, LeftToRightBlockQuoteIcon, LeftToRightListBulletIcon, LeftToRightListNumberIcon, Link01Icon, ListIndentDecreaseIcon, ListIndentIncreaseIcon, RedoIcon, TextBoldIcon, TextItalicIcon, TextStrikethroughIcon, UndoIcon } from '@hugeicons/core-free-icons'
import { Icon } from './Icon'
import { Button } from './ui/Button'
import { ExternalLink } from './ExternalLink'

const SlackDraftInput = lazy(() => import('./SlackDraftInput').then((module) => ({ default: module.SlackDraftInput })))

const inlineStyle = (item: SlackRichTextInline): CSSProperties => ({ fontWeight: item.style?.bold ? 'var(--font-weight-semibold)' : undefined, fontStyle: item.style?.italic ? 'italic' : undefined, textDecoration: item.style?.strike ? 'line-through' : undefined })
function Runs({ elements }: { elements: SlackRichTextInline[] }) {
  return elements.map((item, i) => {
    const content = <span style={inlineStyle(item)} className={(item.type !== 'user' && item.style?.code) ? 'rounded-sm bg-surface-2 px-1 font-mono' : undefined}>{inlineText(item)}</span>
    if (item.type === 'user') return <span key={i} style={inlineStyle(item)} className="rounded-sm bg-[color-mix(in_srgb,var(--color-muted)_18%,transparent)] px-0.5 font-medium" title={item.user_id}>{inlineText(item)}</span>
    return item.type === 'link' ? <ExternalLink key={i} href={item.url} className="text-text underline" target="_blank" rel="noreferrer noopener">{content}</ExternalLink> : <span key={i}>{content}</span>
  })
}
export function SlackDraftPreview({ document }: { document: SlackRichText }) {
  return <div className="min-w-0 whitespace-pre-wrap text-[length:var(--msg-size,16px)] leading-relaxed text-text [overflow-wrap:anywhere]">
    {document.elements.map((item, i) => {
      if (item.type === 'rich_text_list') {
        const Tag = item.style === 'ordered' ? 'ol' : 'ul'
        return <Tag key={i} {...(item.style === 'ordered' ? { start: (item.offset ?? 0) + 1 } : {})} style={{ marginLeft: `${(item.indent ?? 0) * 1.5}em` }} className={`my-0 pl-6 ${item.style === 'ordered' ? 'list-decimal' : 'list-disc'}`}>{item.elements.map((row, n) => <li key={n}><Runs elements={row.elements} /></li>)}</Tag>
      }
      if (item.type === 'rich_text_preformatted') return <pre key={i} className="my-1 whitespace-pre-wrap rounded-md border border-line bg-surface p-2 font-mono text-label">{item.elements.map(inlineText).join('')}</pre>
      if (item.type === 'rich_text_quote') return <blockquote key={i} className="my-1 border-l-2 border-line pl-3 text-muted"><Runs elements={item.elements} /></blockquote>
      return <p key={i} className="m-0 min-h-[1lh]"><Runs elements={item.elements} /></p>
    })}
  </div>
}

const inlineTools = [ ['bold', 'Bold', TextBoldIcon], ['italic', 'Italic', TextItalicIcon], ['strike', 'Strikethrough', TextStrikethroughIcon], ['code', 'Inline code', CodeIcon] ] as const
const blockTools = [ ['bullet', 'Bullet list', LeftToRightListBulletIcon], ['ordered', 'Numbered list', LeftToRightListNumberIcon], ['quote', 'Quote', LeftToRightBlockQuoteIcon], ['code', 'Code block', CodeSquareIcon] ] as const

export function SlackDraftEditor({ body, document, onChange }: { body: string; document?: SlackRichText; onChange: (document: SlackRichText) => void }) {
  const [state, setState] = useState(() => createDraftEditor(body, document))
  const [link, setLink] = useState<{ selection: DraftSelection; url: string } | null>(null)
  const inputs = useRef(new Map<number, DraftInputHandle>())
  const pendingFocus = useRef(false)
  const frame = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const current = state.blocks[state.selection.block]!
  const styles = state.pending ?? selectionStyle(state.blocks, state.selection)
  const rich = draftDocument(state.blocks)
  const valid = SlackRichTextSchema.safeParse(rich).success
  const change = (next: DraftEditorState, focus = true) => {
    pendingFocus.current = focus
    setState(next)
    onChange(draftDocument(next.blocks))
  }
  useEffect(() => {
    if (pendingFocus.current) {
      inputs.current.get(state.blocks[state.selection.block]!.id)?.focus(state.selection)
      pendingFocus.current = false
    }
  }, [state])
  useEffect(() => {
    const card = frame.current?.closest<HTMLElement>('[data-outbound-card]')
    const input = content.current
    if (!card || !input || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      const chrome = Math.max(0, card.getBoundingClientRect().height - input.getBoundingClientRect().height)
      input.style.setProperty('--outbound-card-chrome', `${chrome}px`)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(card); observer.observe(input); measure()
    return () => observer.disconnect()
  }, [])
  const format = (key: keyof InlineStyle) => {
    if (state.selection.start === state.selection.end) {
      setState({ ...state, pending: { ...styles, [key]: !styles[key] } })
      inputs.current.get(current.id)?.focus()
    } else change(commitDraftEdit(state, formatDraftInline(state.blocks, state.selection, key)))
  }
  const kind = (value: BlockKind) => change(commitDraftEdit(state, formatDraftBlock(state.blocks, state.selection.block, current.kind === value ? 'paragraph' : value)))
  const tool = (label: string, icon: typeof CodeIcon, action: () => void, active = false, disabled = false) => <button key={label} type="button" aria-label={label} title={label} aria-pressed={active} disabled={disabled} onMouseDown={(e) => e.preventDefault()} onClick={action} className={`grid size-8 cursor-pointer place-items-center rounded-md border-0 disabled:cursor-default disabled:opacity-40 ${active ? 'bg-surface-2 text-text' : 'bg-transparent text-muted hover:bg-surface-2 hover:text-text'}`}><Icon icon={icon} size={16} /></button>
  return <div ref={frame} className="mb-3 overflow-hidden rounded-md border border-line bg-stage">
    <div className="flex items-center gap-0.5 overflow-x-auto border-b border-line p-1 [&>*]:shrink-0" role="group" aria-label="Slack formatting">
        {inlineTools.map(([key, label, icon]) => tool(label, icon, () => format(key), styles[key], current.kind === 'code'))}
        {tool('Link', Link01Icon, () => setLink({ selection: state.selection, url: '' }), false, state.selection.start === state.selection.end || current.kind === 'code')}
        {blockTools.map(([key, label, icon]) => tool(label, icon, () => kind(key), current.kind === key))}
        {tool('Decrease indent', ListIndentDecreaseIcon, () => change(commitDraftEdit(state, state.blocks.map((row, i) => i === state.selection.block ? { ...row, indent: row.indent - 1 } : row))), false, !['ordered', 'bullet'].includes(current.kind) || current.indent === 0)}
        {tool('Increase indent', ListIndentIncreaseIcon, () => change(commitDraftEdit(state, state.blocks.map((row, i) => i === state.selection.block ? { ...row, indent: row.indent + 1 } : row))), false, !['ordered', 'bullet'].includes(current.kind) || current.indent === 8)}
        {tool('Undo', UndoIcon, () => change(travelDraftHistory(state, 'undo')), false, !state.undo.length)}
        {tool('Redo', RedoIcon, () => change(travelDraftHistory(state, 'redo')), false, !state.redo.length)}
        <Button size="compact" variant="ghost" onMouseDown={(e) => e.preventDefault()} onClick={() => {
          const blocks = formatDraftInline(state.blocks, state.selection, 'clear')
          change({ ...commitDraftEdit(state, formatDraftBlock(blocks, state.selection.block, 'paragraph')), pending: {} })
        }}>Clear</Button>
    </div>
    {link && <div className="flex flex-wrap items-center gap-2 border-b border-line p-2">
      <input aria-label="Link URL" placeholder="https://" value={link.url} onChange={(e) => setLink({ ...link, url: e.target.value })} className="min-w-0 flex-1 rounded-md border border-line bg-stage px-2 py-1 text-text" />
      <Button size="compact" disabled={!validDraftLink(link.url)} onClick={() => { change(commitDraftEdit(state, formatDraftInline(state.blocks, link.selection, 'link', link.url), link.selection)); setLink(null) }}>Apply</Button>
      <Button size="compact" variant="ghost" onClick={() => { change(commitDraftEdit(state, formatDraftInline(state.blocks, link.selection, 'link'), link.selection)); setLink(null) }}>Unlink</Button>
      <Button size="compact" variant="ghost" onClick={() => setLink(null)}>Cancel</Button>
    </div>}
    <div ref={content} className="max-h-[min(var(--spacing-outbound-input-max),max(0px,calc(var(--spacing-outbound-dock-max)-var(--outbound-card-chrome,10rem)-0.5rem)))] overflow-y-auto overscroll-contain p-2.5 text-[length:var(--msg-size,16px)] leading-relaxed text-text">
      {state.blocks.map((row, index) => {
        const list = row.kind === 'bullet' || row.kind === 'ordered'
        const Tag = row.kind === 'ordered' ? 'ol' : row.kind === 'bullet' ? 'ul' : 'div'
        const Item = list ? 'li' : 'div'
        return <Tag key={row.id} {...(row.kind === 'ordered' ? { start: row.number } : {})} className={`m-0 ${list ? `pl-6 ${row.kind === 'ordered' ? 'list-decimal' : 'list-disc'}` : ''}`} style={{ marginLeft: `${row.indent * 1.5}em` }}>
          <Item className={row.kind === 'quote' ? 'my-1 border-l-2 border-line pl-3 text-muted' : row.kind === 'code' ? 'my-1 rounded-md border border-line bg-surface p-2 font-mono text-label' : undefined}>
            <Suspense fallback={<div className="text-dim">Loading editor…</div>}><SlackDraftInput
              block={row} label={`Draft ${list ? 'list item' : 'paragraph'} ${index + 1}`}
              register={(handle) => { if (handle) inputs.current.set(row.id, handle); else inputs.current.delete(row.id) }}
              onSelection={(selection) => setState((s) => ({ ...s, selection: { block: index, ...selection }, ...(s.selection.block === index && s.selection.start === selection.start && s.selection.end === selection.end ? {} : { pending: undefined }) }))}
              onChange={(text, before) => { const edited = editDraftBlock(state.blocks, { block: index, ...before }, text, state.pending); change(commitDraftEdit(state, edited.blocks, edited.selection)) }}
              onCommand={(command, range) => {
                const selection = { block: index, ...range }
                if (command === 'undo' || command === 'redo') change(travelDraftHistory(state, command))
                else if (command === 'bold' || command === 'italic') format(command)
                else if (command === 'softBreak' || (command === 'enter' && row.kind === 'code')) {
                  const text = blockText(row)
                  const edited = editDraftBlock(state.blocks, selection, text.slice(0, selection.start) + '\n' + text.slice(selection.end), state.pending, true)
                  change(commitDraftEdit(state, edited.blocks, edited.selection))
                } else if (command === 'enter') {
                  const edited = breakDraftBlock(state.blocks, selection); change(commitDraftEdit(state, edited.blocks, edited.selection))
                } else if (command === 'backspace' && selection.start === 0 && selection.end === 0 && index > 0) {
                  const edited = joinDraftBlock(state.blocks, index); change(commitDraftEdit(state, edited.blocks, edited.selection))
                } else return false
                return true
              }}
            /></Suspense>
          </Item>
        </Tag>
      })}
      {current.kind === 'ordered' && <label className="mt-2 flex items-center gap-2 text-label text-muted">Start at<input aria-label="List number" type="number" min={1} max={20001} value={current.number} className="w-20 rounded-md border border-line bg-stage px-2 py-1 text-text" onChange={(e) => {
        const number = Number(e.target.value)
        if (!Number.isInteger(number) || number < 1 || number > 20001) return
        change(commitDraftEdit(state, state.blocks.map((row, i) => i >= state.selection.block && row.group === current.group ? { ...row, number: row.number + number - current.number } : row)), false)
      }} /></label>}
    </div>
    {!valid && <p role="status" className="m-0 px-2.5 pb-2 text-label text-muted">{state.blocks.every((row) => !blockText(row).trim()) ? 'Write a message to enable Submit.' : 'This message exceeds Slack’s formatting limits. Shorten it before submitting.'}</p>}
  </div>
}
