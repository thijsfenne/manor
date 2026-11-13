import { describe, expect, it } from 'vitest'
import { highlight, languageOf, languageOfFence } from './highlight'

const kinds = (code: string, language: string) =>
  highlight(code, language).map((line) => line.map((token) => `${token.kind}:${token.text}`))

describe('languageOf', () => {
  it('reads extensions and well-known names', () => {
    expect(languageOf('apps/web/src/App.tsx')).toBe('typescript')
    expect(languageOf('Dockerfile')).toBe('shell')
    expect(languageOf('README')).toBe('plain')
    expect(languageOf('x.unknownext')).toBe('plain')
  })
  it('reads fence info strings', () => {
    expect(languageOfFence('ts')).toBe('typescript')
    expect(languageOfFence('bash title=x')).toBe('shell')
    expect(languageOfFence('')).toBe('plain')
  })
})

describe('highlight', () => {
  it('colours typescript', () => {
    expect(kinds(`const n: number = 42 // hi\nfoo.bar(baz)`, 'typescript')).toEqual([
      ['keyword:const', 'plain: ', 'plain:n', 'punctuation::', 'plain: ', 'type:number', 'plain: ', 'punctuation:=', 'plain: ', 'number:42', 'plain: ', 'comment:// hi'],
      ['plain:foo', 'punctuation:.', 'function:bar', 'punctuation:(', 'plain:baz', 'punctuation:)'],
    ])
  })
  it('keeps a multi-line comment across lines', () => {
    expect(kinds('/* a\nb */ x', 'javascript')).toEqual([['comment:/* a'], ['comment:b */', 'plain: ', 'plain:x']])
  })
  it('colours python and shell', () => {
    expect(kinds('def f(x):\n    return "s"', 'python')[0]).toEqual(['keyword:def', 'plain: ', 'function:f', 'punctuation:(', 'plain:x', 'punctuation:)', 'punctuation::'])
    expect(kinds('echo "$HOME" # x', 'shell')[0]).toEqual(['keyword:echo', 'plain: ', 'string:"$HOME"', 'plain: ', 'comment:# x'])
  })
  it('colours json keys as strings and literals as keywords', () => {
    expect(kinds('{"a": true}', 'json')[0]).toEqual(['punctuation:{', 'string:"a"', 'punctuation::', 'plain: ', 'keyword:true', 'punctuation:}'])
  })
  it('colours yaml keys and markup tags', () => {
    expect(kinds('name: Manor', 'yaml')[0]).toEqual(['property:name', 'punctuation::', 'plain: ', 'plain:Manor'])
    expect(kinds('<div class="x">', 'markup')[0]).toEqual(['tag:<div', 'plain: ', 'attribute:class', 'punctuation:=', 'string:"x"', 'punctuation:>'])
  })
  it('passes plain text through, one token per line', () => {
    expect(kinds('a\n\nb', 'plain')).toEqual([['plain:a'], [], ['plain:b']])
  })
})
