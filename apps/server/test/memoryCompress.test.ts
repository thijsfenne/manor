import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { RuntimeEvent, TurnInput } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import {
  applyLongTermOps,
  createMemoryCompressor,
  LONG_TERM_FILE,
  LONG_TERM_MAX_LINES,
  LONG_TERM_STARTER,
  parseLongTermOps,
} from '../src/memoryCompress.js'
import { scratchFor, scripted } from './helpers.js'

const result = (value: unknown): RuntimeEvent[] => [{ type: 'result', text: JSON.stringify(value) }]
const now = () => new Date(2026, 10, 10, 9, 0)

/** A memory folder with the long-term file and the given days of daily log. */
async function folder(days: Record<string, string>, longTerm: string | null = LONG_TERM_STARTER) {
  const root = await mkdtemp(path.join(tmpdir(), 'manor-compress-'))
  const daily = path.join(root, 'memory', 'daily')
  await mkdir(daily, { recursive: true })
  if (longTerm !== null) await writeFile(path.join(root, LONG_TERM_FILE), longTerm)
  for (const [name, content] of Object.entries(days)) await writeFile(path.join(daily, name), content)
  return { root, daily, longTerm: path.join(root, LONG_TERM_FILE) }
}

const compressor = (root: string, script: (input: TurnInput, attempt: number) => RuntimeEvent[], seen: TurnInput[] = []) => {
  const attempts = [{ driver: scripted(script, seen), runtime: 'claude' as const, model: 'claude-haiku-5-5' }]
  return createMemoryCompressor({
    root,
    attempts: () => attempts,
    ensureScratchDir: scratchFor,
    now,
  })
}

describe('applyLongTermOps', () => {
  const held = `${LONG_TERM_STARTER}\n- Prefers Dutch in chat (2026-11-01)\n- Writer runs on Haiku (2026-11-02)\n`

  it('adds, replaces and removes lines, and does nothing the second time', () => {
    const ops = [
      { op: 'replace', old: '- Writer runs on Haiku (2026-11-02)', line: '- Writer runs on Sonnet (2026-11-09)' },
      { op: 'remove', old: '- Prefers Dutch in chat (2026-11-01)' },
      { op: 'add', line: '- Ships on Fridays (2026-11-09)' },
    ] as const
    const once = applyLongTermOps(held, ops)
    expect(once.content).toBe(`${LONG_TERM_STARTER}\n- Writer runs on Sonnet (2026-11-09)\n- Ships on Fridays (2026-11-09)\n`)
    expect(once.changed).toBe(3)
    expect(applyLongTermOps(once.content, ops)).toEqual({ content: once.content, changed: 0 })
  })

  it('puts the first fact under the starter text', () => {
    expect(applyLongTermOps(LONG_TERM_STARTER, [{ op: 'add', line: '- First (2026-11-09)' }]).content)
      .toBe(`${LONG_TERM_STARTER}\n- First (2026-11-09)\n`)
  })

  it('refuses an addition past the line limit, and still replaces', () => {
    const full = `# Long-term memory\n\n${Array.from({ length: LONG_TERM_MAX_LINES }, (_, at) => `- Fact ${at}`).join('\n')}\n`
    const applied = applyLongTermOps(full, [
      { op: 'add', line: '- One too many' },
      { op: 'replace', old: '- Fact 0', line: '- Fact zero' },
    ])
    expect(applied.changed).toBe(1)
    expect(applied.content).not.toContain('One too many')
    expect(applied.content).toContain('- Fact zero')
  })
})

describe('parseLongTermOps', () => {
  it('keeps well-formed operations and drops the rest', () => {
    const ops = parseLongTermOps(`\`\`\`json\n${JSON.stringify({ ops: [
      { op: 'add', line: '- Kept (2026-11-09)' },
      { op: 'add', line: 'no bullet' },
      { op: 'add', line: `- ${'x'.repeat(400)}` },
      { op: 'remove', old: '- Gone' },
      { op: 'rewrite', line: '- Unknown op' },
    ] })}\n\`\`\``)
    expect(ops).toEqual([{ op: 'add', line: '- Kept (2026-11-09)' }, { op: 'remove', old: '- Gone' }])
  })

  it('refuses an answer that is not the agreed JSON', () => {
    expect(() => parseLongTermOps('Sure, here you go')).toThrow()
  })
})

describe('createMemoryCompressor', () => {
  it('distills finished days oldest first, archives them and leaves today alone', async () => {
    const { root, daily, longTerm } = await folder({
      '2026-11-08.md': '# Daily log — 2026-11-08\n\n- [m/ada] Chose SQLite over Postgres.\n',
      '2026-11-09.md': '# Daily log — 2026-11-09\n\n- [m/ada] Ships on Fridays.\n',
      '2026-11-10.md': '# Daily log — 2026-11-10\n\n- [m/ada] Today.\n',
    })
    const seen: TurnInput[] = []
    const compress = compressor(root, (_turn, attempt) => result({ ops: [{ op: 'add', line: `- Fact ${attempt}` }] }), seen)

    expect(await compress()).toEqual({ archived: ['2026-11-08.md', '2026-11-09.md'], changed: 2 })
    expect(await readFile(longTerm, 'utf8')).toBe(`${LONG_TERM_STARTER}\n- Fact 1\n- Fact 2\n`)
    expect((await readdir(daily)).sort()).toEqual(['2026-11-10.md', 'archive'])
    expect((await readdir(path.join(daily, 'archive'))).sort()).toEqual(['2026-11-08.md', '2026-11-09.md'])
    // The second day's run sees what the first one kept.
    const second = seen[1]?.catchUp[0]
    expect(second?.type === 'user_message' ? second.text : '').toContain('- Fact 1')
    expect(seen[0]?.agent.allowedTools).toEqual([])
  })

  it('does nothing in a folder without the long-term file', async () => {
    const { root, daily } = await folder({ '2026-11-08.md': '- [m/ada] A line.\n' }, null)
    const seen: TurnInput[] = []
    expect(await compressor(root, () => result({ ops: [] }), seen)()).toEqual({ archived: [], changed: 0 })
    expect(seen).toHaveLength(0)
    expect(await readdir(daily)).toEqual(['2026-11-08.md'])
  })

  it('archives a day with no lines without asking a model', async () => {
    const { root, daily } = await folder({ '2026-11-08.md': '# Daily log — 2026-11-08\n' })
    const seen: TurnInput[] = []
    expect((await compressor(root, () => result({ ops: [] }), seen)()).archived).toEqual(['2026-11-08.md'])
    expect(seen).toHaveLength(0)
    expect(await readdir(daily)).toEqual(['archive'])
  })

  it('leaves a day in place when nobody could answer, and picks it up next time', async () => {
    const { root, daily, longTerm } = await folder({
      '2026-11-08.md': '- [m/ada] A line.\n',
      '2026-11-09.md': '- [m/ada] Another.\n',
    })
    let fail = true
    const compress = compressor(root, () => fail
      ? [{ type: 'error', message: 'not signed in' }]
      : result({ ops: [{ op: 'add', line: '- Kept' }] }))

    expect(await compress()).toEqual({ archived: [], changed: 0 })
    expect((await readdir(daily)).sort()).toEqual(['2026-11-08.md', '2026-11-09.md'])
    expect(await readFile(longTerm, 'utf8')).toBe(LONG_TERM_STARTER)

    fail = false
    expect((await compress()).archived).toEqual(['2026-11-08.md', '2026-11-09.md'])
  })

  it('does not overwrite an earlier archive of the same day', async () => {
    const { root, daily } = await folder({ '2026-11-08.md': '- [m/ada] Late line.\n' })
    await mkdir(path.join(daily, 'archive'))
    await writeFile(path.join(daily, 'archive', '2026-11-08.md'), '- [m/ada] Early line.\n')
    await compressor(root, () => result({ ops: [] }))()
    expect((await readdir(path.join(daily, 'archive'))).sort()).toEqual(['2026-11-08-2.md', '2026-11-08.md'])
    expect(await readFile(path.join(daily, 'archive', '2026-11-08.md'), 'utf8')).toBe('- [m/ada] Early line.\n')
  })
})
