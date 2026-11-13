import { mkdir, mkdtemp, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MAX_STRUCTURED_MEMORY_CHARS,
  composeStructuredMemoryBundle,
  structuredProjectSlug,
} from '../src/structuredMemory.js'

const makeRoot = async (): Promise<string> => realpath(await mkdtemp(path.join(tmpdir(), 'manor-structured-memory-')))

describe('composeStructuredMemoryBundle', () => {
  it('keeps personal rows out of project rooms with a visible route back', async () => {
    const root = await makeRoot()
    await mkdir(path.join(root, 'example-app'), { recursive: true })
    await writeFile(path.join(root, 'MEMORY.md'), `ROOT ROUTE\n${'r'.repeat(30_000)}`, 'utf8')
    await writeFile(path.join(root, 'example-app/MEMORY.md'), `PROJECT ROUTE\n${'p'.repeat(16_000)}`, 'utf8')

    const bundle = await composeStructuredMemoryBundle(root, 'Example App')

    expect(bundle.text.length).toBeLessThanOrEqual(MAX_STRUCTURED_MEMORY_CHARS)
    expect(bundle.text).toContain('PROJECT ROUTE')
    expect(`${bundle.text}${bundle.retrieved ?? ''}`).not.toContain('ROOT ROUTE')
    expect(bundle.text).toContain(`read ${path.join(root, 'MEMORY.md')}`)
    expect(bundle.sources.map((source) => source.path)).toEqual([
      path.join(root, 'example-app/MEMORY.md'),
    ])
    expect(bundle.sources[0]?.content).toBe(`PROJECT ROUTE\n${'p'.repeat(16_000)}`)
  })

  it('keeps a root pointer without injecting personal rows when the project has no index', async () => {
    const root = await makeRoot()
    await writeFile(path.join(root, 'MEMORY.md'), 'ROOT ROUTE', 'utf8')

    const bundle = await composeStructuredMemoryBundle(root, 'Manor')

    expect(bundle.sources).toEqual([])
    expect(bundle.text).toContain(path.join(root, 'MEMORY.md'))
    expect(`${bundle.text}${bundle.retrieved ?? ''}`).not.toContain('ROOT ROUTE')
  })

  it('retains root routing for DMs and explicit knowledge rooms, not a name or folder guess', async () => {
    const root = await makeRoot()
    await writeFile(path.join(root, 'MEMORY.md'), 'Personal routing')
    expect((await composeStructuredMemoryBundle(root)).text).toContain('Personal routing')
    expect((await composeStructuredMemoryBundle(root, 'Renamed room', undefined, undefined, { scope: 'knowledge' })).text).toContain('Personal routing')
    expect((await composeStructuredMemoryBundle(root, 'Notes')).text).not.toContain('Personal routing')
    await writeFile(path.join(root, 'MEMORY.md'), 'Updated routing')
    expect((await composeStructuredMemoryBundle(root)).text).toContain('Updated routing')
  })

  it.each(['Manor', 'Notes'])('keeps %s project evidence with personal memory off, without root routing', async (name) => {
    const root = await makeRoot()
    const slug = structuredProjectSlug(name)
    await mkdir(path.join(root, slug))
    await writeFile(path.join(root, 'MEMORY.md'), 'PERSONAL ROOT')
    await writeFile(path.join(root, slug, 'MEMORY.md'), '- [Cloud hosting](cloud.md)')
    await writeFile(path.join(root, slug, 'cloud.md'), 'PROJECT EVIDENCE')
    const bundle = await composeStructuredMemoryBundle(root, name, 'cloud hosting', undefined, { personalMemory: false })
    expect(bundle.retrieved).toContain('PROJECT EVIDENCE')
    expect(bundle.text).not.toContain('PROJECT EVIDENCE')
    expect(`${bundle.text}${bundle.retrieved ?? ''}`).not.toContain(path.join(root, 'MEMORY.md'))
    expect(`${bundle.text}${bundle.retrieved ?? ''}`).not.toContain('PERSONAL ROOT')
    expect(bundle.sources.map((source) => source.kind)).toEqual(['index', 'file'])
    expect(bundle.text.length).toBeLessThanOrEqual(MAX_STRUCTURED_MEMORY_CHARS)
    await expect(composeStructuredMemoryBundle(root, undefined, undefined, undefined, { personalMemory: false }))
      .resolves.toEqual({ text: '', sources: [] })
  })

  it('returns no routing block when this host has no memory folder checkout', async () => {
    await expect(composeStructuredMemoryBundle(undefined, 'Manor')).resolves.toEqual({ text: '', sources: [] })
  })

  it('reserves a visible root route even when the project index consumes the budget', async () => {
    const root = await makeRoot()
    await mkdir(path.join(root, 'manor'), { recursive: true })
    await writeFile(path.join(root, 'MEMORY.md'), 'ROOT INDEX', 'utf8')
    await writeFile(path.join(root, 'manor/MEMORY.md'), 'p'.repeat(MAX_STRUCTURED_MEMORY_CHARS), 'utf8')

    const bundle = await composeStructuredMemoryBundle(root, 'Manor')

    expect(bundle.text.length).toBeLessThanOrEqual(MAX_STRUCTURED_MEMORY_CHARS)
    expect(bundle.text).toContain(`index truncated, read the file: ${path.join(root, 'manor/MEMORY.md')}`)
    expect(bundle.text).toContain(path.join(root, 'MEMORY.md'))
  })
})

describe('memory candidate scope', () => {
  const fixture = async () => {
    const root = await makeRoot()
    for (const directory of ['manor', 'example-app', 'craft', '_archive', 'craft/_archive']) {
      await mkdir(path.join(root, directory), { recursive: true })
      await writeFile(path.join(root, directory, 'MEMORY.md'), '- [Cloud](fact.md)')
      await writeFile(path.join(root, directory, 'fact.md'), `${directory} fact`)
    }
    await writeFile(path.join(root, 'MEMORY.md'), '- [Personal](user_private.md)\n- [Feedback](feedback_scope.md)')
    await writeFile(path.join(root, 'user_private.md'), 'Personal fact')
    await writeFile(path.join(root, 'feedback_scope.md'), 'Feedback fact')
    return root
  }

  it('ranks all active indexes in knowledge rooms but injects only selected evidence', async () => {
    const root = await fixture()
    // Every index is a candidate, ranked in its own call so no pool grows past one index.
    const calls: (readonly string[])[] = []
    const bundle = await composeStructuredMemoryBundle(root, 'Renamed room', 'cloud', async (_, rows) => {
      calls.push(rows)
      return rows.map((row) => row.includes('user_private') ? 1 : 0)
    }, { scope: 'knowledge' })
    expect(calls.flat()).toHaveLength(5)
    expect(calls.map((rows) => rows.length).sort()).toEqual([1, 1, 1, 2])
    expect(bundle.sources.filter((source) => source.kind === 'file').map((source) => source.content)).toEqual(['Personal fact'])
    expect(bundle.sources.filter((source) => source.kind === 'index')).toHaveLength(1)
    expect(`${bundle.text}${bundle.retrieved ?? ''}`).not.toContain('craft fact')
    expect(`${bundle.text}${bundle.retrieved ?? ''}`).not.toContain('_archive')
  })

  it('keeps one failing index from silencing or polluting the others', async () => {
    const root = await fixture()
    // The knowledge room ranks roughly thirty indexes at once, so one slow or refused
    // call is ordinary. It may cost its own index and nothing else.
    const bundle = await composeStructuredMemoryBundle(root, 'Renamed room', 'cloud', async (_, rows) => {
      if (rows.some((row) => row.includes('user_private'))) throw new Error('offline')
      return rows.map(() => 1)
    }, { scope: 'knowledge' })
    const files = bundle.sources.filter((source) => source.kind === 'file').map((source) => source.content)
    expect([...files].sort()).toEqual(['craft fact', 'example-app fact', 'manor fact'])
    // The refused index contributes nothing, rather than every row word overlap likes.
    expect(`${bundle.text}${bundle.retrieved ?? ''}`).not.toContain('Personal fact')
    expect(`${bundle.text}${bundle.retrieved ?? ''}`).not.toContain('Feedback fact')
  })

  it('admits own project, root feedback and literally named projects only', async () => {
    const root = await fixture()
    for (const [question, count] of [['Example App cloud', 3], ['example-app cloud', 3], ['Example Appistic cloud', 2], ['photography cloud', 2]]) {
      let ranked: string[] = []
      await composeStructuredMemoryBundle(root, 'Manor', `Example App\n${question}`, async (_, rows) => {
        ranked = ranked.concat(rows)
        return rows.map(() => 0)
      }, { currentQuestion: String(question), projectNames: ['Example App', 'Manor'] })
      expect(ranked).toHaveLength(Number(count))
      expect(ranked.join('\n')).toContain('feedback_scope')
      expect(ranked.join('\n')).not.toContain('user_private')
    }
  })

  it('removes personal and broad discovery on memory off, and reverses on the next turn', async () => {
    const root = await fixture()
    for (const personalMemory of [true, false, true]) {
      let ranked: string[] = []
      const bundle = await composeStructuredMemoryBundle(root, 'Manor', 'cloud', async (_, rows) => {
        ranked = ranked.concat(rows)
        return rows.map(() => 1)
      }, { scope: 'knowledge', personalMemory })
      expect(ranked).toHaveLength(personalMemory ? 5 : 1)
      if (!personalMemory) {
        expect(bundle.sources.filter((source) => source.kind === 'file').map((source) => source.content)).toEqual(['manor fact'])
        expect(`${bundle.text}${bundle.retrieved ?? ''}`).not.toContain('Personal')
        expect(`${bundle.text}${bundle.retrieved ?? ''}`).not.toContain('Feedback')
      }
      expect(bundle.sources.filter((source) => source.kind === 'file').length).toBeLessThanOrEqual(4)
      expect(bundle.text.length).toBeLessThanOrEqual(MAX_STRUCTURED_MEMORY_CHARS)
    }
  })
})

describe('structuredProjectSlug', () => {
  it('matches memory folder project folder names', () => {
    expect(structuredProjectSlug('Example App')).toBe('example-app')
  })
})


describe('project file retrieval', () => {
  const fixture = async (rows: string[], files: Record<string, string>) => {
    const root = await makeRoot()
    await mkdir(path.join(root, 'manor'))
    await writeFile(path.join(root, 'MEMORY.md'), `ROOT\n${'root row\n'.repeat(4000)}`)
    await writeFile(path.join(root, 'manor/MEMORY.md'), rows.join('\n'))
    await Promise.all(Object.entries(files).map(([name, content]) => writeFile(path.join(root, 'manor', name), content)))
    return root
  }

  it('ranks matching rows and preserves whole evidence beside indexes that stay the same', async () => {
    const root = await fixture([
      '- [Cloud](cloud.md) — hosting',
      '- [Phone cloud](phone.md) — hosting',
      '- [Unrelated](other.md)',
    ], { 'cloud.md': 'Cloud fact', 'phone.md': 'Phone fact', 'other.md': 'Unrelated fact' })
    const bundle = await composeStructuredMemoryBundle(root, 'Manor', 'PHONE cloud cloud')
    expect(bundle.sources.filter((source) => source.kind === 'file').map((source) => path.basename(source.path)))
      .toEqual(['phone.md', 'cloud.md'])
    // The index composes the same whatever was retrieved, so the prompt carrying it holds.
    expect(bundle.text).toBe((await composeStructuredMemoryBundle(root, 'Manor')).text)
    expect(bundle.sources[0]?.content).toContain('- [Unrelated](other.md)')
    expect(bundle.retrieved).toContain('Phone fact')
    expect(bundle.retrieved).toContain('Memory files retrieved for this conversation')
    expect(bundle.text).not.toContain('Phone fact')
    expect(bundle.text.length).toBeLessThanOrEqual(MAX_STRUCTURED_MEMORY_CHARS)
    expect(bundle.retrieved!.length).toBeLessThanOrEqual(MAX_STRUCTURED_MEMORY_CHARS)
    expect(`${bundle.text}${bundle.retrieved ?? ''}`).not.toContain('root row')
  })

  it('skips a file that cannot fit whole and continues to a smaller candidate', async () => {
    const root = await fixture(['- [Cloud phone](large.md)', '- [Cloud](small.md)'], {
      'large.md': 'x'.repeat(MAX_STRUCTURED_MEMORY_CHARS), 'small.md': 'Small complete fact',
    })
    const bundle = await composeStructuredMemoryBundle(root, 'Manor', 'cloud phone')
    expect(bundle.sources.filter((source) => source.kind === 'file').map((source) => source.content)).toEqual(['Small complete fact'])
    expect(bundle.sources[0]?.content).toContain('(large.md)')
    expect(`${bundle.text}${bundle.retrieved ?? ''}`).not.toContain('xxxxx')
    expect(bundle.retrieved).not.toContain('xxxxx')
    expect(bundle.text.length).toBeLessThanOrEqual(MAX_STRUCTURED_MEMORY_CHARS)
  })

  it('caps successful reads at four with stable ties', async () => {
    const names = ['a', 'b', 'c', 'd', 'e']
    const root = await fixture(names.map((name) => `- [Cloud](${name}.md)`), Object.fromEntries(names.map((name) => [`${name}.md`, name])))
    const bundle = await composeStructuredMemoryBundle(root, 'Manor', 'cloud')
    expect(bundle.sources.filter((source) => source.kind === 'file').map((source) => source.content)).toEqual(['a', 'b', 'c', 'd'])
    expect(bundle.sources[0]?.content).toContain('- [Cloud](e.md)')
  })

  it('keeps index-only behavior without a request, a match, or a project', async () => {
    const root = await fixture(['- [Cloud](cloud.md)'], { 'cloud.md': 'Secret cloud fact' })
    for (const [project, request] of [['Manor', undefined], ['Manor', 'deze what unrelated'], [undefined, 'cloud'], ['Missing', 'cloud']] as const) {
      const bundle = await composeStructuredMemoryBundle(root, project, request)
      expect(bundle.sources.every((source) => source.kind === 'index')).toBe(true)
      expect(`${bundle.text}${bundle.retrieved ?? ''}`).not.toContain('Secret cloud fact')
    }
  })

  it('excludes every project-name term without suppressing topic matches', async () => {
    const root = await makeRoot()
    await mkdir(path.join(root, 'example-app'))
    await writeFile(path.join(root, 'example-app/MEMORY.md'), [
      '- [Example App cloud](cloud.md)', '- [Example App](other.md)',
    ].join('\n'))
    await writeFile(path.join(root, 'example-app/cloud.md'), 'Cloud fact')
    await writeFile(path.join(root, 'example-app/other.md'), 'Unrelated fact')
    const nameOnly = await composeStructuredMemoryBundle(root, 'Example App', 'EXAMPLE app')
    expect(nameOnly.sources.every((source) => source.kind === 'index')).toBe(true)
    const topical = await composeStructuredMemoryBundle(root, 'Example App', 'EXAMPLE app CLOUD')
    expect(topical.sources.filter((source) => source.kind === 'file').map((source) => source.content)).toEqual(['Cloud fact'])
    expect(topical.sources[0]?.content).toContain('(other.md)')
  })

  it('does not retrieve missing, empty, duplicate or escaped project links', async () => {
    const root = await fixture([
      '- [Cloud](../private.md)', '- [Cloud](escape.md)', '- [Cloud](missing.md)',
      '- [Cloud](empty.md)', '- [Cloud](MEMORY.md)', '- [Cloud](safe.md)', '- [Cloud](./safe.md)',
    ], { 'empty.md': '  ', 'safe.md': 'Project evidence' })
    await writeFile(path.join(root, 'private.md'), 'Personal data')
    await symlink(path.join(root, 'private.md'), path.join(root, 'manor/escape.md'))
    const bundle = await composeStructuredMemoryBundle(root, 'Manor', 'cloud')
    expect(bundle.sources.filter((source) => source.kind === 'file').map((source) => source.content)).toEqual(['Project evidence'])
    expect(`${bundle.text}${bundle.retrieved ?? ''}`).not.toContain('Personal data')
    const semantic = await composeStructuredMemoryBundle(root, 'Manor', 'hosting', async (_, rows) => rows.map(() => 1))
    expect(semantic.sources.filter((source) => source.kind === 'file').map((source) => source.content)).toEqual(['Project evidence'])
    expect(semantic.text).not.toContain('Personal data')
  })

  it('excludes archive history before ranking and injection, including symlink aliases', async () => {
    const root = await fixture([
      '- [Cloud history](archived.md)', '- [Cloud alias](alias.md)',
      '- [Cloud old](_archive/old.md)', '- [Cloud current](current.md)',
    ], { 'archived.md': 'HISTORY MUST NOT REACH CONTEXT', 'current.md': 'Current decision' })
    await mkdir(path.join(root, 'manor/_archive'))
    await writeFile(path.join(root, 'manor/_archive/old.md'), 'OLD ARCHIVE CONTENT')
    await symlink(path.join(root, 'manor/archived.md'), path.join(root, 'manor/alias.md'))
    const ranker = async (_: string, rows: readonly string[]) => {
      expect(rows).toEqual(['- [Cloud current](current.md)'])
      return rows.map(() => 1)
    }
    for (const options of [{ personalMemory: false }, { scope: 'knowledge' as const }]) {
      for (const selection of [undefined, ranker]) {
        const bundle = await composeStructuredMemoryBundle(root, 'Manor', 'cloud', selection, options)
        expect(bundle.sources.filter((source) => source.kind === 'file').map((source) => source.content))
          .toEqual(['Current decision'])
        expect(`${bundle.text}${bundle.retrieved ?? ''}`).not.toContain('HISTORY MUST NOT REACH CONTEXT')
        expect(`${bundle.text}${bundle.retrieved ?? ''}`).not.toContain('OLD ARCHIVE CONTENT')
      }
    }
  })

  it('uses experimental selection with the same cap and falls back on failure', async () => {
    const root = await fixture(['- [Cloud](cloud.md)', '- [Food](food.md)', '- [Large](large.md)'], {
      'cloud.md': 'Hosting evidence', 'food.md': 'Recipe evidence', 'large.md': 'x'.repeat(24_000),
    })
    const semantic = await composeStructuredMemoryBundle(root, 'Manor', 'eten', async () => [0, 0.9, 1])
    expect(semantic.sources.filter((source) => source.kind === 'file').map((source) => source.content)).toEqual(['Recipe evidence'])
    expect(semantic.text.length).toBeLessThanOrEqual(MAX_STRUCTURED_MEMORY_CHARS)
    // Without a ranker at all, word overlap still retrieves: that is what a room on a
    // machine with no ranker key gets.
    const lexical = await composeStructuredMemoryBundle(root, 'Manor', 'cloud')
    expect(lexical.sources.filter((source) => source.kind === 'file').map((source) => source.content)).toEqual(['Hosting evidence'])
    // With a ranker, a failed, malformed or mis-sized answer selects nothing from that
    // index instead of falling back to overlap, which would re-select the last subject.
    for (const ranker of [async () => { throw new Error('offline') }, async () => [NaN, 0, 0], async () => [1]]) {
      const bundle = await composeStructuredMemoryBundle(root, 'Manor', 'cloud', ranker)
      expect(bundle.sources.every((source) => source.kind === 'index')).toBe(true)
    }
    const never = async (): Promise<number[]> => { throw new Error('must not run') }
    expect(await composeStructuredMemoryBundle(undefined, 'Manor', 'cloud', never)).toEqual({ text: '', sources: [] })
    let calls = 0
    for (const request of ['Manor', 'ja', 'ja']) {
      const bundle = await composeStructuredMemoryBundle(root, 'Manor', request, async () => { calls++; return [0, 0, 0] })
      expect(bundle.sources.every((source) => source.kind === 'index')).toBe(true)
    }
    expect(calls).toBe(3)
  })
})
