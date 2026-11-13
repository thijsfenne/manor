import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { composeEvaluatedMemory, memorySelectionPasses } from '../scripts/memoryRetrievalChecks.js'

describe('memory retrieval evaluation', () => {
  it('rejects replacing a relevant source even when another case gains evidence', () => {
    const gain = { sources: ['routine.md'], before: [], after: ['routine.md'] }
    const phone = { sources: ['status.md', 'phone.md'], before: ['status.md'], after: ['phone.md'] }
    expect(memorySelectionPasses([phone, gain])).toBe(false)
    expect(memorySelectionPasses([{ ...phone, after: ['status.md'] }, gain])).toBe(true)
    expect(memorySelectionPasses([{ ...phone, after: ['status.md', 'unrelated.md'] }, gain])).toBe(false)
    expect(memorySelectionPasses([{ ...phone, after: ['status.md'] }])).toBe(false)
  })

  it('refuses silent fallback and invalid scores before applying the threshold', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'manor-eval-'))
    try {
      await mkdir(path.join(root, 'manor'))
      await writeFile(path.join(root, 'manor/MEMORY.md'), '- [Cloud](cloud.md)')
      await writeFile(path.join(root, 'manor/cloud.md'), 'Hosting evidence')
      for (const ranker of [
        async () => [NaN], async () => [Infinity], async () => [], async () => [1, 1],
        async () => new Array<number>(1), async (): Promise<number[]> => { throw undefined },
      ]) {
        await expect(composeEvaluatedMemory(root, 'Manor', 'cloud', ranker, 0.8)).rejects.toThrow('refusing to score')
      }
      const abstain = await composeEvaluatedMemory(root, 'Manor', 'cloud', async () => [0.7], 0.8)
      expect(abstain.sources.every((source) => source.kind === 'index')).toBe(true)
      const semantic = await composeEvaluatedMemory(root, 'Manor', 'hosting', async () => [0.9], 0.8)
      expect(semantic.sources.filter((source) => source.kind === 'file')).toHaveLength(1)
      const lexical = await composeEvaluatedMemory(root, 'Manor', 'cloud')
      expect(lexical.sources.filter((source) => source.kind === 'file')).toHaveLength(1)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
