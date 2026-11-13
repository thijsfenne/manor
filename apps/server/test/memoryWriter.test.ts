import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { RuntimeEvent, TurnInput } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import {
  applyDailyOps,
  createMemoryWriter,
  memoryChangesFromEdits,
  mergeMemoryChanges,
  parseDailyOps,
  type MemoryWriterInput,
} from '../src/memoryWriter.js'
import { scratchFor, scripted } from './helpers.js'

const result = (value: unknown): RuntimeEvent[] => [{ type: 'result', text: JSON.stringify(value) }]
const date = '2026-09-28'
const now = () => new Date(2026, 8, 28, 21, 0)
const input: MemoryWriterInput = {
  key: 'turn_1',
  chatId: 'chat_1',
  userText: 'Use Sonnet for the writer.',
  turns: [{ prefix: 'm/smith', name: 'Smith', answer: 'Done.', tools: [] }],
}

const writer = (dailyDir: string, ops: unknown, seen: TurnInput[] = []) => createMemoryWriter({
  attempts: [{ driver: scripted(() => result({ ops }), seen), runtime: 'claude', model: 'claude-sonnet-5-5' }],
  dailyDir,
  ensureScratchDir: scratchFor,
  now,
})

describe('applyDailyOps', () => {
  const existing = `# Daily log — ${date}\n\n- [m/smith] Writer runs on Haiku.\n`

  it('supersedes a line in place and appends a new one', () => {
    const applied = applyDailyOps(existing, date, [
      { op: 'replace', old: '- [m/smith] Writer runs on Haiku.', line: '- [m/smith] Writer runs on Sonnet 5.5 medium.' },
      { op: 'add', line: '- [m/smith] Banner skips memory-only turns.' },
    ])
    expect(applied.content).toBe(
      `# Daily log — ${date}\n\n- [m/smith] Writer runs on Sonnet 5.5 medium.\n- [m/smith] Banner skips memory-only turns.\n`,
    )
    expect(applied.lines).toEqual([
      { kind: 'replaced', before: '- [m/smith] Writer runs on Haiku.', after: '- [m/smith] Writer runs on Sonnet 5.5 medium.' },
      { kind: 'added', text: '- [m/smith] Banner skips memory-only turns.' },
    ])
  })

  it('changes nothing the second time the same ops are applied', () => {
    const ops = [
      { op: 'replace', old: '- [m/smith] Writer runs on Haiku.', line: '- [m/smith] Writer runs on Sonnet.' },
      { op: 'add', line: '- [m/smith] One more.' },
    ] as const
    const once = applyDailyOps(existing, date, ops)
    const twice = applyDailyOps(once.content, date, ops)
    expect(twice).toEqual({ content: once.content, lines: [] })
  })

  it('creates the file with its header', () => {
    expect(applyDailyOps(undefined, date, [{ op: 'add', line: '- [m/sage] First.' }]).content)
      .toBe(`# Daily log — ${date}\n\n- [m/sage] First.\n`)
  })
})

describe('parseDailyOps', () => {
  it('keeps only lines with a supplied prefix, one line, within the cap', () => {
    const raw = JSON.stringify({ ops: [
      { op: 'add', line: '- [m/smith] Kept.' },
      { op: 'add', line: '- [m/argus] Not a turn in this chain.' },
      { op: 'add', line: '- [m/smith] two\nlines' },
      { op: 'add', line: `- [m/smith] ${'x'.repeat(251)}` },
      { op: 'replace', old: '# Daily log — 2026-09-28', line: '- [m/smith] Header is not a line.' },
    ] })
    expect(parseDailyOps(raw, new Set(['m/smith']))).toEqual([{ op: 'add', line: '- [m/smith] Kept.' }])
  })

  it('refuses output that is not the ops object', () => {
    expect(() => parseDailyOps('Logged it.', new Set(['m/smith']))).toThrow()
  })
})

describe('createMemoryWriter', () => {
  it('writes today\'s daily from the clock and reports the change', async () => {
    const dailyDir = await mkdtemp(path.join(tmpdir(), 'manor-writer-'))
    const seen: TurnInput[] = []
    const change = await writer(dailyDir, [{ op: 'add', line: '- [m/smith] Writer is live.' }], seen)(input)
    const file = path.join(dailyDir, `${date}.md`)
    expect(await readFile(file, 'utf8')).toBe(`# Daily log — ${date}\n\n- [m/smith] Writer is live.\n`)
    expect(change).toEqual({ path: file, lines: [{ kind: 'added', text: '- [m/smith] Writer is live.' }] })
    expect(seen[0]?.agent).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium', allowedTools: [] })
    expect(seen[0]?.infrastructure).toBe(true)
    expect(seen[0]?.promptCaching).toBe('off')
  })

  it('logs nothing when the model decides nothing', async () => {
    const dailyDir = await mkdtemp(path.join(tmpdir(), 'manor-writer-none-'))
    expect(await writer(dailyDir, [])(input)).toBeUndefined()
    await expect(readFile(path.join(dailyDir, `${date}.md`), 'utf8')).rejects.toThrow()
  })

  // Two chats finishing together: each re-reads inside the per-file lock, so neither
  // line overwrites the other, and a repeated decision lands once.
  it('keeps both lines from concurrent chats and never doubles a repeated one', async () => {
    const dailyDir = await mkdtemp(path.join(tmpdir(), 'manor-writer-race-'))
    await writeFile(path.join(dailyDir, `${date}.md`), `# Daily log — ${date}\n\n- [c/claude] Outside line.\n`)
    const shared = { op: 'add', line: '- [m/smith] Same decision.' }
    const write = createMemoryWriter({
      attempts: [{
        driver: scripted((turn) => result({ ops: [shared, { op: 'add', line: `- [m/smith] From ${turn.threadId}.` }] }), []),
        runtime: 'claude',
        model: 'claude-sonnet-5-5',
      }],
      dailyDir,
      ensureScratchDir: scratchFor,
      now,
    })
    await Promise.all([write({ ...input, key: 'one', chatId: 'one' }), write({ ...input, key: 'two', chatId: 'two' })])
    const lines = (await readFile(path.join(dailyDir, `${date}.md`), 'utf8')).split('\n')
    expect(lines.filter((line) => line === '- [m/smith] Same decision.')).toHaveLength(1)
    expect(lines).toContain('- [m/smith] From memory_writer_one.')
    expect(lines).toContain('- [m/smith] From memory_writer_two.')
    expect(lines).toContain('- [c/claude] Outside line.')
  })
})

describe('createMemoryWriter under concurrency and repeats', () => {
  // Argus 2026-09-28: two chats replacing the same line against one stale snapshot
  // left both versions standing. The second run now decides on the first one's result.
  it('lets the second of two concurrent replacements decide on the first one\'s daily', async () => {
    const dailyDir = await mkdtemp(path.join(tmpdir(), 'manor-writer-replace-'))
    const file = path.join(dailyDir, `${date}.md`)
    await writeFile(file, `# Daily log — ${date}\n\n- [m/smith] Writer model open.\n`)
    const write = createMemoryWriter({
      attempts: [{
        driver: scripted((turn) => {
          const daily = String(turn.catchUp[0]?.type === 'user_message' ? turn.catchUp[0].text : '')
          const current = daily.includes('- [m/smith] Writer on Sonnet.') ? '- [m/smith] Writer on Sonnet.' : '- [m/smith] Writer model open.'
          return result({ ops: [{ op: 'replace', old: current, line: `- [m/smith] Writer on Sonnet${turn.threadId.endsWith('two') ? ' medium' : ''}.` }] })
        }, []),
        runtime: 'claude',
        model: 'claude-sonnet-5-5',
      }],
      dailyDir,
      ensureScratchDir: scratchFor,
      now,
    })
    await Promise.all([write({ ...input, key: 'one', chatId: 'one' }), write({ ...input, key: 'two', chatId: 'two' })])
    expect(await readFile(file, 'utf8')).toBe(`# Daily log — ${date}\n\n- [m/smith] Writer on Sonnet medium.\n`)
  })

  it('never processes the same chain twice, even when the model would word it differently', async () => {
    const dailyDir = await mkdtemp(path.join(tmpdir(), 'manor-writer-key-'))
    const write = createMemoryWriter({
      attempts: [{
        driver: scripted((_turn, attempt) => result({ ops: [{ op: 'add', line: `- [m/smith] Wording ${attempt}.` }] }), []),
        runtime: 'claude',
        model: 'claude-sonnet-5-5',
      }],
      dailyDir,
      ensureScratchDir: scratchFor,
      now,
    })
    await write(input)
    expect(await write(input)).toBeUndefined()
    expect(await readFile(path.join(dailyDir, `${date}.md`), 'utf8')).toBe(`# Daily log — ${date}\n\n- [m/smith] Wording 1.\n`)
  })

  // A chain counts as handled only once its decision landed, so a failed run can retry.
  it('lets a retry through after every attempt failed', async () => {
    const dailyDir = await mkdtemp(path.join(tmpdir(), 'manor-writer-retry-'))
    const write = createMemoryWriter({
      attempts: [{
        driver: scripted((_turn, attempt) => attempt === 1
          ? [{ type: 'error', message: 'overloaded' }]
          : result({ ops: [{ op: 'add', line: '- [m/smith] Landed on retry.' }] }), []),
        runtime: 'claude',
        model: 'claude-sonnet-5-5',
      }],
      dailyDir,
      ensureScratchDir: scratchFor,
      now,
    })
    expect(await write(input)).toBeUndefined()
    expect(await write(input)).toMatchObject({ lines: [{ kind: 'added', text: '- [m/smith] Landed on retry.' }] })
  })
})

describe('memoryChangesFromEdits', () => {
  it('keeps edits inside the memory folder root as line changes and ignores everything else', () => {
    const root = '/Users/sam/notes'
    expect(memoryChangesFromEdits([
      { path: `${root}/memory/open-loops.md`, before: '- [ ] Ship it', after: '- [x] Ship it\n- [ ] Review' },
      { path: '/Users/sam/notes2/memory/x.md', after: 'no' },
      { path: '/repo/src/main.ts', before: 'a', after: 'b' },
      { path: `${root}/memory/daily/d.md`, before: '- same', after: '- same' },
    ], root)).toEqual([{
      path: `${root}/memory/open-loops.md`,
      lines: [
        { kind: 'replaced', before: '- [ ] Ship it', after: '- [x] Ship it' },
        { kind: 'added', text: '- [ ] Review' },
      ],
    }])
  })

  // Two identical lines collapsing to one is a real removal, not an empty diff.
  it('counts duplicate lines', () => {
    expect(memoryChangesFromEdits([
      { path: '/notes/memory/daily/d.md', before: '- [m/sage] Twice.\n- [m/sage] Twice.', after: '- [m/sage] Twice.' },
    ], '/notes')).toEqual([{ path: '/notes/memory/daily/d.md', lines: [{ kind: 'removed', text: '- [m/sage] Twice.' }] }])
  })

  it('marks a change cut to the wire cap', () => {
    const after = Array.from({ length: 61 }, (_, index) => `- [m/sage] Line ${index}.`).join('\n')
    const [change] = memoryChangesFromEdits([{ path: '/notes/memory/daily/d.md', after }], '/notes')
    expect(change?.lines).toHaveLength(60)
    expect(change?.truncated).toBe(true)
  })

  // Files past the cap are not named as memory, so the banner keeps them.
  it('leaves room for the writer\'s daily within the file cap', () => {
    const edits = Array.from({ length: 21 }, (_, index) => ({ path: `/notes/memory/n${index}.md`, after: '- note' }))
    const changes = memoryChangesFromEdits(edits, '/notes')
    expect(changes).toHaveLength(19)
    expect(mergeMemoryChanges(changes, { path: '/notes/memory/daily/d.md', lines: [{ kind: 'added', text: '- x' }] }))
      .toHaveLength(20)
  })
})
