import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { sourceTextExtensions } from './TextEditor'

describe('source text extensions', () => {
  it('parses TypeScript with JSX before applying token colours', () => {
    const state = EditorState.create({
      doc: 'export const App = () => <main>Hello</main>',
      extensions: sourceTextExtensions('App.tsx'),
    })

    expect(ensureSyntaxTree(state, state.doc.length, 1_000)?.toString()).toContain('JSXElement')
  })

  it('wraps long source lines by default', () => {
    const state = EditorState.create({ extensions: sourceTextExtensions('App.tsx') })

    expect(state.facet(EditorView.contentAttributes)).toContainEqual({ class: 'cm-lineWrapping' })
  })

  it('can omit code gutters for prose files', () => {
    const numbered = sourceTextExtensions('App.tsx')
    const unnumbered = sourceTextExtensions('App.tsx', { lineNumbers: false })

    expect(numbered).toHaveLength(unnumbered.length + 1)
  })
})
