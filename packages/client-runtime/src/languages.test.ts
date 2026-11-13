import { describe, expect, it } from 'vitest'
import { languageOf } from './highlight'
import { sourceLanguage } from './languages'

describe('sourceLanguage', () => {
  it.each([
    ['src/toolActivity.ts', 'typescript'],
    ['src/Composer.tsx', 'tsx'],
    ['scripts/build.mjs', 'javascript'],
    ['package.json', 'json'],
    ['styles.css', 'css'],
    ['index.html', 'html'],
    ['README.md', 'markdown'],
    ['.github/workflows/ci.yml', 'yaml'],
    ['Cargo.toml', 'toml'],
    ['scripts/release.sh', 'shell'],
    ['tools/run.py', 'python'],
    ['Sources/App.swift', 'swift'],
    ['migrations/001_init.sql', 'sql'],
    ['icon.svg', 'xml'],
    ['Info.plist', 'xml'],
    ['C:\\repo\\src\\main.rs', 'rust'],
  ] as const)('reads %s by extension as %s', (path, language) => {
    expect(sourceLanguage(path)).toBe(language)
  })

  it.each([
    ['Dockerfile', 'dockerfile'],
    ['deploy/Dockerfile.dev', 'dockerfile'],
    ['.env', 'properties'],
    ['.env.example', 'properties'],
    ['.env.local', 'properties'],
    ['.editorconfig', 'properties'],
    ['.zshrc', 'shell'],
    ['.gitignore', 'shell'],
    ['Makefile', 'shell'],
    ['Gemfile', 'ruby'],
    ['pnpm-lock.yaml', 'yaml'],
    ['package-lock.json', 'json'],
    ['Cargo.lock', 'toml'],
    ['uv.lock', 'toml'],
    ['flake.lock', 'json'],
  ] as const)('reads %s by its name as %s', (path, language) => {
    expect(sourceLanguage(path)).toBe(language)
  })

  it('reads an extensionless script by its shebang', () => {
    expect(sourceLanguage('bin/manor', '#!/usr/bin/env node')).toBe('javascript')
    expect(sourceLanguage('bin/setup', '#!/bin/bash -e')).toBe('shell')
    expect(sourceLanguage('bin/tool', '#!/usr/bin/env -S python3 -u')).toBe('python')
    // A shebang never overrides an extension that already names the grammar.
    expect(sourceLanguage('notes.txt', '#!/bin/sh')).toBeNull()
  })

  it.each(['constructor', '__proto__', 'a.constructor', 'bin/toString', 'LICENSE', 'README', 'bin/manor', 'notes.custom-format', 'settings.jsonc', 'styles.scss', 'Component.vue', 'Component.svelte', 'Gemfile.lock'])(
    'leaves %s plain rather than guess a grammar',
    (path) => {
      expect(sourceLanguage(path)).toBeNull()
    },
  )

  it('feeds the phone colourer from the same map', () => {
    expect(languageOf('App.tsx')).toBe('typescript')
    expect(languageOf('.env.example')).toBe('toml')
    expect(languageOf('icon.svg')).toBe('markup')
    expect(languageOf('README.md')).toBe('plain')
    expect(languageOf('bin/setup', '#!/bin/sh')).toBe('shell')
  })
})
