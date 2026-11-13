import { describe, expect, it } from 'vitest'
import { sourceLanguage } from '@manor/client-runtime/languages'
import { highlightLines } from './sourceSyntax'

const classesOf = (path: string, text: string) =>
  new Set(highlightLines(sourceLanguage(path, text.split('\n', 1)[0])!, text).flat().map((span) => span.className).filter(Boolean))

describe('highlightLines', () => {
  it.each([
    ['a.ts', 'const n: number = 1', 'syn-keyword'],
    ['a.tsx', 'export const A = () => <main />', 'syn-type'],
    ['a.js', '// note\nlet x = 1', 'syn-comment'],
    ['a.json', '{"a": true}', 'syn-number'],
    ['a.css', '.a { color: red; }', 'syn-property'],
    ['a.html', '<div class="x"></div>', 'syn-type'],
    ['a.md', '# Title', 'syn-keyword'],
    ['a.yaml', 'name: manor', 'syn-property'],
    ['a.toml', '[package]\nname = "manor"', 'syn-string'],
    ['a.sh', 'echo "hi" # x', 'syn-comment'],
    ['a.py', 'def f():\n  return 1', 'syn-keyword'],
    ['a.swift', 'let x = "s"', 'syn-keyword'],
    ['a.sql', 'select 1 from t', 'syn-keyword'],
    ['a.svg', '<svg width="1"></svg>', 'syn-type'],
    ['Dockerfile', 'FROM node:22\nRUN pnpm i', 'syn-keyword'],
    ['.env.example', '# key\nAPI_URL=http://localhost', 'syn-comment'],
    ['pnpm-lock.yaml', 'lockfileVersion: 9.0', 'syn-property'],
    ['bin/run', '#!/usr/bin/env node\nconst a = 1', 'syn-keyword'],
  ])('colours %s', (path, text, expected) => {
    expect(classesOf(path, text)).toContain(expected)
  })

  it('keeps one span list per line, with a comment colouring across lines', () => {
    const lines = highlightLines('typescript', '/* a\nb */ const x = 1')
    expect(lines).toHaveLength(2)
    expect(lines[1]![0]).toEqual({ text: 'b */', className: 'syn-comment' })
  })
})
