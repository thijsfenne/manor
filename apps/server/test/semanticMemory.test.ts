import { describe, expect, it } from 'vitest'
import { createSemanticMemoryRanker, memoryCosine } from '../src/semanticMemory.js'

describe('semantic memory ranking', () => {
  it('matches meaning without shared words, abstains, and re-embeds changed rows', async () => {
    const calls: string[] = []
    const rank = createSemanticMemoryRanker(async (text) => {
      calls.push(text)
      return /sollicitaties|job hunting/.test(text) ? [1, 0] : [0, 1]
    })
    const rows = ['- [Careers](career.md) job hunting', '- [Food](food.md) recipes']
    expect(await rank('Manor sollicitaties', rows, 'Manor')).toEqual([1, 0])
    expect(calls[0]).toBe('query: sollicitaties')
    expect(calls[1]).toBe('passage: Careers job hunting')
    await rank('Manor sollicitaties', rows, 'Manor')
    expect(calls).toHaveLength(3)
    expect(await rank('sollicitaties', ['- [Careers](career.md) recipes'], 'Manor')).toEqual([0])
  })

  it('rejects invalid embeddings and thresholds instead of ranking nonsense', () => {
    expect(memoryCosine([2, 0], [3, 0])).toBe(1)
    for (const vector of [[], [0, 0], [NaN, 1], [Infinity, 1], [1]]) {
      expect(() => memoryCosine([1, 0], vector)).toThrow()
    }
    expect(() => createSemanticMemoryRanker(async () => [1], NaN)).toThrow()
  })
})
