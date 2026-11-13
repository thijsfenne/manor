import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import type { AgentConfig, InlineQuote, SkillConfig } from '@manor/contracts'
import { $isListItemNode, $isListNode } from '@lexical/list'
import { $convertToMarkdownString, ORDERED_LIST, UNORDERED_LIST } from '@lexical/markdown'
import { registerRichText } from '@lexical/rich-text'
import { $getRoot, $getSelection, $isElementNode, $isRangeSelection, KEY_BACKSPACE_COMMAND, KEY_ENTER_COMMAND, PASTE_COMMAND, UNDO_COMMAND, type LexicalEditor } from 'lexical'
import { act, createRef } from 'react'
import { create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposerEditor, type ComposerEditorHandle } from '../src/components/ComposerEditor'

let lexicalEditor: LexicalEditor

// Keep the real editor state and registered nodes while leaving its DOM view out of
// this component test. The composer integration suite covers the surrounding UI.
vi.mock('@lexical/react/LexicalRichTextPlugin', () => ({
  RichTextPlugin: function HeadlessEditor() {
    [lexicalEditor] = useLexicalComposerContext()
    return null
  },
}))

const sage = {
  id: 'sage',
  name: 'Sage',
  color: '#8b5cf6',
  driver: 'claude',
  model: 'claude-opus-5',
  effort: 'high',
  allowedTools: [],
} as unknown as AgentConfig

const distill = {
  id: 'distill',
  name: 'Distill',
  description: 'Writes a note to the vault.',
} as unknown as SkillConfig

const editorRef = createRef<ComposerEditorHandle>()
let renderer: ReactTestRenderer | undefined

class TestClipboardEvent extends Event {
  readonly clipboardData: DataTransfer

  constructor(text: string) {
    super('paste', { cancelable: true })
    this.clipboardData = {
      files: [],
      getData: (type: string) => type === 'text/plain' ? text : '',
    } as unknown as DataTransfer
  }
}

const QUOTES: InlineQuote[] = [
  { kind: 'note', path: 'inbox/a.md', text: 'First selected words' },
  { kind: 'message', eventId: 'evt_1', text: 'Second selected words' },
]

const composer = (value: string, caret = value.length, onCommand: (...args: unknown[]) => boolean = () => false, editorKey = 'composer', onChange: (value: string) => void = () => {}, quotes: readonly InlineQuote[] = []) => (
  <ComposerEditor
    key={editorKey}
    ref={editorRef}
    value={value}
    caret={caret}
    agents={[sage]}
    skills={[distill]}
    allowBrowser
    allowComputer
    allowWork
    quotes={quotes}
    placeholder="Message the house"
    autoFocus={false}
    dense={false}
    onChange={onChange}
    onCommand={onCommand}
    onPaste={() => {}}
  />
)

async function renderEditor(value: string, caret = value.length, editorKey = 'composer') {
  await act(() => {
    if (renderer) renderer.update(composer(value, caret, () => false, editorKey))
    else renderer = create(composer(value, caret, () => false, editorKey))
  })
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('document', { activeElement: null })
})

afterEach(async () => {
  await act(() => renderer?.unmount())
  renderer = undefined
  vi.unstubAllGlobals()
})

describe('the desktop composer editor', () => {
  it('renders agents, Browser, Computer, Work and skills as atomic nodes without changing the message text', async () => {
    const value = 'Vraag @Sage om $distill in @browser en @computer te gebruiken en naar @work te sturen.'
    await renderEditor(value)

    lexicalEditor.getEditorState().read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow()
      if (!$isElementNode(paragraph)) throw new Error('Expected a composer paragraph')
      const mentions = paragraph.getChildren().filter((node) => node.getType() === 'composer-mention')
      expect(mentions.map((node) => node.getTextContent())).toEqual(['@Sage', '$distill', '@browser', '@computer', '@work'])
      expect(mentions.every((node) => node.isInline())).toBe(true)
      expect($getRoot().getTextContent()).toBe(value)
    })
  })

  it('turns a programmatically completed mention into a pill and preserves newlines', async () => {
    await renderEditor('Vraag @Sa')
    await renderEditor('Vraag @Sage \nvolgende regel')

    lexicalEditor.getEditorState().read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow()
      if (!$isElementNode(paragraph)) throw new Error('Expected a composer paragraph')
      expect(paragraph.getChildren().some((node) => node.getType() === 'composer-mention')).toBe(true)
      expect($convertToMarkdownString([UNORDERED_LIST, ORDERED_LIST], undefined, true)).toBe('Vraag @Sage \nvolgende regel')
    })
  })

  it('sends the markdown he typed unescaped and keeps a typed backslash on reload', async () => {
    const value = '**vet**, _schuin_, `code` en \\* letterlijk'
    const onChange = vi.fn()
    await act(() => {
      renderer = create(composer(value, value.length, () => false, 'composer', onChange))
    })
    expect(lexicalEditor.getEditorState().read(() => $getRoot().getTextContent())).toBe(value)

    await act(() => {
      lexicalEditor.update(() => $getRoot().selectEnd().insertText('!'), { discrete: true })
    })
    expect(onChange).toHaveBeenLastCalledWith(`${value}!`, expect.any(Number), expect.any(Boolean))
  })

  it('does not carry undo history into another draft', async () => {
    await renderEditor('draft A', 7, 'chat-a')
    await act(() => {
      lexicalEditor.update(() => $getRoot().selectEnd().insertText(' changed'), { discrete: true })
    })

    await renderEditor('draft B', 7, 'chat-b')
    await act(() => {
      lexicalEditor.dispatchCommand(UNDO_COMMAND, undefined)
    })

    expect(lexicalEditor.getEditorState().read(() => $getRoot().getTextContent())).toBe('draft B')
  })

  it('renders Markdown markers as semantic bullet and numbered lists', async () => {
    await renderEditor('- first\n- second\n1. third\n2. fourth')

    lexicalEditor.getEditorState().read(() => {
      const lists = $getRoot().getChildren().filter($isListNode)
      expect(lists.map((list) => list.getListType())).toEqual(['bullet', 'number'])
      expect(lists.map((list) => list.getChildrenSize())).toEqual([2, 2])
      expect($convertToMarkdownString([UNORDERED_LIST, ORDERED_LIST], undefined, true)).toBe('- first\n- second\n1. third\n2. fourth')
    })
  })

  it.each(['-', '•'])('turns a typed %s shortcut into a semantic bullet list', async (marker) => {
    await renderEditor('')

    await act(() => {
      lexicalEditor.update(() => {
        $getRoot().selectEnd().insertText(marker)
      }, { discrete: true })
    })
    await act(() => {
      lexicalEditor.update(() => {
        const selection = $getSelection()
        if (!$isRangeSelection(selection)) throw new Error('Expected a text caret')
        selection.insertText(' ')
      }, { discrete: true })
    })

    lexicalEditor.getEditorState().read(() => {
      const list = $getRoot().getFirstChildOrThrow()
      expect($isListNode(list)).toBe(true)
      expect($isListNode(list) ? list.getListType() : null).toBe('bullet')
    })
  })

  it('starts a semantic bullet list after a normal line', async () => {
    await renderEditor('Intro')
    const event = { shiftKey: true, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent
    const unregister = registerRichText(lexicalEditor)

    await act(() => {
      lexicalEditor.update(() => {
        $getRoot().selectEnd()
        lexicalEditor.dispatchCommand(KEY_ENTER_COMMAND, event)
      }, { discrete: true })
    })
    await act(() => {
      lexicalEditor.update(() => {
        $getSelection()?.insertText('-')
      }, { discrete: true })
    })
    await act(() => {
      lexicalEditor.update(() => {
        $getSelection()?.insertText(' ')
      }, { discrete: true })
    })

    lexicalEditor.getEditorState().read(() => {
      expect($getRoot().getChildren().map((node) => node.getType())).toEqual(['paragraph', 'list'])
      const list = $getRoot().getLastChildOrThrow()
      expect($isListNode(list) ? list.getListType() : null).toBe('bullet')
      expect($convertToMarkdownString([UNORDERED_LIST, ORDERED_LIST], undefined, true)).toBe('Intro\n- ')
    })
    unregister()
  })

  it('removes a whole pill with one backspace', async () => {
    await renderEditor('@Sage schrijf mee')
    const prevented = vi.fn()

    await act(() => {
      lexicalEditor.update(() => {
        const paragraph = $getRoot().getFirstChildOrThrow()
        if (!$isElementNode(paragraph)) throw new Error('Expected a composer paragraph')
        paragraph.select(1, 1)
        lexicalEditor.dispatchCommand(KEY_BACKSPACE_COMMAND, { preventDefault: prevented } as unknown as KeyboardEvent)
      }, { discrete: true })
    })

    expect(prevented).toHaveBeenCalledOnce()
    expect(lexicalEditor.getEditorState().read(() => $getRoot().getTextContent())).toBe(' schrijf mee')
  })

  it('holds two quote pills in the sentence, takes one with a backspace and gets it back on undo', async () => {
    const value = 'is [Quote #1] better than [Quote #2] here'
    const pills = () => lexicalEditor.getEditorState().read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow()
      if (!$isElementNode(paragraph)) throw new Error('Expected a composer paragraph')
      return paragraph.getChildren().filter((node) => node.getType() === 'composer-mention').map((node) => node.getTextContent())
    })
    const text = () => lexicalEditor.getEditorState().read(() => $getRoot().getTextContent())
    await act(() => {
      renderer = create(composer(value, value.indexOf(' better'), () => false, 'composer', () => {}, QUOTES))
    })
    expect(pills()).toEqual(['[Quote #1]', '[Quote #2]'])
    expect(text()).toBe(value)

    await act(() => {
      lexicalEditor.update(() => {
        const paragraph = $getRoot().getFirstChildOrThrow()
        if (!$isElementNode(paragraph)) throw new Error('Expected a composer paragraph')
        paragraph.select(2, 2)
        lexicalEditor.dispatchCommand(KEY_BACKSPACE_COMMAND, { preventDefault: vi.fn() } as unknown as KeyboardEvent)
      }, { discrete: true })
    })
    expect(pills()).toEqual(['[Quote #2]'])
    expect(text()).toBe('is  better than [Quote #2] here')

    await act(() => {
      lexicalEditor.dispatchCommand(UNDO_COMMAND, undefined)
    })
    expect(pills()).toEqual(['[Quote #1]', '[Quote #2]'])
  })

  it('leaves a quote number past the draft\'s list as prose', async () => {
    await act(() => {
      renderer = create(composer('see [Quote #3]', 14, () => false, 'composer', () => {}, QUOTES))
    })
    lexicalEditor.getEditorState().read(() => {
      expect($getRoot().getAllTextNodes().map((node) => node.getTextContent())).toEqual(['see [Quote #3]'])
    })
  })

  it('hands list commands the live text and caret', async () => {
    const onCommand = vi.fn(() => true)
    await act(() => {
      if (renderer) renderer.update(composer('• first', 7, onCommand))
      else renderer = create(composer('• first', 7, onCommand))
    })
    const event = { shiftKey: true, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent

    await act(() => {
      lexicalEditor.update(() => {
        $getRoot().selectEnd()
        lexicalEditor.dispatchCommand(KEY_ENTER_COMMAND, event)
      }, { discrete: true })
    })

    expect(onCommand).toHaveBeenCalledWith('Enter', event, {
      value: '- first',
      caret: 7,
      selectionCollapsed: true,
    })
  })

  it('continues a semantic list with Shift + Enter', async () => {
    await renderEditor('- first')
    const event = { shiftKey: true, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent
    const unregister = registerRichText(lexicalEditor)

    await act(() => {
      lexicalEditor.update(() => {
        const list = $getRoot().getFirstChildOrThrow()
        if (!$isListNode(list)) throw new Error('Expected a bullet list')
        const item = list.getFirstChildOrThrow()
        if (!$isListItemNode(item)) throw new Error('Expected a list item')
        item.getLastDescendant()?.selectEnd()
        lexicalEditor.dispatchCommand(KEY_ENTER_COMMAND, event)
      }, { discrete: true })
    })

    lexicalEditor.getEditorState().read(() => {
      const list = $getRoot().getFirstChildOrThrow()
      if (!$isListNode(list)) throw new Error('Expected a bullet list')
      expect(list.getChildrenSize()).toBe(2)
      expect($convertToMarkdownString([UNORDERED_LIST, ORDERED_LIST], undefined, true)).toBe('- first\n- ')
    })
    unregister()
  })

  it('leaves a semantic list from an empty item', async () => {
    await renderEditor('- first\n- ')
    const event = { shiftKey: true, preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as KeyboardEvent

    await act(() => {
      lexicalEditor.update(() => {
        const list = $getRoot().getFirstChildOrThrow()
        if (!$isListNode(list)) throw new Error('Expected a bullet list')
        list.getLastChildOrThrow().selectEnd()
        lexicalEditor.dispatchCommand(KEY_ENTER_COMMAND, event)
      }, { discrete: true })
    })

    lexicalEditor.getEditorState().read(() => {
      expect($getRoot().getChildren().map((node) => node.getType())).toEqual(['list', 'paragraph'])
      expect($convertToMarkdownString([UNORDERED_LIST, ORDERED_LIST], undefined, true)).toBe('- first\n')
    })
  })

  it('keeps pasted mentions atomic and pasted text unchanged', async () => {
    await renderEditor('Voor: ')
    const event = new TestClipboardEvent('@Sage, $distill en @browser')
    const paragraphKey = lexicalEditor.getEditorState().read(() => $getRoot().getFirstChildOrThrow().getKey())

    await act(() => {
      lexicalEditor.update(() => {
        $getRoot().selectEnd()
        lexicalEditor.dispatchCommand(PASTE_COMMAND, event as ClipboardEvent)
      }, { discrete: true })
    })

    expect(event.defaultPrevented).toBe(true)
    lexicalEditor.getEditorState().read(() => {
      const paragraph = $getRoot().getFirstChildOrThrow()
      if (!$isElementNode(paragraph)) throw new Error('Expected a composer paragraph')
      expect(paragraph.getKey()).toBe(paragraphKey)
      expect(paragraph.getChildren().filter((node) => node.getType() === 'composer-mention')).toHaveLength(3)
      expect($getRoot().getTextContent()).toBe('Voor: @Sage, $distill en @browser')
    })
  })
})
