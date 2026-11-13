import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { describe, expect, it } from 'vitest'
import { sourceLanguage, sourceTextExtensions } from './TextEditor'

describe('source text languages', () => {
  it.each([
    ['src/toolActivity.ts', 'typescript'],
    ['src/Composer.tsx', 'tsx'],
    ['package.json', 'json'],
    ['tsconfig.json', 'json'],
    ['styles.css', 'css'],
    ['scripts/release.sh', 'shell'],
    ['Dockerfile', 'dockerfile'],
    ['migrations/001_init.sql', 'sql'],
  ] as const)('recognises %s as %s', (path, language) => {
    expect(sourceLanguage(path)).toBe(language)
  })

  it.each(['notes.custom-format', 'settings.jsonc', 'styles.scss', 'Component.vue', 'Component.svelte'])(
    'leaves unsupported %s content readable without guessing a grammar',
    (path) => {
      expect(sourceLanguage(path)).toBeNull()
    },
  )

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
