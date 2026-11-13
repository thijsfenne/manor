import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { AgentConfig, ServerMessage, SkillConfig } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { discoverSkills, parseSkillDocument } from '../src/skills/discovery.js'
import { parseSkillInvocations } from '../src/skills/invocation.js'
import { materializeSkills, validBundlePath } from '../src/skills/materialize.js'
import { defaultSkillUsagePath, readSkillUsage, recordSkillUsage, withSkillUsage } from '../src/skills/usage.js'
import { createMockDriver } from '../src/drivers/mockDriver.js'
import { ManorService } from '../src/service.js'
import type { SkillBundleFile } from '../src/store.js'
import {
  InvalidSkillCapabilityError,
  readableSkillBundleLoader,
  SkillCapabilities,
} from '../src/skillCapability.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { sage, smith } from './helpers.js'

const skill: SkillConfig = {
  id: 'brainstorm',
  name: 'Brainstorm',
  description: 'Explore alternatives.',
  instructions: 'Generate three approaches.',
  sources: ['claude'],
}

describe('skill discovery', () => {
  it('reads name, a folded description and the instruction body', () => {
    const parsed = parseSkillDocument(
      ['---', 'name: Brainstorm screen', 'description: >', '  Explore several', '  interface directions.', '---', '# Workflow', '', 'Do the work.'].join('\n'),
      'brainstorm-screen',
    )
    expect(parsed).toEqual({
      id: 'brainstorm-screen',
      name: 'Brainstorm screen',
      description: 'Explore several interface directions.',
      instructions: '# Workflow\n\nDo the work.',
    })
  })

  it('deduplicates the same symlinked SKILL.md and keeps both provider sources', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-skills-'))
    const claude = path.join(root, 'claude')
    const codex = path.join(root, 'codex')
    const folder = path.join(claude, 'brainstorm')
    mkdirSync(folder, { recursive: true })
    mkdirSync(codex, { recursive: true })
    writeFileSync(path.join(folder, 'SKILL.md'), '---\nname: Brainstorm\ndescription: Explore.\n---\nDo it.\n')
    writeFileSync(path.join(folder, 'example.md'), 'supporting file')
    symlinkSync(folder, path.join(codex, 'brainstorm'))

    const found = await discoverSkills([
      { source: 'claude', path: claude },
      { source: 'codex', path: codex },
    ])

    expect(found).toHaveLength(1)
    expect(found[0]?.candidate).toMatchObject({
      slug: 'brainstorm',
      sources: ['claude', 'codex'],
      hasSupportingFiles: true,
    })
    expect(found[0]?.skill.instructions).toBe('Do it.')
    expect(found[0]?.files.map((file) => file.path)).toEqual(['example.md', 'SKILL.md'])
    expect(found[0]?.skill).toMatchObject({ fileCount: 2, bundleBytes: expect.any(Number) })
  })
})

describe('skill bundles', () => {
  it('materialises an owned bundle with its folders and executable mode', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-skill-cache-'))
    const store = createMemoryStore()
    const bytes = new TextEncoder().encode('#!/bin/sh\necho hello\n')
    const bundled = {
      ...skill,
      bundleRevision: 'a'.repeat(64),
      fileCount: 1,
      bundleBytes: bytes.byteLength,
    }
    await store.saveSkill(bundled, [{
      path: 'scripts/hello.sh',
      bytes,
      sha256: 'bfdeaeb08cffb6a36438bcd12dda25417e3cdd36f1e7e482a2849d539225288b',
      mode: 0o755,
    }])

    const roots = await materializeSkills(store, [bundled], root)
    const destination = path.join(roots.get(skill.id) ?? '', 'scripts', 'hello.sh')
    expect(readFileSync(destination, 'utf8')).toBe('#!/bin/sh\necho hello\n')
    expect(statSync(destination).mode & 0o777).toBe(0o755)
  })

  it('refuses absolute and escaping paths', () => {
    expect(validBundlePath('templates/example.md')).toBe(true)
    expect(validBundlePath('../secret')).toBe(false)
    expect(validBundlePath('/tmp/secret')).toBe(false)
    expect(validBundlePath('templates\\secret')).toBe(false)
  })
})

describe('skill invocation', () => {
  it('keeps known skills in first-use order and ignores unknown or mid-word tokens', () => {
    const second = { ...skill, id: 'review', name: 'Review' }
    expect(parseSkillInvocations('$brainstorm then $review, $brainstorm and cash$review', [skill, second])).toEqual([
      'brainstorm',
      'review',
    ])
  })

})

describe('skill reader capability', () => {
  it('keeps a long turn readable until the turn revokes its token', async () => {
    const loader = readableSkillBundleLoader(async () => [], () => ({ instructions: 'Read me.' }))
    const capabilities = new SkillCapabilities(loader)
    const token = capabilities.issue(['brainstorm'], () => undefined, 'long-turn')
    await expect(capabilities.read(token, 'brainstorm', 'SKILL.md')).resolves.toMatchObject({ content: 'Read me.' })
    capabilities.revoke(token)
    await expect(capabilities.read(token, 'brainstorm', 'SKILL.md')).rejects.toThrow(InvalidSkillCapabilityError)
  })

  it('revokes a re-keyed token when its turn revokes the token it was issued', async () => {
    const loader = readableSkillBundleLoader(async () => [], () => ({ instructions: 'Read me.' }))
    const capabilities = new SkillCapabilities(loader)
    const issued = capabilities.issue(['brainstorm'], () => undefined, 'fresh')
    expect(capabilities.rekey(issued, 'held')).toBe('rekeyed')
    await expect(capabilities.read('held', 'brainstorm', 'SKILL.md')).resolves.toMatchObject({ content: 'Read me.' })
    capabilities.revoke(issued)
    await expect(capabilities.read('held', 'brainstorm', 'SKILL.md')).rejects.toThrow(InvalidSkillCapabilityError)
  })

  it('reads only an attached bundle and counts a complete SKILL.md read', async () => {
    const file = (filePath: string, content: string) => {
      const bytes = new TextEncoder().encode(content)
      return {
        path: filePath,
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        mode: 0o600,
      }
    }
    const files = [file('SKILL.md', 'Complete instructions.'), file('reference.md', 'Supporting reference.')]
    const used: string[] = []
    let loads = 0
    const capabilities = new SkillCapabilities(async (skillId) => {
      loads += 1
      return skillId === 'brainstorm' ? files : []
    })
    const token = capabilities.issue(['brainstorm'], (skillId) => used.push(skillId), 'capability')

    const reference = await capabilities.read(token, 'brainstorm', 'reference.md')
    expect(reference.content).toBe('Supporting reference.')
    expect(reference.nextOffset).toBeUndefined()
    expect(used).toEqual([])
    const instructions = await capabilities.read(token, 'brainstorm', 'SKILL.md')
    expect(instructions.content).toBe('Complete instructions.')
    expect(instructions.nextOffset).toBeUndefined()
    expect(used).toEqual(['brainstorm'])
    await capabilities.read(token, 'brainstorm', 'reference.md')
    expect(loads).toBe(1)
  })

  it('turns stored legacy instructions into a verified SKILL.md', async () => {
    const loader = readableSkillBundleLoader(
      async () => [],
      (skillId) => skillId === 'legacy' ? { instructions: 'Legacy instructions.' } : undefined,
    )
    const capabilities = new SkillCapabilities(loader)
    const token = capabilities.issue(['legacy'], () => undefined, 'capability')

    await expect(capabilities.read(token, 'legacy', 'SKILL.md')).resolves.toMatchObject({
      content: 'Legacy instructions.',
    })
  })

  it('bounds cached bytes and rejects reads after the turn revokes its capability', async () => {
    const bundle = (content: string) => {
      const bytes = new TextEncoder().encode(content)
      return [{
        path: 'SKILL.md',
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        mode: 0o600,
      }]
    }
    const capabilities = new SkillCapabilities(
      async (skillId) => bundle(skillId === 'first' ? '1234' : '5678'),
      6,
    )
    const token = capabilities.issue(['first', 'second'], () => undefined, 'capability')

    await expect(capabilities.read(token, 'first', 'SKILL.md')).resolves.toMatchObject({ content: '1234' })
    await expect(capabilities.read(token, 'second', 'SKILL.md')).rejects.toThrow('cache exceeds 6 bytes')
    capabilities.revoke(token)
    await expect(capabilities.read(token, 'first', 'SKILL.md')).rejects.toBeInstanceOf(InvalidSkillCapabilityError)
  })

  it('returns neither content nor usage when revoked during a bundle load', async () => {
    const bytes = new TextEncoder().encode('Instructions that must stay revoked.')
    const files = [{
      path: 'SKILL.md',
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mode: 0o600,
    }]
    let finishLoad: ((files: readonly SkillBundleFile[]) => void) | undefined
    const capabilities = new SkillCapabilities(() => new Promise((resolve) => {
      finishLoad = resolve
    }))
    const used: string[] = []
    const token = capabilities.issue(['brainstorm'], (skillId) => used.push(skillId), 'capability')

    const reading = capabilities.read(token, 'brainstorm', 'SKILL.md')
    capabilities.revoke(token)
    finishLoad?.(files)

    await expect(reading).rejects.toBeInstanceOf(InvalidSkillCapabilityError)
    expect(used).toEqual([])
  })

  it('ignores changed cache files, added files and external symlinks', async () => {
    const cache = mkdtempSync(path.join(os.tmpdir(), 'manor-skill-reader-cache-'))
    const outside = path.join(mkdtempSync(path.join(os.tmpdir(), 'manor-skill-reader-outside-')), 'secret.md')
    writeFileSync(path.join(cache, 'SKILL.md'), 'Tampered cache instructions.')
    writeFileSync(path.join(cache, 'added.md'), 'Not in the manifest.')
    writeFileSync(outside, 'Outside the bundle.')
    symlinkSync(outside, path.join(cache, 'linked.md'))
    const bytes = new TextEncoder().encode('Stored instructions.')
    const stored = [{
      path: 'SKILL.md',
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mode: 0o600,
    }]
    const capabilities = new SkillCapabilities(async () => stored)
    const token = capabilities.issue(['brainstorm'], () => undefined, 'capability')

    await expect(capabilities.read(token, 'brainstorm', 'SKILL.md')).resolves.toMatchObject({
      content: 'Stored instructions.',
    })
    await expect(capabilities.read(token, 'brainstorm', 'added.md')).rejects.toBeInstanceOf(InvalidSkillCapabilityError)
    await expect(capabilities.read(token, 'brainstorm', 'linked.md')).rejects.toBeInstanceOf(InvalidSkillCapabilityError)
  })

  it('rejects corrupt stored bytes, unattached skills and escaping paths', async () => {
    const bytes = new TextEncoder().encode('Instructions.')
    const corrupt = [{ path: 'SKILL.md', bytes, sha256: '0'.repeat(64), mode: 0o600 }]
    const capabilities = new SkillCapabilities(async () => corrupt)
    const token = capabilities.issue(['brainstorm'], () => undefined, 'capability')

    await expect(capabilities.read(token, 'review', 'SKILL.md')).rejects.toBeInstanceOf(InvalidSkillCapabilityError)
    await expect(capabilities.read(token, 'brainstorm', '../SKILL.md')).rejects.toBeInstanceOf(InvalidSkillCapabilityError)
    await expect(capabilities.read(token, 'brainstorm', 'SKILL.md')).rejects.toThrow('integrity check')
  })
})

describe('skill usage telemetry', () => {
  it('uses Manor-owned host state rather than Claude Code hook state', () => {
    expect(defaultSkillUsagePath('/Users/test')).toBe('/Users/test/.manor/skill-usage.json')
  })

  it('serialises simultaneous provider increments without counting duplicate ids twice', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-skill-usage-'))
    const usagePath = path.join(root, 'skill-usage.json')

    await Promise.all([
      recordSkillUsage(usagePath, ['brainstorm', 'brainstorm'], 'claude', '2026-08-24T09:00:00.000Z'),
      recordSkillUsage(usagePath, ['brainstorm'], 'codex', '2026-08-24T10:00:00.000Z'),
      recordSkillUsage(usagePath, ['brainstorm'], 'grok', '2026-08-24T11:00:00.000Z'),
      recordSkillUsage(usagePath, ['brainstorm'], 'cursor', '2026-08-24T12:00:00.000Z'),
      recordSkillUsage(usagePath, ['brainstorm'], 'mock', '2026-08-24T13:00:00.000Z'),
    ])

    expect(JSON.parse(readFileSync(usagePath, 'utf8'))).toEqual({
      brainstorm: {
        count: 4,
        first_used: '2026-08-24T09:00:00.000Z',
        last_used: '2026-08-24T12:00:00.000Z',
        by_driver: { claude: 1, codex: 1, grok: 1, cursor: 1 },
      },
    })
    expect(await readSkillUsage(usagePath)).toEqual(new Map([
      ['brainstorm', { count: 4, lastUsedAt: '2026-08-24T12:00:00.000Z' }],
    ]))
  })

  it('exposes count and last-used while leaving other host metadata behind', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-skill-usage-'))
    const usagePath = path.join(root, 'skill-usage.json')
    writeFileSync(
      usagePath,
      JSON.stringify({
        brainstorm: { count: 4, last_used: '2026-08-24T10:00:00Z', projects: ['Private'] },
        broken: { count: -1 },
        stale: { count: 2, last_used: 'yesterday' },
        stringy: { count: '8' },
      }),
    )

    const usage = await readSkillUsage(usagePath)

    expect(usage?.get('brainstorm')).toEqual({
      count: 4,
      lastUsedAt: '2026-08-24T10:00:00Z',
    })
    expect(usage?.get('stale')).toEqual({ count: 2 })
    expect(usage?.has('broken')).toBe(false)
    expect(usage?.has('stringy')).toBe(false)
    expect(withSkillUsage([skill], usage)).toEqual([
      {
        ...skill,
        usageCount: 4,
        lastUsedAt: '2026-08-24T10:00:00Z',
      },
    ])
  })

  it('distinguishes unavailable telemetry from a known zero', async () => {
    const usage = await readSkillUsage('/path/that/does/not/exist/skill-usage.json')

    expect(usage).toBeNull()
    expect(withSkillUsage([skill], usage)).toEqual([skill])
    expect(withSkillUsage([skill], new Map())).toEqual([{ ...skill, usageCount: 0 }])
  })
})

describe('the skill registry in the store', () => {
  it('owns the imported copy and detaches it from every persona on delete', async () => {
    const store = createMemoryStore({
      agents: [{ ...sage, skillIds: ['brainstorm'] }, { ...smith, skillIds: ['brainstorm'] }],
    })
    await store.saveSkill(skill)
    await store.deleteSkill('brainstorm')

    expect(await store.listSkills()).toEqual([])
    expect((await store.loadRoster()).every((agent) => (agent.skillIds ?? []).length === 0)).toBe(true)
  })

  it('imports by opaque candidate id, broadcasts the registry, and refreshes candidates', async () => {
    const cos = { ...sage, isCos: true }
    const store = createMemoryStore({ agents: [cos] })
    let agents: readonly AgentConfig[] = [cos]
    let skills: readonly SkillConfig[] = []
    let currentUsage = { count: 4, lastUsedAt: '2026-08-24T10:00:00Z' }
    const broadcast: ServerMessage[] = []
    const replies: ServerMessage[] = []
    const discovered = [{
      candidate: {
        candidateId: 'skill_opaque',
        slug: 'brainstorm',
        name: skill.name,
        description: skill.description,
        sources: skill.sources,
        hasSupportingFiles: false,
      },
      skill,
      files: [],
    }]
    const manor = new ManorService({
      store,
      agents: () => agents,
      setAgents: (next) => { agents = next },
      mcpServers: () => [],
      setMcpServers: () => undefined,
      skills: () => skills,
      setSkills: (next) => { skills = next },
      skillUsage: () =>
        Promise.resolve(
          new Map([
            ['brainstorm', currentUsage],
          ]),
        ),
      discoverSkills: () => Promise.resolve(discovered),
      resolveDriver: () => createMockDriver({ deltaDelayMs: 0 }),
      ensureScratchDir: () => Promise.resolve('/tmp/manor-skill-test'),
      broadcast: (message) => broadcast.push(message),
    })
    const reply = (message: ServerMessage) => replies.push(message)

    await manor.handle({ type: 'list_skill_candidates' }, reply)
    expect(replies.at(-1)).toMatchObject({ type: 'skill_candidates', skills: [{ slug: 'brainstorm' }] })

    await manor.handle({ type: 'import_skill', candidateId: 'skill_opaque', requestId: 'skill-import' }, reply)
    expect(skills).toEqual([skill])
    expect(agents[0]?.skillIds).toEqual(['brainstorm'])
    expect(broadcast).toContainEqual({
      type: 'skills',
      skills: [{ ...skill, usageCount: 4, lastUsedAt: '2026-08-24T10:00:00Z' }],
    })
    expect(broadcast.at(-1)).toMatchObject({ type: 'roster' })
    expect(replies.filter((message) => message.type === 'skill_candidates').at(-1)).toEqual({
      type: 'skill_candidates',
      skills: [],
    })
    expect(replies.at(-1)).toEqual({ type: 'ack', requestId: 'skill-import' })

    currentUsage = { count: 7, lastUsedAt: '2026-08-24T12:00:00Z' }
    await manor.handle({ type: 'list_skill_candidates' }, reply)
    expect(broadcast.at(-1)).toEqual({
      type: 'skills',
      skills: [{ ...skill, usageCount: 7, lastUsedAt: '2026-08-24T12:00:00Z' }],
    })

    await manor.handle({ type: 'delete_skill', skillId: 'brainstorm', requestId: 'skill-delete' }, reply)
    expect(skills).toEqual([])
    expect(agents[0]?.skillIds).toEqual([])
    expect(replies.at(-1)).toEqual({ type: 'ack', requestId: 'skill-delete' })
  })

  it('leaves later imports unattached once the chief of staff has a curated set', async () => {
    const existing = { ...skill, id: 'goal', name: 'Goal' }
    const cos = { ...sage, isCos: true, skillIds: ['goal'] }
    const store = createMemoryStore({ agents: [cos] })
    await store.saveSkill(existing)
    let agents: readonly AgentConfig[] = [cos]
    let skills: readonly SkillConfig[] = [existing]
    const manor = new ManorService({
      store,
      agents: () => agents,
      setAgents: (next) => { agents = next },
      mcpServers: () => [],
      setMcpServers: () => undefined,
      skills: () => skills,
      setSkills: (next) => { skills = next },
      discoverSkills: () => Promise.resolve([{
        candidate: {
          candidateId: 'skill_later',
          slug: skill.id,
          name: skill.name,
          description: skill.description,
          sources: skill.sources,
          hasSupportingFiles: false,
        },
        skill,
        files: [],
      }]),
      resolveDriver: () => createMockDriver({ deltaDelayMs: 0 }),
      ensureScratchDir: () => Promise.resolve('/tmp/manor-skill-test'),
      broadcast: () => undefined,
    })

    await manor.handle({ type: 'import_skill', candidateId: 'skill_later' }, () => undefined)

    expect(agents[0]?.skillIds).toEqual(['goal'])
    expect(skills.map((item) => item.id)).toEqual(['goal', 'brainstorm'])
  })
})
