import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { LONG_TERM_FILE, LONG_TERM_STARTER } from '../src/memoryCompress.js'
import { ensureMemoryFolder } from '../src/memoryScaffold.js'
import { composeStandingContextBundle, LONG_TERM_HEADING, MAX_STANDING_CONTEXT_CHARS, STANDING_CONTEXT_HEADING } from '../src/standingContext.js'

const dirs: string[] = []
const temp = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'manor-memory-'))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })
const targetOf = (root: string) => ({ dailyDir: path.join(root, 'memory', 'daily') })

describe('a new memory folder', () => {
  it('gets starter files once, and a folder that holds anything is left exactly as it is', async () => {
    const root = path.join(temp(), 'memory')

    expect(await ensureMemoryFolder(root)).toBe(true)
    expect(readFileSync(path.join(root, 'soul.md'), 'utf8')).toContain('# Voice and values')
    expect(readFileSync(path.join(root, 'memory', 'structured', 'MEMORY.md'), 'utf8')).toContain('# Memory index')
    expect(readFileSync(path.join(root, LONG_TERM_FILE), 'utf8')).toBe(LONG_TERM_STARTER)
    writeFileSync(path.join(root, 'soul.md'), 'Mine now.')
    expect(await ensureMemoryFolder(root)).toBe(false)
    expect(readFileSync(path.join(root, 'soul.md'), 'utf8')).toBe('Mine now.')

    const kept = path.join(temp(), 'notes')
    mkdirSync(kept)
    writeFileSync(path.join(kept, 'README.md'), 'A folder somebody already keeps.')
    expect(await ensureMemoryFolder(kept)).toBe(false)
    expect(() => readFileSync(path.join(kept, 'soul.md'))).toThrow()
  })
})

describe('standing context', () => {
  it('carries the starter files of a new folder into the prompt', async () => {
    const root = path.join(temp(), 'memory')
    await ensureMemoryFolder(root)

    const bundle = await composeStandingContextBundle(targetOf(root), [])
    expect(bundle.text.startsWith(STANDING_CONTEXT_HEADING)).toBe(true)
    expect(bundle.sources.map((source) => path.basename(source.path))).toEqual(['soul.md', 'rules.md', 'user-core.md'])
    expect(bundle.text).toContain('# About me')
    // The long-term file holds no fact yet, so it costs the prompt nothing.
    expect(bundle.text).not.toContain(LONG_TERM_HEADING)
  })

  it('carries distilled facts last, under their own heading', async () => {
    const root = path.join(temp(), 'memory')
    await ensureMemoryFolder(root)
    writeFileSync(path.join(root, LONG_TERM_FILE), `${LONG_TERM_STARTER}\n- Ships on Fridays (2026-11-09)\n`)

    const bundle = await composeStandingContextBundle(targetOf(root), [])
    expect(bundle.text.indexOf(LONG_TERM_HEADING)).toBeGreaterThan(bundle.text.indexOf('# About me'))
    expect(bundle.text.endsWith('- Ships on Fridays (2026-11-09)')).toBe(true)

    // Carried even when the folder instructions already brought every standing file.
    const only = await composeStandingContextBundle(targetOf(root), ['soul.md', 'rules.md', 'user-core.md'].map((name) => path.join(root, name)))
    expect(only.text.startsWith(LONG_TERM_HEADING)).toBe(true)
  })

  it('leaves out a file the folder instructions already carried, even through a link', async () => {
    const root = path.join(temp(), 'memory')
    await ensureMemoryFolder(root)
    const linked = path.join(temp(), 'rules.md')
    symlinkSync(path.join(root, 'rules.md'), linked)

    const bundle = await composeStandingContextBundle(targetOf(root), [linked, path.join(root, 'soul.md')])
    expect(bundle.sources.map((source) => path.basename(source.path))).toEqual(['user-core.md'])

    const all = await composeStandingContextBundle(targetOf(root), [linked, path.join(root, 'soul.md'), path.join(root, 'user-core.md')])
    expect(all).toEqual({ text: '', sources: [] })
  })

  it('says which file it left out when one is overgrown, and is silent without a folder', async () => {
    const root = path.join(temp(), 'memory')
    await ensureMemoryFolder(root)
    writeFileSync(path.join(root, 'rules.md'), 'x'.repeat(MAX_STANDING_CONTEXT_CHARS))

    const bundle = await composeStandingContextBundle(targetOf(root), [])
    expect(bundle.sources.map((source) => path.basename(source.path))).toEqual(['soul.md', 'user-core.md'])
    expect(bundle.text).toContain('rules.md')
    expect(await composeStandingContextBundle(targetOf(path.join(temp(), 'missing')), [])).toEqual({ text: '', sources: [] })
  })
})
