import { useEffect, useRef, useState } from 'react'
import { Linking, Pressable, ScrollView, StyleSheet, View, type TextStyle } from 'react-native'
import { TextInput } from '@/components/TextInput'
import { SlackRichTextSchema, type SlackRichText, type SlackRichTextInline } from '@manor/contracts'
import { blockText, commitDraftEdit, createDraftEditor, draftDocument, editDraftBlock, formatDraftBlock, formatDraftInline, inlineText, joinDraftBlock, selectionStyle, travelDraftHistory, validDraftLink, type BlockKind, type DraftEditorState, type DraftSelection, type InlineStyle } from '@manor/client-runtime/slack-draft-formatting'
import CodeIcon from '@hugeicons/core-free-icons/CodeIcon'
import CodeSquareIcon from '@hugeicons/core-free-icons/CodeSquareIcon'
import LeftToRightBlockQuoteIcon from '@hugeicons/core-free-icons/LeftToRightBlockQuoteIcon'
import LeftToRightListBulletIcon from '@hugeicons/core-free-icons/LeftToRightListBulletIcon'
import LeftToRightListNumberIcon from '@hugeicons/core-free-icons/LeftToRightListNumberIcon'
import Link01Icon from '@hugeicons/core-free-icons/Link01Icon'
import ListIndentDecreaseIcon from '@hugeicons/core-free-icons/ListIndentDecreaseIcon'
import ListIndentIncreaseIcon from '@hugeicons/core-free-icons/ListIndentIncreaseIcon'
import RedoIcon from '@hugeicons/core-free-icons/RedoIcon'
import TextBoldIcon from '@hugeicons/core-free-icons/TextBoldIcon'
import TextItalicIcon from '@hugeicons/core-free-icons/TextItalicIcon'
import TextStrikethroughIcon from '@hugeicons/core-free-icons/TextStrikethroughIcon'
import UndoIcon from '@hugeicons/core-free-icons/UndoIcon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import { Text } from '@/components/Text'
import { colors, fonts, outboundLayout, radius, spacing, tracking } from '@/theme'

const inlineStyle = (item: SlackRichTextInline): TextStyle => ({
  ...(item.style?.bold ? { fontWeight: '500' } : {}), ...(item.style?.italic ? { fontStyle: 'italic' } : {}),
  ...(item.type === 'link' ? { textDecorationLine: item.style?.strike ? 'underline line-through' : 'underline' } : item.style?.strike ? { textDecorationLine: 'line-through' } : {}), ...((item.type !== 'user' && item.style?.code) ? { fontFamily: fonts.mono, backgroundColor: colors.surface2 } : {}),
  ...(item.type === 'user' ? { fontWeight: '500', backgroundColor: colors.surface2 } : {}),
})
function Runs({ elements }: { elements: SlackRichTextInline[] }) {
  return elements.map((item, i) => <Text key={i} style={inlineStyle(item)} {...(item.type === 'link' ? { accessibilityRole: 'link' as const, onPress: () => { void Linking.openURL(item.url).catch(() => {}) } } : {})}>{inlineText(item)}</Text>)
}
export function SlackDraftPreview({ document }: { document: SlackRichText }) {
  return <View>
    {document.elements.map((item, i) => {
      if (item.type === 'rich_text_list') return <View key={i} style={{ marginLeft: (item.indent ?? 0) * spacing.xl }}>{item.elements.map((row, n) => <View key={n} style={styles.row}><Text style={styles.marker}>{item.style === 'ordered' ? `${(item.offset ?? 0) + n + 1}.` : '•'}</Text><Text selectable style={[styles.body, styles.grow]}><Runs elements={row.elements} /></Text></View>)}</View>
      return <View key={i} style={item.type === 'rich_text_quote' ? styles.quote : item.type === 'rich_text_preformatted' ? styles.codeBlock : undefined}><Text selectable style={[styles.body, item.type === 'rich_text_preformatted' && styles.mono]}><Runs elements={item.elements} /></Text></View>
    })}
  </View>
}
const inlineTools = [ ['bold', 'Bold', TextBoldIcon], ['italic', 'Italic', TextItalicIcon], ['strike', 'Strikethrough', TextStrikethroughIcon], ['code', 'Inline code', CodeIcon] ] as const
const blockTools = [ ['bullet', 'Bullet list', LeftToRightListBulletIcon], ['ordered', 'Numbered list', LeftToRightListNumberIcon], ['quote', 'Quote', LeftToRightBlockQuoteIcon], ['code', 'Code block', CodeSquareIcon] ] as const

export function SlackDraftEditor({ body, document, onChange }: { body: string; document?: SlackRichText; onChange: (document: SlackRichText) => void }) {
  const [state, setState] = useState(() => createDraftEditor(body, document))
  const [link, setLink] = useState<{ selection: DraftSelection; url: string } | null>(null)
  const [resume, setResume] = useState<DraftSelection | null>(null)
  const inputs = useRef(new Map<number, TextInput>())
  const current = state.blocks[state.selection.block]!
  const activeStyle = state.pending ?? selectionStyle(state.blocks, state.selection)
  const rich = draftDocument(state.blocks)
  const valid = SlackRichTextSchema.safeParse(rich).success
  const change = (next: DraftEditorState, focus = true) => {
    setState(next)
    if (focus) setResume(next.selection)
    onChange(draftDocument(next.blocks))
  }
  useEffect(() => {
    if (resume) inputs.current.get(state.blocks[resume.block]!.id)?.focus()
  }, [resume, state.blocks])
  const format = (key: keyof InlineStyle) => {
    if (state.selection.start === state.selection.end) {
      setState({ ...state, pending: { ...activeStyle, [key]: !activeStyle[key] } })
      setResume(state.selection)
    } else change(commitDraftEdit(state, formatDraftInline(state.blocks, state.selection, key)))
  }
  const kind = (value: BlockKind) => change(commitDraftEdit(state, formatDraftBlock(state.blocks, state.selection.block, current.kind === value ? 'paragraph' : value)))
  const tool = (label: string, icon: typeof CodeIcon, action: () => void, active = false, disabled = false) => <Pressable key={label} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: active, disabled }} disabled={disabled} onPress={action} style={[styles.tool, active && styles.active, disabled && styles.disabled]}><HugeiconsIcon icon={icon} size={18} color={active ? colors.text : colors.muted} /></Pressable>
  const button = (label: string, action: () => void, disabled = false) => <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={action} style={[styles.textButton, disabled && styles.disabled]}><Text style={styles.label}>{label}</Text></Pressable>
  return <View style={styles.editor}>
    <ScrollView horizontal keyboardShouldPersistTaps="always" contentContainerStyle={styles.toolbar}>
        {inlineTools.map(([key, label, icon]) => tool(label, icon, () => format(key), activeStyle[key], current.kind === 'code'))}
        {tool('Link', Link01Icon, () => setLink({ selection: state.selection, url: '' }), false, state.selection.start === state.selection.end || current.kind === 'code')}
        {blockTools.map(([key, label, icon]) => tool(label, icon, () => kind(key), current.kind === key))}
        {tool('Decrease indent', ListIndentDecreaseIcon, () => change(commitDraftEdit(state, state.blocks.map((row, i) => i === state.selection.block ? { ...row, indent: row.indent - 1 } : row))), false, !['ordered', 'bullet'].includes(current.kind) || current.indent === 0)}
        {tool('Increase indent', ListIndentIncreaseIcon, () => change(commitDraftEdit(state, state.blocks.map((row, i) => i === state.selection.block ? { ...row, indent: row.indent + 1 } : row))), false, !['ordered', 'bullet'].includes(current.kind) || current.indent === 8)}
        {tool('Undo', UndoIcon, () => change(travelDraftHistory(state, 'undo')), false, !state.undo.length)}
        {tool('Redo', RedoIcon, () => change(travelDraftHistory(state, 'redo')), false, !state.redo.length)}
        {button('Clear', () => { const blocks = formatDraftInline(state.blocks, state.selection, 'clear'); change({ ...commitDraftEdit(state, formatDraftBlock(blocks, state.selection.block, 'paragraph')), pending: {} }) })}
    </ScrollView>
    {link && <View style={styles.linkForm}>
      <TextInput accessibilityLabel="Link URL" autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="https://" placeholderTextColor={colors.dim} value={link.url} onChangeText={(url) => setLink({ ...link, url })} style={styles.url} />
      <View style={styles.row}>
        {button('Apply', () => { change(commitDraftEdit(state, formatDraftInline(state.blocks, link.selection, 'link', link.url), link.selection)); setLink(null) }, !validDraftLink(link.url))}
        {button('Unlink', () => { change(commitDraftEdit(state, formatDraftInline(state.blocks, link.selection, 'link'), link.selection)); setLink(null) })}
        {button('Cancel', () => setLink(null))}
      </View>
    </View>}
    <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="always" style={{ maxHeight: outboundLayout.inputMaxHeight }} contentContainerStyle={styles.content}>
        {state.blocks.map((row, index) => <View key={row.id} style={[styles.row, { marginLeft: row.indent * spacing.xl }, row.kind === 'quote' && styles.quote, row.kind === 'code' && styles.codeBlock]}>
          {row.kind === 'bullet' || row.kind === 'ordered' ? <Text style={styles.marker}>{row.kind === 'bullet' ? '•' : `${row.number}.`}</Text> : null}
          <TextInput
            ref={(input) => { if (input) inputs.current.set(row.id, input); else inputs.current.delete(row.id) }}
            accessibilityLabel={`Message ${row.kind === 'bullet' || row.kind === 'ordered' ? 'list item' : 'paragraph'} ${index + 1}`}
            multiline scrollEnabled={false} textAlignVertical="top" value={blockText(row)}
            placeholder={state.blocks.length === 1 ? 'Write a message…' : undefined} placeholderTextColor={colors.dim}
            style={[styles.input, row.kind === 'code' && styles.mono]}
            {...(resume?.block === index ? { selection: { start: resume.start, end: resume.end } } : {})}
            onSelectionChange={(event) => {
              const { start, end } = event.nativeEvent.selection
              if (resume && (resume.block !== index || resume.start !== start || resume.end !== end)) return
              setResume(null)
              setState((s) => ({ ...s, selection: { block: index, start, end }, ...(s.selection.block === index && s.selection.start === start && s.selection.end === end ? {} : { pending: undefined }) }))
            }}
            onFocus={() => setState((s) => ({ ...s, selection: s.selection.block === index ? s.selection : { block: index, start: 0, end: 0 }, ...(s.selection.block === index ? {} : { pending: undefined }) }))}
            onChangeText={(text) => { const edited = editDraftBlock(state.blocks, { ...state.selection, block: index }, text, state.pending); change(commitDraftEdit(state, edited.blocks, edited.selection)) }}
            onKeyPress={(event) => {
              if (event.nativeEvent.key === 'Backspace' && state.selection.block === index && state.selection.start === 0 && state.selection.end === 0 && index > 0) { const edited = joinDraftBlock(state.blocks, index); change(commitDraftEdit(state, edited.blocks, edited.selection)) }
            }}
          />
        </View>)}
        {current.kind === 'ordered' && <View style={styles.numberRow}><Text style={styles.label}>Start at</Text><TextInput accessibilityLabel="List number" keyboardType="number-pad" value={String(current.number)} style={styles.numberInput} onChangeText={(text) => {
          const number = Number(text)
          if (!Number.isInteger(number) || number < 1 || number > 20001) return
          change(commitDraftEdit(state, state.blocks.map((row, i) => i >= state.selection.block && row.group === current.group ? { ...row, number: row.number + number - current.number } : row)), false)
        }} /></View>}
    </ScrollView>
    {!valid && <Text accessibilityLiveRegion="polite" style={styles.note}>{state.blocks.every((row) => !blockText(row).trim()) ? 'Write a message to enable Send.' : 'This message exceeds Slack’s formatting limits. Shorten it before sending.'}</Text>}
  </View>
}
const styles = StyleSheet.create({
  editor: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: radius.sm, backgroundColor: colors.background, overflow: 'hidden', marginBottom: spacing.md },
  toolbar: { flexDirection: 'row', alignItems: 'center', padding: spacing.xs, gap: spacing.xs },
  tool: { width: 44, height: 44, justifyContent: 'center', alignItems: 'center', borderRadius: radius.sm },
  active: { backgroundColor: colors.surface2 }, disabled: { opacity: 0.4 },
  textButton: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.sm },
  label: { fontFamily: fonts.sans, fontSize: 13, color: colors.muted },
  content: { padding: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line },
  row: { flexDirection: 'row', alignItems: 'flex-start' }, grow: { flex: 1 },
  input: { flex: 1, minWidth: 0, fontFamily: fonts.sans, fontSize: 17, lineHeight: 25, letterSpacing: tracking.body, color: colors.text, padding: 0, minHeight: 25 },
  body: { fontFamily: fonts.sans, fontSize: 17, lineHeight: 25, color: colors.text },
  marker: { minWidth: spacing.xl, textAlign: 'right', paddingRight: spacing.xs, fontFamily: fonts.sans, fontSize: 17, lineHeight: 25, color: colors.text },
  mono: { fontFamily: fonts.mono },
  quote: { borderLeftWidth: 2, borderColor: colors.line, paddingLeft: spacing.md },
  codeBlock: { borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.surface, borderRadius: radius.sm, padding: spacing.sm, marginVertical: spacing.xs },
  linkForm: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.line, padding: spacing.sm },
  url: { color: colors.text, fontFamily: fonts.sans, fontSize: 17, padding: spacing.sm },
  numberRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: spacing.sm },
  numberInput: { minWidth: 60, color: colors.text, fontFamily: fonts.sans, fontSize: 17, padding: spacing.sm, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, borderRadius: radius.sm },
  note: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, padding: spacing.sm },
})
