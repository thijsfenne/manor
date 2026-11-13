import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { sql } from '@codemirror/lang-sql'
import { yaml } from '@codemirror/lang-yaml'
import { StreamLanguage, type Language, type LanguageSupport } from '@codemirror/language'
import { c, cpp, csharp, dart, java, kotlin } from '@codemirror/legacy-modes/mode/clike'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { go } from '@codemirror/legacy-modes/mode/go'
import { powerShell } from '@codemirror/legacy-modes/mode/powershell'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { ruby } from '@codemirror/legacy-modes/mode/ruby'
import { rust } from '@codemirror/legacy-modes/mode/rust'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { swift } from '@codemirror/legacy-modes/mode/swift'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { xml } from '@codemirror/legacy-modes/mode/xml'
import { highlightCode, tagHighlighter, tags } from '@lezer/highlight'
import type { SourceLanguage } from '@manor/client-runtime/languages'

/**
 * Source colouring for the desktop's code views, the Files panel's editor and the
 * Session diff. Both read the grammar from the shared path map and colour through the
 * one highlighter below, whose `syn-*` classes `styles.css` paints with the syntax
 * tokens, so a line reads the same in either view and in either theme.
 */

/** Built on first use: a grammar costs nothing until a file of its kind is opened. */
const languageMakers: Record<SourceLanguage, () => LanguageSupport | Language> = {
  javascript: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  typescript: () => javascript({ typescript: true }),
  tsx: () => javascript({ jsx: true, typescript: true }),
  json: () => json(),
  css: () => css(),
  html: () => html(),
  xml: () => StreamLanguage.define(xml),
  markdown: () => markdown(),
  python: () => python(),
  sql: () => sql(),
  yaml: () => yaml(),
  toml: () => StreamLanguage.define(toml),
  properties: () => StreamLanguage.define(properties),
  shell: () => StreamLanguage.define(shell),
  powershell: () => StreamLanguage.define(powerShell),
  dockerfile: () => StreamLanguage.define(dockerFile),
  c: () => StreamLanguage.define(c),
  cpp: () => StreamLanguage.define(cpp),
  csharp: () => StreamLanguage.define(csharp),
  java: () => StreamLanguage.define(java),
  kotlin: () => StreamLanguage.define(kotlin),
  dart: () => StreamLanguage.define(dart),
  go: () => StreamLanguage.define(go),
  rust: () => StreamLanguage.define(rust),
  ruby: () => StreamLanguage.define(ruby),
  swift: () => StreamLanguage.define(swift),
}

const built = new Map<SourceLanguage, LanguageSupport | Language>()

/** The editor extension for a grammar, made once and shared by every view. */
export function languageSupport(language: SourceLanguage): LanguageSupport | Language {
  let support = built.get(language)
  if (support === undefined) {
    support = languageMakers[language]()
    built.set(language, support)
  }
  return support
}

export const sourceHighlighter = tagHighlighter([
  { tag: tags.comment, class: 'syn-comment' },
  { tag: [tags.keyword, tags.modifier, tags.self], class: 'syn-keyword' },
  { tag: [tags.string, tags.character, tags.attributeValue, tags.regexp, tags.escape], class: 'syn-string' },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], class: 'syn-number' },
  { tag: [tags.typeName, tags.className, tags.namespace, tags.tagName], class: 'syn-type' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName), tags.definition(tags.variableName)], class: 'syn-function' },
  { tag: [tags.propertyName, tags.attributeName], class: 'syn-property' },
  { tag: [tags.operator, tags.punctuation, tags.meta], class: 'syn-operator' },
  { tag: tags.heading, class: 'syn-keyword' },
  { tag: [tags.link, tags.url], class: 'syn-string' },
])

/** A run of one line's text and the `syn-*` classes it wears, empty for uncoloured text. */
export interface SyntaxSpan {
  text: string
  className: string
}

/**
 * Colours a text outside an editor in one grammar, one span list per line. The parse
 * is synchronous, so the caller keeps the text it hands over bounded.
 */
export function highlightLines(language: SourceLanguage, text: string): SyntaxSpan[][] {
  const support = languageSupport(language)
  const parser = 'language' in support ? support.language.parser : support.parser
  const lines: SyntaxSpan[][] = [[]]
  highlightCode(
    text,
    parser.parse(text),
    sourceHighlighter,
    (code, className) => lines.at(-1)!.push({ text: code, className }),
    () => lines.push([]),
  )
  return lines
}
