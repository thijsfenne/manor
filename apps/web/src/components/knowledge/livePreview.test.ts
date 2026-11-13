import { syntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { livePreviewDecorationSet, livePreviewExtensions } from './livePreview'

function note(doc: string) {
  return EditorState.create({ doc, extensions: livePreviewExtensions() })
}

function widgetNames(state: EditorState, editingLines: number[] = []) {
  const names: string[] = []
  livePreviewDecorationSet(state, editingLines).between(0, state.doc.length, (_from, _to, deco) => {
    const name = deco.spec.widget?.constructor.name
    if (name !== undefined) names.push(name)
  })
  return names
}

function listPadding(state: EditorState, editingLines: number[] = []) {
  const styles: string[] = []
  livePreviewDecorationSet(state, editingLines).between(0, state.doc.length, (_from, _to, deco) => {
    const style = deco.spec.attributes?.style
    if (style?.includes('padding-left') === true) styles.push(style)
  })
  return styles
}

describe('live preview lists', () => {
  it('parses markdown list marks', () => {
    const tree = syntaxTree(note('- Alpha\n- Beta')).toString()
    expect(tree).toContain('ListMark')
  })

  it('replaces unordered marks with discs when the caret is elsewhere', () => {
    expect(widgetNames(note('- Alpha\n- Beta'))).toEqual(['BulletWidget', 'BulletWidget'])
  })

  it('indents the whole list item, including a nested one a step further', () => {
    expect(listPadding(note('- Alpha\n  - Nested'))).toEqual(['padding-left:1.5em', 'padding-left:3em'])
  })

  it('gives the markdown marker back on the line being edited', () => {
    const state = note('- Alpha\n- Beta')
    expect(widgetNames(state, [1])).toEqual(['BulletWidget'])
    expect(listPadding(state, [1])).toEqual(['padding-left:1.5em', 'padding-left:1.5em'])
  })

  it('keeps ordered marks as numbers', () => {
    expect(widgetNames(note('1. First\n2. Second'))).toEqual(['NumberWidget', 'NumberWidget'])
  })

  it('replaces the marker and box with one checkbox, nested or not', () => {
    const state = note('- [ ] One\n  - [x] Two')
    expect(widgetNames(state)).toEqual(['TaskWidget', 'TaskWidget'])
    expect(listPadding(state)).toEqual(['padding-left:1.5em', 'padding-left:3em'])
  })

  it('hangs the revealed source in the marker slot on the caret line', () => {
    const state = note('  - [ ] Two')
    const hung: string[] = []
    livePreviewDecorationSet(state, [1]).between(0, state.doc.length, (from, to, deco) => {
      if (deco.spec.class === 'cm-manor-listsrc') hung.push(state.doc.sliceString(from, to))
    })
    expect(hung).toEqual(['- [ ] '])
  })
})

describe('live preview note links', () => {
  it('keeps the real target behind an aliased, keyboard reachable link', () => {
    const state = note('Read [[projects/Research plan#Questions|the plan]].')
    const links: Record<string, string>[] = []
    livePreviewDecorationSet(state, []).between(0, state.doc.length, (_from, _to, deco) => {
      if (deco.spec.attributes?.role === 'link') links.push(deco.spec.attributes)
    })
    expect(links).toEqual([expect.objectContaining({ 'data-note-target': 'projects/Research plan#Questions', tabindex: '0' })])
  })
})


describe('fenced code language markers', () => {
  const hiddenText = (state: EditorState, editing: number[]) => {
    const text: string[] = []
    livePreviewDecorationSet(state, editing).between(0, state.doc.length, (from, to, deco) => {
      if (deco.spec.widget === undefined && from < to && deco.spec.class === undefined && deco.spec.attributes === undefined) text.push(state.doc.sliceString(from, to))
    })
    return text
  }

  it('moves the language to a corner label with the fences hidden, and reveals both fences for source editing', () => {
    const state = note('```bash\ncurl -I http://localhost:43179\n```')
    expect(widgetNames(state)).toEqual(['CodeLanguageWidget'])
    expect(hiddenText(state, [])).toEqual(['```'])
    // The caret anywhere inside the block brings back both fences and the language.
    for (const line of [1, 2, 3]) {
      expect(widgetNames(state, [line])).toEqual([])
      expect(hiddenText(state, [line])).toEqual([])
    }
    expect(state.doc.toString()).toContain('```bash')
  })
})

describe('live preview gaps between blocks', () => {
  const gaps = (state: EditorState) => {
    const found: { at: number; height: number }[] = []
    state.facet(EditorView.decorations).forEach((source) => {
      if (typeof source === 'function') return
      source.between(0, state.doc.length, (from, _to, deco) => {
        if (deco.spec.widget?.constructor.name === 'GapWidget') found.push({ at: state.doc.lineAt(from).number, height: deco.spec.widget.estimatedHeight })
      })
    })
    return found
  }

  it('adds the block gap where blocks touch, and nothing where a blank line already separates them', () => {
    expect(gaps(note('```\ncode\n```\n> [!note] Title\n> body'))).toEqual([{ at: 4, height: 25.6 }])
    expect(gaps(note('Text\n\n> quote\n\nText'))).toEqual([])
    expect(gaps(note('Text\n> quote\n\n- item'))).toEqual([{ at: 2, height: 25.6 }])
  })

  it('takes a half gap under a heading', () => {
    expect(gaps(note('## Title\n> quote'))).toEqual([{ at: 2, height: 12.8 }])
  })
})

describe('live preview links and done to-dos', () => {
  const attributes = (state: EditorState, editing: number[]) => {
    const found: Record<string, string>[] = []
    livePreviewDecorationSet(state, editing).between(0, state.doc.length, (_from, _to, deco) => {
      if (deco.spec.class === 'cm-manor-link') found.push(deco.spec.attributes)
    })
    return found
  }

  it('shows only the label of a markdown link off the caret line', () => {
    const state = note('See [the site](https://example.com) now')
    const hidden = (editing: number[]) => {
      const text: string[] = []
      livePreviewDecorationSet(state, editing).between(0, state.doc.length, (from, to, deco) => {
        if (deco.spec.widget === undefined && from < to && deco.spec.class === undefined && deco.spec.attributes === undefined) text.push(state.doc.sliceString(from, to))
      })
      return text.join('')
    }
    expect(hidden([])).toBe('[](https://example.com)')
    expect(hidden([1])).toBe('')
  })

  it('opens a markdown link on a plain click only when its line is not being edited', () => {
    const state = note('See [the site](https://example.com) now')
    expect(attributes(state, [])).toEqual([{ 'data-href': 'https://example.com' }])
    expect(attributes(state, [1])).toEqual([{ 'data-href-edit': 'https://example.com' }])
  })

  it('mutes a done item and leaves an open one alone', () => {
    const state = note('- [x] shipped\n- [ ] open')
    const done: string[] = []
    livePreviewDecorationSet(state, []).between(0, state.doc.length, (from, to, deco) => {
      if (deco.spec.class === 'cm-manor-task-done') done.push(state.doc.sliceString(from, to))
    })
    expect(done).toEqual(['shipped'])
  })
})
