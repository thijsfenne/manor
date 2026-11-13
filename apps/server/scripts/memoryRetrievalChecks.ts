import { composeStructuredMemoryBundle, type MemoryRowRanker, type StructuredMemoryOptions } from '../src/structuredMemory.js'

/** Evaluation must never score the compositor's lexical fallback as semantic. */
export async function composeEvaluatedMemory(
  root: string, project: string, request: string, ranker?: MemoryRowRanker, threshold = 0,
  options: StructuredMemoryOptions = {},
) {
  let failed = false
  let failure: unknown
  const bundle = await composeStructuredMemoryBundle(root, project, request, ranker === undefined ? undefined : async (...args) => {
    try {
      const scores = Array.from(await ranker(...args))
      if (scores.length !== args[1].length || scores.some((score) => !Number.isFinite(score))) {
        throw new Error('Invalid semantic scores')
      }
      return scores.map((score) => score >= threshold ? score : 0)
    } catch (error) {
      failed = true
      failure = error
      throw error
    }
  }, options)
  if (failed) throw new Error('Semantic evaluation fell back; refusing to score it', { cause: failure })
  return bundle
}

/** More hits elsewhere cannot compensate for losing an existing source fact. */
export function memorySelectionPasses(cases: readonly {
  sources: readonly string[]
  before: readonly string[]
  after: readonly string[]
}[]): boolean {
  let gain = 0
  for (const entry of cases) {
    const before = new Set(entry.before)
    const after = new Set(entry.after)
    const relevantBefore = [...before].filter((file) => entry.sources.includes(file))
    const relevantAfter = [...after].filter((file) => entry.sources.includes(file))
    if (relevantBefore.some((file) => !after.has(file))) return false
    if (after.size - relevantAfter.length > before.size - relevantBefore.length) return false
    gain += relevantAfter.length - relevantBefore.length
  }
  return gain > 0
}
