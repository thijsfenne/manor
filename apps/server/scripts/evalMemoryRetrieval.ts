import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { env, pipeline } from '@huggingface/transformers'
import { MAX_STRUCTURED_MEMORY_CHARS, structuredProjectSlug } from '../src/structuredMemory.js'
import { createSemanticMemoryRanker } from '../src/semanticMemory.js'
import { composeEvaluatedMemory, memorySelectionPasses } from './memoryRetrievalChecks.js'

// Explicit paths keep private fixtures/results outside the repository. No agent
// turns or memory writes; a retrieval pass is necessary, not sufficient to promote.
const [root, casesPath, outputPath, cacheDir] = process.argv.slice(2)
if (!root || !casesPath || !outputPath || !cacheDir) {
  throw new Error('Usage: tsx scripts/evalMemoryRetrieval.ts STRUCTURED_ROOT CASES_JSON OUTPUT_JSON MODEL_CACHE')
}
const structuredRoot = path.resolve(root)
const rawCases = await readFile(casesPath, 'utf8')
const cases = z.array(z.object({
  id: z.union([z.number(), z.string()]),
  project: z.string().default('Manor'),
  question: z.string().min(1),
  sources: z.array(z.string()),
  seed: z.array(z.string()).default([]),
})).min(1).parse(JSON.parse(rawCases))
const model = 'Xenova/multilingual-e5-small'
const revision = '761b726dd34fb83930e26aab4e9ac3899aa1fa78'
// Calibration, not held-out proof. The initial 0.85 run retrieved nothing.
const thresholds = [0.7, 0.75, 0.8, 0.85]
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const hashes = new Map<string, string>()
async function snapshot(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) await snapshot(file)
    else if (entry.isFile() && entry.name.endsWith('.md')) hashes.set(file, hash(await readFile(file, 'utf8')))
  }
}
await snapshot(structuredRoot)
env.cacheDir = cacheDir
const started = performance.now()
const extractor = await pipeline('feature-extraction', model, { dtype: 'q8', revision })
const loadMs = performance.now() - started
const rank = createSemanticMemoryRanker(async (text) => {
  const result = await extractor(text, { pooling: 'mean', normalize: true })
  return Array.from(result.data, Number)
}, 0.0001)
async function evaluate(entry: (typeof cases)[number]) {
  const request = [...entry.seed, entry.question].join('\n')
  const variants = []
  for (const threshold of [undefined, ...thresholds]) {
    const mode = threshold === undefined ? 'lexical' : `semantic-${threshold}`
    const start = performance.now()
    const bundle = await composeEvaluatedMemory(structuredRoot, entry.project, request, threshold === undefined ? undefined : rank, threshold)
    const elapsedMs = performance.now() - start
    if (bundle.text.length > MAX_STRUCTURED_MEMORY_CHARS) throw new Error('Context budget exceeded')
    for (const source of bundle.sources) {
      const digest = hash(await readFile(source.path, 'utf8'))
      if (hashes.has(source.path) && hashes.get(source.path) !== digest) throw new Error('Fixture changed during evaluation')
      if (!hashes.has(source.path)) throw new Error('Source outside frozen fixture')
    }
    const selected = bundle.sources.filter((source) => source.kind === 'file').map((source) => path.relative(path.join(structuredRoot, structuredProjectSlug(entry.project)), source.path))
    variants.push({ mode, elapsedMs, chars: bundle.text.length, selected,
      relevant: selected.filter((file) => entry.sources.includes(file)).length,
      irrelevant: selected.filter((file) => !entry.sources.includes(file)).length,
      // These blocks can feed a later paired answer evaluation unchanged.
      bundle,
    })
  }
  return { ...entry, variants }
}
const results: Awaited<ReturnType<typeof evaluate>>[] = []
for (const entry of cases) results.push(await evaluate(entry))
for (const [file, digest] of hashes) {
  if (hash(await readFile(file, 'utf8')) !== digest) throw new Error('Fixture changed during evaluation')
}
const totals = (mode: string) => results.reduce((sum, result) => {
  const v = result.variants.find((variant) => variant.mode === mode)!
  return { relevant: sum.relevant + v.relevant, irrelevant: sum.irrelevant + v.irrelevant }
}, { relevant: 0, irrelevant: 0 })
const lexical = totals('lexical')
const semantic = thresholds.map((threshold) => {
  const mode = `semantic-${threshold}`
  const totalsForMode = totals(mode)
  const selectionGate = memorySelectionPasses(results.map((result) => ({
    sources: result.sources,
    before: result.variants[0]!.selected,
    after: result.variants.find((variant) => variant.mode === mode)!.selected,
  })))
  return { threshold, ...totalsForMode, selectionGate }
})
const summary = { cases: cases.length, lexical, semantic, promote: false,
  reason: semantic.some((variant) => variant.selectionGate)
    ? 'Needs held-out retrieval and paired answer-quality evaluation before promotion'
    : 'Selection gate failed; retain lexical default' }
await writeFile(outputPath, JSON.stringify({ model, revision, loadMs, casesHash: hash(rawCases),
  sourceHashes: Object.fromEntries(hashes), summary, results }, null, 2), { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify(summary, null, 2))
await extractor.dispose()
