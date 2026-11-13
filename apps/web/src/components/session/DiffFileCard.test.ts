import { describe, expect, it } from 'vitest'
import type { DiffViewRow } from '../../diffView'
import { rowSyntax } from './DiffFileCard'

const classesOf = (syntax: ReturnType<typeof rowSyntax>, row: DiffViewRow) => syntax?.get(row)?.map((span) => span.className)

describe('rowSyntax', () => {
  it('parses each hunk apart, so a comment cannot run on across a gap', () => {
    const opened: DiffViewRow = { kind: 'added', text: '/* starts here', newNo: 1 }
    const later: DiffViewRow = { kind: 'same', text: 'const n = 2', oldNo: 40, newNo: 41 }
    const syntax = rowSyntax('a.ts', [opened, { kind: 'gap', count: 30 }, later])
    expect(classesOf(syntax, opened)).toEqual(['syn-comment'])
    expect(classesOf(syntax, later)).toContain('syn-keyword')
  })

  it('colours a new extensionless script by its shebang', () => {
    const shebang: DiffViewRow = { kind: 'added', text: '#!/usr/bin/env node', newNo: 1 }
    const code: DiffViewRow = { kind: 'added', text: 'const a = 1', newNo: 2 }
    expect(classesOf(rowSyntax('bin/run', [shebang, code]), code)).toContain('syn-keyword')
  })

  it('leaves a file with no grammar plain', () => {
    expect(rowSyntax('LICENSE', [{ kind: 'added', text: 'MIT', newNo: 1 }])).toBeNull()
  })
})
