import type { MemoryRowRanker } from './structuredMemory.js'

export type MemoryEmbedder = (text: string) => Promise<readonly number[]>

/** Cosine, independent of whether the embedder normalizes its output. */
export function memoryCosine(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) throw new Error('Incompatible memory embeddings')
  let dot = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!
    const y = b[i]!
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('Invalid memory embedding')
    dot += x * y
    aa += x * x
    bb += y * y
  }
  if (aa === 0 || bb === 0) throw new Error('Empty memory embedding')
  return dot / Math.sqrt(aa * bb)
}

/** E5 query/passage prefixes. No model, network, or persistent index in the server. */
export function createSemanticMemoryRanker(embed: MemoryEmbedder, minimumScore = 0.85): MemoryRowRanker {
  if (!Number.isFinite(minimumScore) || minimumScore <= 0 || minimumScore > 1) throw new Error('Invalid memory threshold')
  const cache = new Map<string, readonly number[]>()
  const vector = async (text: string): Promise<readonly number[]> => {
    const cached = cache.get(text)
    if (cached !== undefined) return cached
    const result = await embed(text)
    memoryCosine(result, result)
    if (cache.size >= 256) cache.delete(cache.keys().next().value!)
    cache.set(text, result)
    return result
  }
  return async (request, rows, projectName) => {
    const names = new Set(projectName.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    const withoutProject = (text: string): string => text.replace(/[\p{L}\p{N}]+/gu, (word) => names.has(word.toLowerCase()) ? '' : word).trim()
    const query = await vector(`query: ${withoutProject(request)}`)
    const scores: number[] = []
    for (const row of rows) {
      // Filenames are routing keys, not meaning. Keep the label and description.
      const text = row.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/^\s*-\s*/, '')
      const score = memoryCosine(query, await vector(`passage: ${withoutProject(text)}`))
      scores.push(score >= minimumScore ? score : 0)
    }
    return scores
  }
}
