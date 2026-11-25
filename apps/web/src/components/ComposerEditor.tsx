import { LexicalComposer, type InitialConfigType } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { createEmptyHistoryState, HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { ListPlugin } from '@lexical/react/LexicalListPlugin'
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin'
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { $isListItemNode, $isListNode, ListItemNode, ListNode } from '@lexical/list'
import { $convertFromMarkdownString, $convertToMarkdownString, ORDERED_LIST, UNORDERED_LIST, type Transformer } from '@lexical/markdown'
import { formatImageRef, quoteExcerpt, type AgentConfig, type InlineQuote, type SkillConfig } from '@manor/contracts'
import {
  $applyNodeReplacement,
  $createLineBreakNode,
  $createRangeSelection,
  $createTabNode,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isDecoratorNode,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  BLUR_COMMAND,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  DRAGOVER_COMMAND,
  DROP_COMMAND,
  DecoratorNode,
  FOCUS_COMMAND,
  INSERT_PARAGRAPH_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_DELETE_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
  PASTE_COMMAND,
  SKIP_DOM_SELECTION_TAG,
  type EditorState,
  type ElementNode,
  type LexicalNode,
  type NodeKey,
} from 'lexical'
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ClipboardEventHandler, type ForwardedRef, type ReactElement } from 'react'
import { mentionSegments } from '../mentions'
import { useStableCallback } from '../useStableCallback'
import { AgentChip, DestinationChip, ImageRefChip, QuoteRefChip, SkillChip } from './MentionText'

// Lexical supports React 18, but its published JSX return type can resolve through
// the workspace's React 19 mobile types. Keep that package-manager detail outside
// the editor instead of widening the app's React version.
const CompatibleContentEditable = ContentEditable as unknown as (props: {
  className: string
  'data-composer-editor': string
  'aria-placeholder': string
  'aria-label'?: string
  placeholder: ReactElement
  onPaste: ClipboardEventHandler<HTMLDivElement>
}) => ReactElement

const COMPOSER_UNORDERED_LIST = {
  ...UNORDERED_LIST,
  // Keep accepting the typographic marker older Manor drafts showed while typing.
  regExp: /^(\s*)[-*+•]\s/,
} satisfies Transformer
const LIST_TRANSFORMERS: Transformer[] = [COMPOSER_UNORDERED_LIST, ORDERED_LIST]

const NO_QUOTES: readonly InlineQuote[] = []

type ComposerMention =
  | { kind: 'agent'; source: string; agent: AgentConfig }
  | { kind: 'skill'; source: string; skill: SkillConfig }
  | { kind: 'image'; source: string; number: number }
  | { kind: 'quote'; source: string; number: number; quote: InlineQuote }
  | { kind: 'browser' | 'computer' | 'work'; source: string }

/**
 * What a tray thumbnail carries when it is dragged into the text: its 1-based number.
 * The drag also offers the plain reference as text, for any other field it lands in.
 */
export const IMAGE_REF_DRAG_TYPE = 'application/x-manor-image-ref'

class ComposerMentionNode extends DecoratorNode<ReactElement> {
  __mention: ComposerMention

  static getType() {
    return 'composer-mention'
  }

  static clone(node: ComposerMentionNode) {
    return new ComposerMentionNode(node.__mention, node.__key)
  }

  constructor(mention: ComposerMention = { kind: 'browser', source: '' }, key?: NodeKey) {
    super(key)
    this.__mention = mention
  }

  createDOM() {
    const element = document.createElement('span')
    element.className = 'relative inline-flex align-[0.0625em] leading-none data-[composer-chip-selected]:after:pointer-events-none data-[composer-chip-selected]:after:absolute data-[composer-chip-selected]:after:inset-0 data-[composer-chip-selected]:after:rounded-full data-[composer-chip-selected]:after:bg-text/20 data-[composer-chip-selected]:after:content-[\'\']'
    return element
  }

  updateDOM() {
    return false as const
  }

  getTextContent() {
    return this.__mention.source
  }

  isInline() {
    return true as const
  }

  decorate() {
    return (
      <span contentEditable={false} spellCheck={false} data-composer-mention-pill={this.__mention.kind} className="select-none">
        {this.__mention.kind === 'agent'
          ? <AgentChip agent={this.__mention.agent} />
          : this.__mention.kind === 'skill'
            ? <SkillChip skill={this.__mention.skill} />
            : this.__mention.kind === 'image'
              ? <ImageRefChip number={this.__mention.number} />
              : this.__mention.kind === 'quote'
                ? <QuoteRefChip number={this.__mention.number} quote={this.__mention.quote} />
                : <DestinationChip kind={this.__mention.kind} />}
      </span>
    )
  }
}

/** The scroller's reach into the card's top padding, rounded to the card's inner corner. */
const REACH = '-mt-(--composer-reach) pt-(--composer-reach) rounded-t-[calc(var(--radius-composer)-1px-var(--composer-reach))]'

function $createComposerMentionNode(mention: ComposerMention) {
  return $applyNodeReplacement(new ComposerMentionNode(mention))
}

function $mentionNodes(text: string, agents: readonly AgentConfig[], skills: readonly SkillConfig[], allowBrowser: boolean, allowComputer: boolean, allowWork: boolean, imageCount: number, quotes: readonly InlineQuote[]) {
  return mentionSegments(text, agents, skills, imageCount, quotes).map((segment) => {
    if (segment.kind === 'image') return $createComposerMentionNode({ kind: 'image', source: segment.text, number: segment.number })
    if (segment.kind === 'quote') return $createComposerMentionNode({ kind: 'quote', source: segment.text, number: segment.number, quote: segment.quote })
    if (segment.kind === 'agent') return $createComposerMentionNode({ kind: 'agent', source: segment.text, agent: segment.agent })
    if ((segment.kind === 'browser' && allowBrowser) || (segment.kind === 'computer' && allowComputer) || (segment.kind === 'work' && allowWork)) {
      return $createComposerMentionNode({ kind: segment.kind, source: segment.text })
    }
    if (segment.kind === 'skill') return $createComposerMentionNode({ kind: 'skill', source: segment.text, skill: segment.skill })
    return $createTextNode(segment.text)
  })
}

function $pastedNodes(text: string, agents: readonly AgentConfig[], skills: readonly SkillConfig[], allowBrowser: boolean, allowComputer: boolean, allowWork: boolean, imageCount: number, quotes: readonly InlineQuote[]) {
  const nodes: LexicalNode[] = []
  for (const part of text.split(/(\r?\n|\t)/)) {
    if (part === '\n' || part === '\r\n') nodes.push($createLineBreakNode())
    else if (part === '\t') nodes.push($createTabNode())
    else if (part !== '') nodes.push(...$mentionNodes(part, agents, skills, allowBrowser, allowComputer, allowWork, imageCount, quotes))
  }
  return nodes
}

function $setComposerValue(value: string, agents: readonly AgentConfig[], skills: readonly SkillConfig[], allowBrowser: boolean, allowComputer: boolean, allowWork: boolean, imageCount: number, quotes: readonly InlineQuote[]) {
  const root = $getRoot()
  // The importer unescapes what `$composerValue` no longer escapes, so a backslash the user
  // typed before one of those characters is doubled first and comes back as typed.
  $convertFromMarkdownString(value.replace(/^(\s*)• /gm, '$1- ').replace(/\\(?=[*_`~\\])/g, '\\\\'), LIST_TRANSFORMERS, root, true)
  for (const textNode of root.getAllTextNodes()) {
    const nodes = $mentionNodes(textNode.getTextContent(), agents, skills, allowBrowser, allowComputer, allowWork, imageCount, quotes)
    if (nodes.length === 1 && $isTextNode(nodes[0])) continue
    const first = nodes[0]
    if (!first) {
      textNode.remove()
      continue
    }
    textNode.replace(first)
    let previous: LexicalNode = first
    for (const node of nodes.slice(1)) {
      previous = previous.insertAfter(node)
    }
  }
}

/**
 * The message as the user typed it. Lexical escapes every `*`, `_`, `` ` ``, `~` and `\` in
 * plain text so it would re-import as text, but this editor has no inline formats:
 * the escapes only hid the bold and code they wrote from the bubble and the persona
 * alike. Undoing them is the exact inverse, because nothing else here escapes.
 */
function $composerValue() {
  return $convertToMarkdownString(LIST_TRANSFORMERS, undefined, true).replace(/\\([*_`~\\])/g, '$1')
}

function listPrefix(node: ListItemNode) {
  const list = node.getParent()
  if (!$isListNode(list)) return ''
  if (list.getListType() !== 'number') return '- '
  return `${list.getStart() + node.getIndexWithinParent()}. `
}

function separatedChildren(node: ElementNode) {
  return $isListNode(node) || node.getType() === 'root'
}

function nodeLength(node: LexicalNode): number {
  if (node instanceof ComposerMentionNode) return node.getTextContent().length
  if ($isTextNode(node)) return node.getTextContentSize()
  if ($isLineBreakNode(node)) return 1
  if ($isElementNode(node)) {
    const children = node.getChildren()
    const separators = separatedChildren(node) ? Math.max(0, children.length - 1) : 0
    const prefix = $isListItemNode(node) ? listPrefix(node).length : 0
    return prefix + separators + children.reduce((total, child) => total + nodeLength(child), 0)
  }
  return 0
}

function pointOffset(node: LexicalNode, offset: number): number {
  let absolute = 0
  let current: LexicalNode | null = node

  if ($isTextNode(node)) {
    absolute = Math.min(offset, node.getTextContentSize())
  } else if (node instanceof ComposerMentionNode) {
    absolute = offset > 0 ? nodeLength(node) : 0
  } else if ($isLineBreakNode(node)) {
    absolute = Math.min(offset, 1)
  } else if ($isElementNode(node)) {
    if ($isListItemNode(node)) absolute += listPrefix(node).length
    for (const child of node.getChildren().slice(0, offset)) absolute += nodeLength(child)
    if (separatedChildren(node)) absolute += Math.min(offset, node.getChildrenSize() - 1)
  }

  while (current) {
    const parent: LexicalNode | null = current.getParent()
    if (!parent || !$isElementNode(parent)) break
    if ($isListItemNode(parent)) absolute += listPrefix(parent).length
    for (const sibling of parent.getChildren().slice(0, current.getIndexWithinParent())) absolute += nodeLength(sibling)
    if (separatedChildren(parent)) absolute += Math.min(current.getIndexWithinParent(), parent.getChildrenSize() - 1)
    current = parent
  }
  return absolute
}

type SelectionPoint = { key: string; offset: number; type: 'text' | 'element' }

function findPoint(node: LexicalNode, remaining: { value: number }): SelectionPoint | null {
  if (node instanceof ComposerMentionNode) {
    const parent = node.getParent()
    if (!parent || !$isElementNode(parent)) return null
    const index = node.getIndexWithinParent()
    if (remaining.value === 0) return { key: parent.getKey(), offset: index, type: 'element' }
    if (remaining.value <= nodeLength(node)) return { key: parent.getKey(), offset: index + 1, type: 'element' }
    remaining.value -= nodeLength(node)
    return null
  }

  if ($isTextNode(node)) {
    const size = node.getTextContentSize()
    if (remaining.value <= size) return { key: node.getKey(), offset: remaining.value, type: 'text' }
    remaining.value -= size
    return null
  }

  if ($isLineBreakNode(node)) {
    const parent = node.getParent()
    if (!parent || !$isElementNode(parent)) return null
    const index = node.getIndexWithinParent()
    if (remaining.value === 0) return { key: parent.getKey(), offset: index, type: 'element' }
    if (remaining.value === 1) return { key: parent.getKey(), offset: index + 1, type: 'element' }
    remaining.value -= 1
    return null
  }

  if ($isElementNode(node)) {
    if ($isListItemNode(node)) {
      const prefix = listPrefix(node).length
      if (remaining.value <= prefix) return { key: node.getKey(), offset: 0, type: 'element' }
      remaining.value -= prefix
    }
    const children = node.getChildren()
    for (let index = 0; index < children.length; index += 1) {
      const child = children[index]
      if (!child) continue
      const point = findPoint(child, remaining)
      if (point) return point
      if (separatedChildren(node) && index < children.length - 1) {
        if (remaining.value <= 1) remaining.value = 0
        else remaining.value -= 1
      }
    }
    if (remaining.value === 0) return { key: node.getKey(), offset: node.getChildrenSize(), type: 'element' }
  }
  return null
}

function $setCaret(offset: number) {
  const root = $getRoot()
  const bounded = Math.max(0, Math.min(offset, nodeLength(root)))
  const point = findPoint(root, { value: bounded }) ?? {
    key: root.getKey(),
    offset: root.getChildrenSize(),
    type: 'element' as const,
  }
  const selection = $createRangeSelection()
  selection.anchor.set(point.key, point.offset, point.type)
  selection.focus.set(point.key, point.offset, point.type)
  $setSelection(selection)
}

function $readSelection(fallback: number) {
  const selection = $getSelection()
  if (!$isRangeSelection(selection)) return { caret: fallback, collapsed: false }
  const anchor = pointOffset(selection.anchor.getNode(), selection.anchor.offset)
  const focus = pointOffset(selection.focus.getNode(), selection.focus.offset)
  return { caret: Math.min(anchor, focus), collapsed: selection.isCollapsed() }
}

function $readSelectionRange() {
  const selection = $getSelection()
  if (!$isRangeSelection(selection)) return null
  const anchor = pointOffset(selection.anchor.getNode(), selection.anchor.offset)
  const focus = pointOffset(selection.focus.getNode(), selection.focus.offset)
  return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) }
}

function removeAdjacentMention(direction: 'backward' | 'forward') {
  const selection = $getSelection()
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false
  const anchor = selection.anchor.getNode()
  let candidate: LexicalNode | null = null

  if (anchor instanceof ComposerMentionNode) {
    candidate = anchor
  } else if ($isTextNode(anchor)) {
    const atEdge = direction === 'backward'
      ? selection.anchor.offset === 0
      : selection.anchor.offset === anchor.getTextContentSize()
    if (atEdge) candidate = direction === 'backward' ? anchor.getPreviousSibling() : anchor.getNextSibling()
  } else if ($isElementNode(anchor)) {
    const childIndex = direction === 'backward' ? selection.anchor.offset - 1 : selection.anchor.offset
    if (childIndex >= 0) candidate = anchor.getChildAtIndex(childIndex)
  }

  if (!(candidate instanceof ComposerMentionNode)) return false
  const start = pointOffset(candidate, 0)
  candidate.remove()
  $setCaret(start)
  return true
}

function MentionDeletionPlugin() {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    const backspace = editor.registerCommand(KEY_BACKSPACE_COMMAND, (event) => {
      if (!removeAdjacentMention('backward')) return false
      event?.preventDefault()
      return true
    }, COMMAND_PRIORITY_HIGH)
    const remove = editor.registerCommand(KEY_DELETE_COMMAND, (event) => {
      if (!removeAdjacentMention('forward')) return false
      event?.preventDefault()
      return true
    }, COMMAND_PRIORITY_HIGH)
    return () => {
      backspace()
      remove()
    }
  }, [editor])
  return null
}

function MentionPastePlugin({ agents, skills, allowBrowser, allowComputer, allowWork, imageCount, quotes }: { agents: readonly AgentConfig[]; skills: readonly SkillConfig[]; allowBrowser: boolean; allowComputer: boolean; allowWork: boolean; imageCount: number; quotes: readonly InlineQuote[] }) {
  const [editor] = useLexicalComposerContext()
  useEffect(() => editor.registerCommand(PASTE_COMMAND, (event) => {
    if (!('clipboardData' in event) || event.clipboardData === null || event.clipboardData.files.length > 0) return false
    const pasted = event.clipboardData.getData('text/plain')
    const selection = $getSelection()
    const range = $readSelectionRange()
    if (pasted === '' || range === null || !$isRangeSelection(selection)) return false
    event.preventDefault()
    selection.insertNodes($pastedNodes(pasted, agents, skills, allowBrowser, allowComputer, allowWork, imageCount, quotes))
    $setCaret(range.start + pasted.length)
    return true
  }, COMMAND_PRIORITY_HIGH), [agents, skills, allowBrowser, allowComputer, allowWork, imageCount, quotes, editor])
  return null
}

function MentionSelectionPlugin() {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    let selected = new Set<string>()
    let focused = typeof document !== 'undefined' && editor.getRootElement() === document.activeElement
    const apply = (next: Set<string>) => {
      for (const key of selected) {
        if (!next.has(key)) editor.getElementByKey(key)?.removeAttribute('data-composer-chip-selected')
      }
      for (const key of next) editor.getElementByKey(key)?.setAttribute('data-composer-chip-selected', 'true')
      selected = next
    }
    const read = () => {
      const next = new Set<string>()
      editor.getEditorState().read(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection) || selection.isCollapsed()) return
        for (const node of selection.getNodes()) {
          if ($isDecoratorNode(node)) next.add(node.getKey())
        }
      })
      return next
    }
    const update = editor.registerUpdateListener(() => apply(focused ? read() : new Set()))
    const focus = editor.registerCommand(FOCUS_COMMAND, () => {
      focused = true
      apply(read())
      return false
    }, COMMAND_PRIORITY_LOW)
    const blur = editor.registerCommand(BLUR_COMMAND, () => {
      focused = false
      apply(new Set())
      return false
    }, COMMAND_PRIORITY_LOW)
    return () => {
      update()
      focus()
      blur()
    }
  }, [editor])
  return null
}

/**
 * A tray thumbnail dropped into the text becomes its chip where it lands, the
 * pointer's own spot rather than wherever the caret was. Only Manor's own drag is
 * taken; a file dragged in from Finder still falls through to the card, which attaches it.
 */
function ImageRefDropPlugin({ imageCount }: { imageCount: number }) {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    const ours = (event: DragEvent) => event.dataTransfer?.types.includes(IMAGE_REF_DRAG_TYPE) === true
    const over = editor.registerCommand(DRAGOVER_COMMAND, (event) => {
      if (!ours(event)) return false
      event.preventDefault()
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'
      return true
    }, COMMAND_PRIORITY_HIGH)
    const drop = editor.registerCommand(DROP_COMMAND, (event) => {
      if (!ours(event)) return false
      event.preventDefault()
      const number = Number(event.dataTransfer?.getData(IMAGE_REF_DRAG_TYPE))
      if (!Number.isInteger(number) || number < 1 || number > imageCount) return true
      const landing = document.caretRangeFromPoint?.(event.clientX, event.clientY)
      const root = editor.getRootElement()
      let selection = $getSelection()
      if (landing !== null && landing !== undefined && root?.contains(landing.startContainer) === true) {
        const placed = $createRangeSelection()
        placed.applyDOMRange(landing)
        $setSelection(placed)
        selection = placed
      }
      if (!$isRangeSelection(selection)) {
        $getRoot().selectEnd()
        selection = $getSelection()
      }
      if (!$isRangeSelection(selection)) return true
      selection.insertNodes([$createComposerMentionNode({ kind: 'image', source: formatImageRef(number), number }), $createTextNode(' ')])
      root?.focus({ preventScroll: true })
      return true
    }, COMMAND_PRIORITY_HIGH)
    return () => {
      over()
      drop()
    }
  }, [editor, imageCount])
  return null
}

type CommandKey = 'ArrowDown' | 'ArrowUp' | 'Enter' | 'Escape' | 'Tab'
type CommandContext = { value: string; caret: number; selectionCollapsed: boolean }

function CommandPlugin({ onCommand }: { onCommand: (key: CommandKey, event: KeyboardEvent, context: CommandContext) => boolean }) {
  const [editor] = useLexicalComposerContext()
  // Registered once per editor; the key handler it calls is always the latest.
  const handle = useStableCallback(onCommand)
  useEffect(() => {
    const register = (command: typeof KEY_ENTER_COMMAND, key: CommandKey) => editor.registerCommand(
      command,
      (event) => {
        if (!event) return false
        if (key === 'Enter' && (event.isComposing || event.keyCode === 229)) return true
        const selection = $readSelection(nodeLength($getRoot()))
        const handled = handle(key, event, {
          value: $composerValue(),
          caret: selection.caret,
          selectionCollapsed: selection.collapsed,
        })
        if (handled) {
          event.preventDefault()
          event.stopPropagation()
          return true
        }
        if (key === 'Enter' && event.shiftKey && selection.collapsed) {
          event.preventDefault()
          event.stopPropagation()
          return editor.dispatchCommand(INSERT_PARAGRAPH_COMMAND, undefined)
        }
        return handled
      },
      COMMAND_PRIORITY_HIGH,
    )
    const cleanups = [
      register(KEY_ARROW_DOWN_COMMAND, 'ArrowDown'),
      register(KEY_ARROW_UP_COMMAND, 'ArrowUp'),
      register(KEY_ENTER_COMMAND, 'Enter'),
      register(KEY_ESCAPE_COMMAND, 'Escape'),
      register(KEY_TAB_COMMAND, 'Tab'),
    ]
    return () => cleanups.forEach((cleanup) => cleanup())
  }, [editor, handle])
  return null
}

export interface ComposerEditorHandle {
  focusAt: (caret: number) => void
}

interface ComposerEditorProps {
  value: string
  caret: number
  agents: readonly AgentConfig[]
  skills: readonly SkillConfig[]
  allowBrowser: boolean
  allowComputer: boolean
  allowWork: boolean
  /** The draft's staged pictures; `[Image #n]` up to this count is drawn as a chip. */
  imageCount?: number
  /** The draft's quotes; `[Quote #n]` up to this length is drawn as a pill. */
  quotes?: readonly InlineQuote[]
  placeholder: string
  autoFocus: boolean
  dense: boolean
  /**
   * The composer card bounds the height instead of the editor. The editor stops capping
   * itself, keeps its natural height inside a `[data-composer-scroller]` that takes what
   * the card leaves over and scrolls there. `line` also drops the resting height to one
   * line, for a card that sets its own (a chat's 100px). Absent keeps the editor's own
   * resting height and 200px cap, as the side chat and the phone use.
   */
  fill?: 'rest' | 'line'
  /** Names the field for assistive tech where no visible label does. */
  ariaLabel?: string
  /** False while what was written is on its way, so it cannot change under the send. */
  editable?: boolean
  onChange: (value: string, caret: number, selectionCollapsed: boolean) => void
  onCommand: (key: CommandKey, event: KeyboardEvent, context: CommandContext) => boolean
  onPaste: ClipboardEventHandler<HTMLDivElement>
}

function ComposerEditorInner({ value, caret, agents, skills, allowBrowser, allowComputer, allowWork, imageCount = 0, quotes = NO_QUOTES, placeholder, autoFocus, dense, fill, ariaLabel, editable = true, onChange, onCommand, onPaste }: ComposerEditorProps, ref: ForwardedRef<ComposerEditorHandle>) {
  const [editor] = useLexicalComposerContext()
  const snapshot = useRef({ value, caret })
  const applying = useRef(false)
  const focusedInitially = useRef(false)
  const agentSignature = `${imageCount}:${quotes.map(quoteExcerpt).join('|')}:${allowBrowser}:${allowComputer}:${allowWork}:` + agents.map((agent) => `${agent.id}:${agent.name}:${agent.color}:${agent.avatar ?? ''}:${agent.avatarShape ?? ''}:${agent.avatarTone ?? ''}:${agent.avatarFinish ?? ''}`).join('|') + ':' + skills.map((skill) => `${skill.id}:${skill.name}:${skill.description}`).join('|')
  const agentSignatureRef = useRef(agentSignature)
  const imageCountRef = useRef(imageCount)
  const [history] = useState(createEmptyHistoryState)

  useLayoutEffect(() => {
    const agentsChanged = agentSignatureRef.current !== agentSignature
    if (snapshot.current.value === value && snapshot.current.caret === caret && !agentsChanged) return
    snapshot.current = { value, caret }
    agentSignatureRef.current = agentSignature
    applying.current = true
    // A value applied to an editor without focus (a draft cleared after a send that
    // blurred it) must not put the caret, and so the focus, back into it.
    const root = editor.getRootElement()
    const focused = root !== null && root.contains(document.activeElement)
    // A removed picture renumbered the references; an undo past that point would bring
    // back numbers that now name a different picture. The history starts over from the
    // committed, renumbered text, which stays the state the next edit can undo to.
    const removedPicture = imageCount < imageCountRef.current
    imageCountRef.current = imageCount
    editor.update(() => {
      if (snapshot.current.value !== $composerValue() || agentsChanged) $setComposerValue(value, agents, skills, allowBrowser, allowComputer, allowWork, imageCount, quotes)
      $setCaret(caret)
    }, {
      ...(focused ? {} : { tag: SKIP_DOM_SELECTION_TAG }),
      ...(removedPicture ? { onUpdate: () => {
        history.undoStack.length = 0
        history.redoStack.length = 0
        history.current = { editor, editorState: editor.getEditorState() }
      } } : {}),
    })
    queueMicrotask(() => {
      applying.current = false
    })
  }, [agentSignature, agents, skills, allowBrowser, allowComputer, allowWork, imageCount, quotes, caret, editor, value, history])

  const focusAt = (nextCaret: number) => {
    // A value applied just before this, while the editor had no focus, is committed
    // without the DOM selection. Sharing its commit would leave the browser's own caret
    // at the start of the field, so it commits first.
    editor.read(() => {})
    editor.getRootElement()?.focus({ preventScroll: true })
    editor.update(() => $setCaret(nextCaret))
  }

  useImperativeHandle(ref, () => ({ focusAt }), [focusAt])

  useEffect(() => {
    editor.setEditable(editable)
  }, [editor, editable])

  useEffect(() => {
    if (!autoFocus || focusedInitially.current) return
    focusedInitially.current = true
    focusAt(snapshot.current.value.length)
  }, [autoFocus, focusAt])

  const handleChange = (editorState: EditorState) => {
    editorState.read(() => {
      const nextValue = $composerValue()
      const selection = $readSelection(snapshot.current.caret)
      snapshot.current = { value: nextValue, caret: selection.caret }
      if (!applying.current) onChange(nextValue, selection.caret, selection.collapsed)
    })
  }

  // One line at 3px rather than 4px a side is what lets a Session's card rest at exactly 100px.
  const inset = dense ? 'px-1.5 py-1 text-[14px] leading-normal' : `px-2 ${fill === 'line' ? 'py-[3px]' : 'py-1'} text-[15px] leading-6`
  const restHeight = dense || fill === 'line' ? 'min-h-[30px]' : 'min-h-[56px]'
  return (
    <div
      // In a card the scroller keeps at least the resting height however much else the card
      // holds, and gives way a thousand times faster than a wrapping row of chips beside it.
      // `--composer-reach` is the card's top padding it may scroll into (see `CARD_REACH`);
      // content-box keeps that reach out of the heights the card's hook sets and measures.
      className={fill === undefined ? 'relative min-w-0 flex-1' : `relative box-content min-w-0 flex-auto shrink-[1000] overflow-y-auto ${restHeight} ${REACH}`}
      data-composer-scroller={fill === undefined ? undefined : ''}
      // The card can stand taller than the draft (a Session's resting 100px), and a click
      // in the space under the text still means "write here". Only then: once the text
      // scrolls it fills the scroller, and a press on the scroller itself is its scrollbar.
      onMouseDown={fill === undefined ? undefined : (event) => {
        const scroller = event.currentTarget
        if (event.target !== scroller || scroller.scrollHeight > scroller.clientHeight) return
        event.preventDefault()
        focusAt(snapshot.current.value.length)
      }}
    >
      <RichTextPlugin
        contentEditable={(
          <CompatibleContentEditable
            data-composer-editor="true"
            className={`composer-editor relative block w-full whitespace-pre-wrap [overflow-wrap:break-word] border-0 bg-transparent text-text outline-none ${fill === undefined ? 'max-h-[200px] overflow-y-auto' : ''} ${restHeight} ${inset} [font-family:inherit]`}
            aria-placeholder={placeholder}
            aria-label={ariaLabel ?? placeholder}
            placeholder={<span />}
            onPaste={onPaste}
          />
        )}
        // Absolute sits on the padding box, so the placeholder starts below the scroller's
        // reach into the card, on the line the first word is typed on.
        placeholder={<div className={`pointer-events-none absolute inset-x-0 top-[var(--composer-reach,0px)] bottom-0 truncate text-dim ${inset} [font-family:inherit]`}>{placeholder}</div>}
        ErrorBoundary={LexicalErrorBoundary}
      />
      <OnChangePlugin onChange={handleChange} />
      <CommandPlugin onCommand={onCommand} />
      <MentionDeletionPlugin />
      <MentionPastePlugin agents={agents} skills={skills} allowBrowser={allowBrowser} allowComputer={allowComputer} allowWork={allowWork} imageCount={imageCount} quotes={quotes} />
      <MentionSelectionPlugin />
      <ImageRefDropPlugin imageCount={imageCount} />
      <ListPlugin shouldPreserveNumbering />
      <MarkdownShortcutPlugin transformers={LIST_TRANSFORMERS} />
      <HistoryPlugin externalHistoryState={history} />
    </div>
  )
}

const Inner = forwardRef(ComposerEditorInner)

export const ComposerEditor = forwardRef<ComposerEditorHandle, ComposerEditorProps>(function ComposerEditor(props, ref) {
  // The editor is built once, from the props it mounted with; later ones arrive through `Inner`.
  const [config] = useState<InitialConfigType>(() => {
    const { value, agents, skills, allowBrowser, allowComputer, allowWork, imageCount = 0, quotes = NO_QUOTES } = props
    return {
      namespace: 'manor-composer',
      nodes: [ComposerMentionNode, ListNode, ListItemNode],
      editorState: () => $setComposerValue(value, agents, skills, allowBrowser, allowComputer, allowWork, imageCount, quotes),
      onError: (error) => { throw error },
    }
  })

  return (
    <LexicalComposer initialConfig={config}>
      <Inner {...props} ref={ref} />
    </LexicalComposer>
  )
})
