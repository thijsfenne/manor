import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readContextFiles, saveContextFile } from '../src/contextFiles.js'

const sha256 = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')

const checkout = (files: Record<string, string>) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'manor-context-'))
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(root, name), content, 'utf8')
  return root
}

describe('context files', () => {
  it('lists the files that exist with their hash and leaves the rest out', async () => {
    const root = checkout({ 'soul.md': 'soul', 'rules.md': 'rules' })

    const listed = await readContextFiles(root)

    expect(listed.root).toBe(root)
    expect(listed.files.map(({ name, content, hash }) => ({ name, content, hash }))).toEqual([
      { name: 'soul.md', content: 'soul', hash: sha256('soul') },
      { name: 'rules.md', content: 'rules', hash: sha256('rules') },
    ])
    expect(Number.isNaN(Date.parse(listed.files[0]?.updatedAt ?? ''))).toBe(false)
  })

  it('saves against the current hash and returns the new one', async () => {
    const root = checkout({ 'style.md': 'before' })

    const saved = await saveContextFile(root, 'style.md', 'after', sha256('before'))

    expect(saved).toMatchObject({ ok: true, file: { name: 'style.md', content: 'after', hash: sha256('after') } })
    expect(readFileSync(path.join(root, 'style.md'), 'utf8')).toBe('after')
  })

  it('refuses a stale hash, leaves the file alone and returns what is on disk', async () => {
    const root = checkout({ 'style.md': 'edited elsewhere' })

    const saved = await saveContextFile(root, 'style.md', 'mine', sha256('what I opened'))

    expect(saved).toMatchObject({
      ok: false,
      reason: 'stale',
      current: { content: 'edited elsewhere', hash: sha256('edited elsewhere') },
    })
    expect(readFileSync(path.join(root, 'style.md'), 'utf8')).toBe('edited elsewhere')
  })

  it('writes through a symlink to its target and keeps the link', async () => {
    const root = checkout({})
    const elsewhere = path.join(root, 'shared')
    mkdirSync(elsewhere)
    const target = path.join(elsewhere, 'soul.md')
    writeFileSync(target, 'before', 'utf8')
    symlinkSync(target, path.join(root, 'soul.md'))

    const saved = await saveContextFile(root, 'soul.md', 'after', sha256('before'))

    expect(saved.ok).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('after')
    expect(lstatSync(path.join(root, 'soul.md')).isSymbolicLink()).toBe(true)
  })

  it('has nothing to read or write without a local checkout', async () => {
    expect(await readContextFiles(null)).toEqual({ root: null, files: [] })
    expect(await saveContextFile(null, 'soul.md', 'text', sha256(''))).toEqual({ ok: false, reason: 'unavailable' })
  })

  it('refuses a file that is not on disk and never creates it', async () => {
    const root = checkout({})

    expect(await saveContextFile(root, 'thinking.md', 'new', sha256(''))).toEqual({ ok: false, reason: 'missing' })
    expect(existsSync(path.join(root, 'thinking.md'))).toBe(false)
  })
})
