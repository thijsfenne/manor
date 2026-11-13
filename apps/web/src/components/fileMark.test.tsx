import { describe, expect, it } from 'vitest'
import { fileMark } from './fileMarkLoaded'

describe('file marks', () => {
  it.each([
    ['src/App.tsx', 'react', 'text-lang-react'],
    ['vite.config.ts', 'vite', 'text-lang-css'],
    ['package.json', 'json', 'text-lang-data'],
    ['README.md', 'markdown', 'text-lang-doc'],
    ['Dockerfile', 'docker', 'text-lang-html'],
    ['notes', 'default', 'text-dim'],
  ])('resolves %s through the complete Trees set', (path, token, tone) => {
    expect(fileMark(path)).toMatchObject({ token, tone })
  })
})
