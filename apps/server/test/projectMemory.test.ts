import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  MAX_PROJECT_MEMORY_CHARS,
  GLOBAL_MEMORY_HEADING,
  PROJECT_MEMORY_HEADING,
  composeProjectMemory,
  composeProjectMemoryBundle,
  importTargets,
  memoryFileHeading,
} from '../src/projectMemory.js'

/** Tests must never read the developer's real `~/.claude`, only what they created. */
const NO_GLOBAL = { globalRoot: null } as const

const makeFolder = async (files: Record<string, string>): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'manor-memory-'))
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name)
    await mkdir(path.dirname(full), { recursive: true })
    await writeFile(full, content, 'utf8')
  }
  return root
}

describe('importTargets', () => {
  it('takes line-initial and mid-line imports', () => {
    expect(importTargets('@soul.md — voice\nsee @memory/memory.md for the log')).toEqual([
      'soul.md',
      'memory/memory.md',
    ])
  })

  it('leaves email addresses alone', () => {
    expect(importTargets('Reach him at sam@example.invalid.')).toEqual([])
  })

  it('skips fenced code so a quoted example is not loaded', () => {
    expect(importTargets(['@real.md', '```', '@example.md', '```', '@other.md'].join('\n'))).toEqual([
      'real.md',
      'other.md',
    ])
  })

  it('drops trailing sentence punctuation from a path', () => {
    expect(importTargets('Read @rules.md.')).toEqual(['rules.md'])
  })
})

describe('composeProjectMemory', () => {
  it('is empty without folders or without a memory file', async () => {
    expect(await composeProjectMemory([], NO_GLOBAL)).toBe('')
    expect(await composeProjectMemory([await makeFolder({ 'README.md': 'nothing here' })], NO_GLOBAL)).toBe('')
  })

  it('carries the memory file and everything it imports, depth first', async () => {
    const root = await makeFolder({
      'CLAUDE.md': '# Notes\n@soul.md — voice\n@rules.md — rules',
      'soul.md': 'Be terse.',
      'rules.md': 'Append to @memory/memory.md every session.',
      'memory/memory.md': 'The log.',
    })
    const block = await composeProjectMemory([root], NO_GLOBAL)
    expect(block).toBe(
      [
        PROJECT_MEMORY_HEADING,
        `${memoryFileHeading(path.join(root, 'CLAUDE.md'))}\n# Notes\n@soul.md — voice\n@rules.md — rules`,
        `${memoryFileHeading(path.join(root, 'soul.md'))}\nBe terse.`,
        `${memoryFileHeading(path.join(root, 'rules.md'))}\nAppend to @memory/memory.md every session.`,
        `${memoryFileHeading(path.join(root, 'memory/memory.md'))}\nThe log.`,
      ].join('\n\n'),
    )
  })

  it('ignores an @mention that is not a file', async () => {
    const root = await makeFolder({ 'CLAUDE.md': 'Ask @Sage about it.' })
    const block = await composeProjectMemory([root], NO_GLOBAL)
    expect(block).toContain('Ask @Sage about it.')
    expect(block.match(/^--- /gm)).toHaveLength(1)
  })

  it('reads each folder and carries a shared import once', async () => {
    const shared = await makeFolder({ 'shared.md': 'Shared rule.' })
    const first = await makeFolder({ 'CLAUDE.md': `First.\n@${path.join(shared, 'shared.md')}` })
    const second = await makeFolder({ 'CLAUDE.md': `Second.\n@${path.join(shared, 'shared.md')}` })
    const block = await composeProjectMemory([first, second], NO_GLOBAL)
    expect(block).toContain('First.')
    expect(block).toContain('Second.')
    expect(block.match(/Shared rule\./g)).toHaveLength(1)
  })

  it('terminates on a cycle', async () => {
    const root = await makeFolder({ 'CLAUDE.md': 'Top.\n@loop.md', 'loop.md': 'Loop.\n@CLAUDE.md' })
    const block = await composeProjectMemory([root], NO_GLOBAL)
    expect(block.match(/Top\./g)).toHaveLength(1)
    expect(block.match(/Loop\./g)).toHaveLength(1)
  })

  it('names what it left out instead of truncating silently', async () => {
    const root = await makeFolder({
      'CLAUDE.md': '@big.md\n@small.md',
      'big.md': 'x'.repeat(MAX_PROJECT_MEMORY_CHARS + 1),
      'small.md': 'Still fits.',
    })
    const block = await composeProjectMemory([root], NO_GLOBAL)
    expect(block).toContain('Still fits.')
    expect(block).toContain(path.join(root, 'big.md'))
    expect(block).toContain(`passed ${MAX_PROJECT_MEMORY_CHARS} characters`)
    expect(block).not.toContain('x'.repeat(100))
  })

  it('returns provenance only for complete files that reached the prompt', async () => {
    const root = await makeFolder({
      'CLAUDE.md': '@big.md\n@small.md',
      'big.md': 'x'.repeat(MAX_PROJECT_MEMORY_CHARS + 1),
      'small.md': 'Still fits.',
    })

    const bundle = await composeProjectMemoryBundle([root], NO_GLOBAL)

    expect(bundle.text).toContain('Still fits.')
    expect(bundle.sources).toEqual([
      { path: path.join(root, 'CLAUDE.md'), content: '@big.md\n@small.md' },
      { path: path.join(root, 'small.md'), content: 'Still fits.' },
    ])
  })
})

describe('composeProjectMemory AGENTS.md fallback', () => {
  it('reads AGENTS.md when the folder has no CLAUDE.md', async () => {
    const root = await makeFolder({
      'AGENTS.md': 'Codex-flavoured rules.\n@extra.md',
      'extra.md': 'Imported all the same.',
    })
    const block = await composeProjectMemory([root], NO_GLOBAL)
    expect(block).toContain('Codex-flavoured rules.')
    expect(block).toContain('Imported all the same.')
  })

  it('prefers CLAUDE.md and does not also carry AGENTS.md', async () => {
    const root = await makeFolder({
      'CLAUDE.md': 'The Claude wording.',
      'AGENTS.md': 'The Codex wording.',
    })
    const block = await composeProjectMemory([root], NO_GLOBAL)
    expect(block).toContain('The Claude wording.')
    expect(block).not.toContain('The Codex wording.')
  })

  it('falls through an empty CLAUDE.md to a real AGENTS.md', async () => {
    const root = await makeFolder({ 'CLAUDE.md': '   \n', 'AGENTS.md': 'The real rules.' })
    const block = await composeProjectMemory([root], NO_GLOBAL)
    expect(block).toContain('The real rules.')
  })
})

describe('composeProjectMemory global layer', () => {
  it('loads the global config with no linked folder at all', async () => {
    const globalRoot = await makeFolder({
      'CLAUDE.md': 'Global top.\n@soul.md',
      'soul.md': 'Be terse.',
      'rules/context7.md': 'Use Context7 for library docs.',
    })
    const block = await composeProjectMemory([], { globalRoot })
    expect(block).toContain(GLOBAL_MEMORY_HEADING)
    expect(block).toContain('Global top.')
    expect(block).toContain('Be terse.')
    expect(block).toContain('Use Context7 for library docs.')
    expect(block).not.toContain(PROJECT_MEMORY_HEADING)
  })

  it('puts the folder layer first and the global layer under its own heading', async () => {
    const globalRoot = await makeFolder({ 'CLAUDE.md': 'Global rule.' })
    const root = await makeFolder({ 'CLAUDE.md': 'Project rule.' })
    const block = await composeProjectMemory([root], { globalRoot })
    expect(block.indexOf(PROJECT_MEMORY_HEADING)).toBeLessThan(block.indexOf('Project rule.'))
    expect(block.indexOf('Project rule.')).toBeLessThan(block.indexOf(GLOBAL_MEMORY_HEADING))
    expect(block.indexOf(GLOBAL_MEMORY_HEADING)).toBeLessThan(block.indexOf('Global rule.'))
  })

  it('carries a file once when a global rule is a symlink to a folder file', async () => {
    // The user's real setup: `~/.claude/rules/style.md` is a symlink into the memory folder, which
    // the folder layer already loaded. Two paths, one file, one copy.
    const root = await makeFolder({ 'CLAUDE.md': 'Project.\n@style.md', 'style.md': 'Sentence case.' })
    const globalRoot = await makeFolder({ 'CLAUDE.md': 'Global.' })
    await mkdir(path.join(globalRoot, 'rules'), { recursive: true })
    await symlink(path.join(root, 'style.md'), path.join(globalRoot, 'rules/style.md'))
    const block = await composeProjectMemory([root], { globalRoot })
    expect(block.match(/Sentence case\./g)).toHaveLength(1)
    expect(block).toContain('Global.')
  })

  it('reads global rules in a stable order', async () => {
    const globalRoot = await makeFolder({
      'rules/b.md': 'Bee.',
      'rules/a.md': 'Ay.',
      'rules/notes.txt': 'Not markdown.',
    })
    const block = await composeProjectMemory([], { globalRoot })
    expect(block.indexOf('Ay.')).toBeLessThan(block.indexOf('Bee.'))
    expect(block).not.toContain('Not markdown.')
  })

  it('is empty when the global root does not exist and no folder has a memory file', async () => {
    const block = await composeProjectMemory([], { globalRoot: path.join(tmpdir(), 'manor-no-such') })
    expect(block).toBe('')
  })
})


describe('global reference disclosure', () => {
  it('defers only global reference bodies, preserving rules and explicit project imports', async () => {
    const globalRoot = await makeFolder({
      'CLAUDE.md': '@tools.md',
      'tools.md': 'Tool route details',
      'rules/map.md': 'Capture route details',
      'rules/personal-os.md': 'Hard memory rule',
    })
    const bundle = await composeProjectMemoryBundle([], { globalRoot })
    expect(bundle.text).toContain('Hard memory rule')
    expect(bundle.text).toContain(`${globalRoot}/tools.md`)
    expect(bundle.text).toContain(`${globalRoot}/rules/map.md`)
    expect(bundle.text).not.toContain('Tool route details')
    expect(bundle.text).not.toContain('Capture route details')
    expect(bundle.sources.map((file) => file.content)).toEqual(['@tools.md', 'Hard memory rule'])
    const project = await makeFolder({ 'CLAUDE.md': `@${globalRoot}/tools.md` })
    expect((await composeProjectMemoryBundle([project], { globalRoot })).text).toContain('Tool route details')
  })
})
