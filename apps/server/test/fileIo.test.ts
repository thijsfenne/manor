import { chmodSync, mkdtempSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { hashBytes, replaceTextFile } from '../src/fileIo.js'

const fixture = (name: string, content: string, mode = 0o644) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'manor-fileio-'))
  const target = path.join(dir, name)
  writeFileSync(target, content, 'utf8')
  chmodSync(target, mode)
  return { dir, target, revision: hashBytes(Buffer.from(content, 'utf8')) }
}

describe('replaceTextFile', () => {
  it('does not follow a symlink planted where the old fixed temporary name lived', async () => {
    const { dir, target, revision } = fixture('note.md', 'before')
    const elsewhere = path.join(dir, 'elsewhere.txt')
    writeFileSync(elsewhere, 'untouched', 'utf8')
    symlinkSync(elsewhere, path.join(dir, '.note.md.manor-tmp'))

    const result = await replaceTextFile(target, Buffer.from('after'), revision)

    expect(result.kind).toBe('saved')
    expect(readFileSync(target, 'utf8')).toBe('after')
    expect(readFileSync(elsewhere, 'utf8')).toBe('untouched')
  })

  it('lets exactly one of two saves from the same revision win, the other comes back stale', async () => {
    const { dir, target, revision } = fixture('note.md', 'base')

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) => replaceTextFile(target, Buffer.from(`save ${index}`), revision)),
    )

    const saved = results.filter((result) => result.kind === 'saved')
    expect(saved).toHaveLength(1)
    expect(results.filter((result) => result.kind === 'stale')).toHaveLength(9)
    expect(hashBytes(readFileSync(target))).toBe(saved[0]?.kind === 'saved' ? saved[0].revision : '')
    expect(readdirSync(dir).filter((name) => name.endsWith('.manor-tmp'))).toEqual([])
  })

  it.each([0o600, 0o755])('keeps mode %o across a save', async (mode) => {
    const { target, revision } = fixture('script.sh', 'echo hi\n', mode)

    await replaceTextFile(target, Buffer.from('echo bye\n'), revision)

    expect(statSync(target).mode & 0o777).toBe(mode)
  })
})
