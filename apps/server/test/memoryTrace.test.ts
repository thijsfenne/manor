import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MemoryTraceSchema, type RuntimeEvent, type TurnInput } from '@manor/contracts'
import { describe, expect, it, vi } from 'vitest'
import {
  collectMemoryReads,
  createMemoryTraceGenerator,
  readMemoryTraceSources,
} from '../src/memoryTrace.js'
import { describeCommand } from '../src/drivers/commands.js'
import { scratchFor, scripted } from './helpers.js'

const makeMemory = async (): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'manor-trace-'))
  await mkdir(path.join(root, 'structured'), { recursive: true })
  await writeFile(path.join(root, 'structured', 'project.md'), 'The project ships the heart first.', 'utf8')
  return root
}

describe('collectMemoryReads', () => {
  it('keeps explicit read and search targets inside a root without accepting a prefix sibling', () => {
    const root = '/Users/sam/notes/memory'
    expect(collectMemoryReads([
      { source: 'on_demand', tool: 'Read', targets: [`${root}/projects/manor.md`] },
      { source: 'on_demand', tool: 'Search', targets: ['structured'] },
      { source: 'on_demand', tool: 'Read', targets: [`${root}/projects/partial.md`], fromLine: 4 },
      { source: 'on_demand', tool: 'Edit', targets: [`${root}/daily/2026-08-27.md`] },
      { source: 'on_demand', tool: 'Read', targets: ['/Users/sam/notes/memory2/no.md'] },
    ], { roots: [root], cwd: root })).toEqual([
      { source: 'on_demand', path: `${root}/projects/manor.md` },
      { source: 'on_demand', path: `${root}/structured` },
      { source: 'on_demand', path: `${root}/projects/partial.md` },
    ])
  })

  it('expands home paths and resolves relative targets against the turn cwd', () => {
    const home = '/Users/sam'
    const root = `${home}/notes/memory`
    expect(collectMemoryReads([
      { source: 'on_demand', tool: 'read_file', targets: ['~/notes/memory/user.md'] },
      { source: 'on_demand', tool: 'grep', targets: ['projects/manor.md'], fromLine: 4, toLine: 8 },
    ], { roots: [root], cwd: root, home })).toEqual([
      { source: 'on_demand', path: `${root}/user.md` },
      { source: 'on_demand', path: `${root}/projects/manor.md`, fromLine: 4, toLine: 8 },
    ])
  })

  it('resolves the Codex shell form to the same memory file as a native Claude read', () => {
    const home = '/Users/sam'
    const root = `${home}/notes`
    const sourcePath = `${root}/memory/projects/atlas.md`
    const codex = describeCommand("sed -n '1,240p' memory/projects/atlas.md")
    const options = { roots: [root], cwd: '/tmp/manor/chat/sage', home }

    const codexReads = collectMemoryReads([{
      source: 'on_demand',
      tool: codex.tool,
      targets: codex.targets ?? [],
    }], options)
    const claudeReads = collectMemoryReads([{
      source: 'on_demand',
      tool: 'Read',
      targets: [sourcePath],
    }], options)

    expect(codex).toMatchObject({ tool: 'Read', targets: ['memory/projects/atlas.md'] })
    expect(codexReads).toEqual([{ source: 'on_demand', path: sourcePath }])
    expect(codexReads).toEqual(claudeReads)
  })

  it('keeps root rules and private memory inside the configured memory folder', () => {
    const home = '/Users/sam'
    const root = `${home}/notes`
    expect(collectMemoryReads([{
      source: 'on_demand',
      tool: 'Read',
      targets: ['rules.md', 'private/life.md'],
    }], { roots: [root], cwd: '/tmp/manor/chat/sage', home })).toEqual([
      { source: 'on_demand', path: `${root}/rules.md` },
      { source: 'on_demand', path: `${root}/private/life.md` },
    ])
  })

  it('dedupes by source and normalised path while retaining a distinct injected read', () => {
    const root = '/memory'
    expect(collectMemoryReads([
      { source: 'on_demand', tool: 'Read', targets: ['/memory/a.md', './a.md'] },
      { source: 'on_demand', tool: 'Search', targets: ['/memory/a.md'] },
      { source: 'injected', targets: ['/memory/a.md'] },
    ], { roots: [root], cwd: root })).toEqual([
      { source: 'on_demand', path: '/memory/a.md' },
      { source: 'injected', path: '/memory/a.md' },
    ])
  })
})

describe('MemoryTraceSchema', () => {
  it('rejects partial ranges, false not_read states, and unobserved citations', () => {
    expect(MemoryTraceSchema.safeParse({
      reads: [{ source: 'on_demand', path: '/memory/a.md', fromLine: 2 }],
      summary: { status: 'none', derivation: 'model' },
    }).success).toBe(false)
    expect(MemoryTraceSchema.safeParse({
      reads: [{ source: 'on_demand', path: '/memory/a.md' }],
      summary: { status: 'not_read', derivation: 'none' },
    }).success).toBe(false)
    expect(MemoryTraceSchema.safeParse({
      reads: [{ source: 'on_demand', path: '/memory/a.md' }],
      summary: {
        status: 'used',
        derivation: 'model',
        items: [{ text: 'Claim.', sourcePath: '/memory/b.md' }],
      },
    }).success).toBe(false)
  })
})

describe('readMemoryTraceSources', () => {
  it('bounds file content and skips directories and unreadable paths', async () => {
    const root = await makeMemory()
    const file = path.join(root, 'structured', 'project.md')
    const sources = await readMemoryTraceSources([
      { source: 'on_demand', path: file },
      { source: 'on_demand', path: path.join(root, 'structured') },
      { source: 'on_demand', path: path.join(root, 'missing.md') },
    ], { maxFileBytes: 12, maxTotalBytes: 12 })

    expect(sources).toEqual([{
      read: { source: 'on_demand', path: file },
      content: 'The project ',
      truncated: true,
    }])
  })

  it('keeps an answer-relevant passage that sits beyond the per-file prompt budget', async () => {
    const root = await makeMemory()
    const file = path.join(root, 'structured', 'late.md')
    await writeFile(
      file,
      `${'Unrelated opening. '.repeat(200)}\n\nThe shared calendar is named Us is a movie.`,
      'utf8',
    )

    const sources = await readMemoryTraceSources([
      { source: 'on_demand', path: file },
    ], {
      maxFileBytes: 1_000,
      maxTotalBytes: 1_000,
      maxScanBytes: 20_000,
      query: 'Keep Saturday free in the shared calendar Us is a movie.',
    })

    expect(sources[0]?.content).toContain('Us is a movie')
    expect(Buffer.byteLength(sources[0]?.content ?? '')).toBeLessThanOrEqual(1_000)
    expect(sources[0]?.truncated).toBe(true)
  })
})

const result = (value: unknown): RuntimeEvent[] => [{
  type: 'result',
  text: typeof value === 'string' ? value : JSON.stringify(value),
}]

describe('createMemoryTraceGenerator', () => {
  it('counts routing indexes but never offers them to the citation model', async () => {
    const root = await makeMemory()
    const sourcePath = path.join(root, 'structured', 'project.md')
    const seen: TurnInput[] = []
    const generate = createMemoryTraceGenerator({
      attempts: [{
        driver: scripted(() => result({ status: 'used', items: [{ text: 'Should not run.', sourcePath }] }), seen),
        runtime: 'claude',
        model: 'haiku',
      }],
      ensureScratchDir: scratchFor,
    })

    await expect(generate({
      chatId: 'chat_indexes_only',
      answer: 'An answer.',
      reads: [{ source: 'injected', path: sourcePath }],
      nonCitablePaths: [sourcePath],
    })).resolves.toEqual({ status: 'unavailable', derivation: 'model' })
    expect(seen).toHaveLength(0)
  })

  it('returns an explicit none from a tool-less low-effort infrastructure turn', async () => {
    const root = await makeMemory()
    const seen: TurnInput[] = []
    const generate = createMemoryTraceGenerator({
      attempts: [{
        driver: scripted(() => result({ status: 'none' }), seen),
        runtime: 'claude',
        model: 'haiku',
      }],
      ensureScratchDir: scratchFor,
    })

    await expect(generate({
      chatId: 'chat_1',
      answer: 'The heart should ship first.',
      reads: [{ source: 'on_demand', path: path.join(root, 'structured', 'project.md') }],
    })).resolves.toEqual({ status: 'none', derivation: 'model' })
    expect(seen[0]).toMatchObject({
      threadId: 'memory_trace_chat_1',
      repoPaths: [],
      isFullCatchUp: true,
      infrastructure: true,
      agent: {
        driver: 'claude',
        model: 'haiku',
        effort: 'low',
        allowedTools: [],
        mcpServers: [],
        memoryScope: false,
      },
    })
  })

  it('rejects an unknown sourcePath and falls back to the next runtime', async () => {
    const root = await makeMemory()
    const sourcePath = path.join(root, 'structured', 'project.md')
    const seen: TurnInput[] = []
    const errors: unknown[] = []
    const invalid = scripted(() => result({
      status: 'used',
      items: [{ text: 'Used another note.', sourcePath: `${root}/other.md` }],
    }), seen)
    const fallback = scripted(() => result({
      status: 'used',
      items: [{ text: 'Kept the heart-first constraint.', sourcePath }],
    }), seen)
    const generate = createMemoryTraceGenerator({
      attempts: [
        { driver: invalid, runtime: 'claude', model: 'haiku' },
        { driver: fallback, runtime: 'codex', model: 'gpt-5.6-luna' },
      ],
      ensureScratchDir: scratchFor,
      onError: (error) => errors.push(error),
    })

    await expect(generate({
      chatId: 'chat_2',
      answer: 'Build the heart.',
      reads: [{ source: 'injected', path: sourcePath }],
    })).resolves.toEqual({
      status: 'used',
      derivation: 'model',
      items: [{ text: 'Kept the heart-first constraint.', sourcePath }],
    })
    expect(seen.map((input) => input.agent.driver)).toEqual(['claude', 'codex'])
    expect(errors).toHaveLength(1)
  })

  it('rejects a claim above the 140-character contract and uses the fallback', async () => {
    const root = await makeMemory()
    const sourcePath = path.join(root, 'structured', 'project.md')
    const seen: TurnInput[] = []
    const generate = createMemoryTraceGenerator({
      attempts: [
        {
          driver: scripted(() => result({
            status: 'used',
            items: [{ text: 'x'.repeat(141), sourcePath }],
          }), seen),
          runtime: 'codex',
          model: 'gpt-5.6-luna',
        },
        {
          driver: scripted(() => result({ status: 'none' }), seen),
          runtime: 'claude',
          model: 'haiku',
        },
      ],
      ensureScratchDir: scratchFor,
    })

    await expect(generate({
      chatId: 'chat_long_claim',
      answer: 'Build the heart.',
      reads: [{ source: 'on_demand', path: sourcePath }],
    })).resolves.toEqual({ status: 'none', derivation: 'model' })
    expect(seen).toHaveLength(2)
  })

  it('returns unavailable when every attempt fails', async () => {
    const root = await makeMemory()
    const sourcePath = path.join(root, 'structured', 'project.md')
    const generate = createMemoryTraceGenerator({
      attempts: [{
        driver: scripted(() => [{ type: 'error', message: 'provider unavailable' }], []),
        runtime: 'claude',
        model: 'haiku',
      }],
      ensureScratchDir: scratchFor,
    })

    await expect(generate({
      chatId: 'chat_3',
      answer: 'Answer.',
      reads: [{ source: 'on_demand', path: sourcePath }],
    })).resolves.toEqual({ status: 'unavailable', derivation: 'model' })
  })

  it('returns unavailable without starting a runtime when no source can be read', async () => {
    const driver = { startTurn: vi.fn() }
    const generate = createMemoryTraceGenerator({
      attempts: [{ driver: driver as never, runtime: 'claude', model: 'haiku' }],
      ensureScratchDir: scratchFor,
    })

    await expect(generate({
      chatId: 'chat_4',
      answer: 'Answer.',
      reads: [{ source: 'on_demand', path: '/definitely/missing.md' }],
    })).resolves.toEqual({ status: 'unavailable', derivation: 'model' })
    expect(driver.startTurn).not.toHaveBeenCalled()
  })
})
