import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { rankTypesafeMemory, TYPESAFE_MEMORY_THRESHOLD } from '../src/drivers/typesafeMemory.js'
import { MAX_STRUCTURED_MEMORY_CHARS, structuredProjectSlug } from '../src/structuredMemory.js'
import { composeEvaluatedMemory, memorySelectionPasses } from './memoryRetrievalChecks.js'

// Explicit private paths, no CLI turns and no writes to the memory fixture.
const [root, casesPath, outputDir] = process.argv.slice(2)
if (!root || !casesPath || !outputDir) throw new Error('Usage: tsx scripts/evalTypesafeMemory.ts STRUCTURED_ROOT CASES_JSON NEW_OUTPUT_DIR')
const structuredRoot = path.resolve(root)
const key = process.env.TYPESAFE_API_KEY
if (!key?.trim()) throw new Error('TypeSafe credentials unavailable')
const rawCases = await readFile(casesPath, 'utf8')
const cases = z.array(z.object({
  id: z.string(), project: z.string().default('Manor'), question: z.string().min(1),
  sources: z.array(z.string()), seed: z.array(z.string()).default([]),
  scope: z.enum(['project', 'knowledge']).default('project'),
  personalMemory: z.boolean().default(true),
  projectNames: z.array(z.string()).default([]),
  expectedCalls: z.number().int().min(0).max(1).default(1),
})).min(1).parse(JSON.parse(rawCases))
if (new Set(cases.map((entry) => entry.id)).size !== cases.length) throw new Error('Duplicate case IDs')
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const hashes: Record<string, string> = {}
async function snapshot(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) await snapshot(file)
    else if (entry.isFile() && entry.name.endsWith('.md')) hashes[file] = hash(await readFile(file, 'utf8'))
  }
}
await snapshot(structuredRoot)
const verify = async () => {
  if (hash(await readFile(casesPath, 'utf8')) !== hash(rawCases)) throw new Error('Cases changed during evaluation')
  for (const [file, digest] of Object.entries(hashes)) {
    if (hash(await readFile(file, 'utf8')) !== digest) throw new Error('Fixture changed during evaluation')
  }
}
await mkdir(outputDir, { mode: 0o700 })
await writeFile(path.join(outputDir, 'protocol.json'), JSON.stringify({
  root: structuredRoot, casesHash: hash(rawCases), sourceHashes: hashes, threshold: TYPESAFE_MEMORY_THRESHOLD,
  rankerHash: hash(await readFile(new URL('../src/drivers/typesafeMemory.ts', import.meta.url), 'utf8')),
  gate: 'Zero irrelevant files in every Jev case, no fallback, expected request count. Retain the historical gain/source-preservation gate as a separate metric.',
  selectorHash: hash(await readFile(new URL('../src/structuredMemory.ts', import.meta.url), 'utf8')),
  pricing: { inputPerMillionUsd: 0.042, outputPerMillionUsd: 0, kind: 'Published jev-1.12 estimate, not an invoice' },
}, null, 2), { flag: 'wx', mode: 0o600 })

async function evaluate(entry: (typeof cases)[number]) {
  const request = [...entry.seed, entry.question].join('\n')
  const variants = []
  for (const mode of ['lexical', 'jev'] as const) {
    // One ranker request per candidate index; a case expecting no memory makes none.
    const measurements: (Awaited<ReturnType<typeof rankTypesafeMemory>> & { candidates: readonly string[] })[] = []
    const started = performance.now()
    const bundle = await composeEvaluatedMemory(structuredRoot, entry.project, request, mode === 'lexical' ? undefined : async (...args) => {
      const measurement = await rankTypesafeMemory(key!, ...args)
      measurements.push({ ...measurement, candidates: args[1] })
      return measurement.scores
    }, 0, { scope: entry.scope, personalMemory: entry.personalMemory, projectNames: entry.projectNames, currentQuestion: entry.question })
    const elapsedMs = performance.now() - started
    const calls = measurements.length
    if (mode === 'jev' && (calls > 0) !== (entry.expectedCalls > 0)) throw new Error('Unexpected Jev request count')
    const usage = measurements.reduce((sum, measurement) => ({
      input_tokens: sum.input_tokens + measurement.usage.input_tokens, output_tokens: sum.output_tokens + measurement.usage.output_tokens,
    }), { input_tokens: 0, output_tokens: 0 })
    const measurement = calls === 0 ? undefined : { usage, models: [...new Set(measurements.map((entry) => entry.model))] }
    const candidates = measurements.flatMap((entry) => entry.candidates.map((row, index) => ({ row, probability: entry.probabilities[index]! })))
    if (bundle.text.length > MAX_STRUCTURED_MEMORY_CHARS) throw new Error('Context budget exceeded')
    const selected = bundle.sources.filter((source) => source.kind === 'file').map((source) => {
      if (hashes[source.path] === undefined) throw new Error('Source outside frozen fixture')
      return path.relative(path.join(structuredRoot, structuredProjectSlug(entry.project)), source.path)
    })
    variants.push({ mode, elapsedMs, calls, measurement, candidates, selected, bundle,
      relevant: selected.filter((file) => entry.sources.includes(file)).length,
      irrelevant: selected.filter((file) => !entry.sources.includes(file)).length,
    })
  }
  await verify()
  return { ...entry, variants }
}
const results: Awaited<ReturnType<typeof evaluate>>[] = []
for (const entry of cases) {
  const result = await evaluate(entry)
  results.push(result)
  // Incremental private evidence survives a later timeout; no failure is scored as success.
  await writeFile(path.join(outputDir, `case-${results.length}.json`), JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 })
  console.log(JSON.stringify({ id: entry.id, variants: result.variants.map(({ mode, relevant, irrelevant, elapsedMs }) => ({ mode, relevant, irrelevant, elapsedMs })) }))
}
const totals = (mode: string) => results.flatMap((result) => result.variants.filter((variant) => variant.mode === mode))
  .reduce((sum, variant) => ({ relevant: sum.relevant + variant.relevant, irrelevant: sum.irrelevant + variant.irrelevant }), { relevant: 0, irrelevant: 0 })
const jev = results.map((result) => result.variants[1]!)
const times = jev.map((variant) => variant.elapsedMs).sort((a, b) => a - b)
const inputTokens = jev.reduce((sum, variant) => sum + (variant.measurement?.usage.input_tokens ?? 0), 0)
const outputTokens = jev.reduce((sum, variant) => sum + (variant.measurement?.usage.output_tokens ?? 0), 0)
const summary = {
  cases: cases.length, lexical: totals('lexical'), jev: totals('jev'),
  selectionGate: memorySelectionPasses(results.map((result) => ({ sources: result.sources, before: result.variants[0]!.selected, after: result.variants[1]!.selected }))),
  zeroIrrelevantGate: jev.every((variant) => variant.irrelevant === 0),
  latencyMs: {
    median: (times[Math.floor((times.length - 1) / 2)]! + times[Math.floor(times.length / 2)]!) / 2,
    p95: times[Math.ceil(times.length * 0.95) - 1],
  },
  inputTokens, outputTokens, estimatedUsd: inputTokens / 1_000_000 * 0.042,
  models: [...new Set(jev.flatMap((variant) => variant.measurement?.models ?? []))],
  requestsPerCase: { median: jev.map((variant) => variant.calls).sort((a, b) => a - b)[Math.floor(jev.length / 2)], max: Math.max(...jev.map((variant) => variant.calls)) },
  promoted: false,
}
await writeFile(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2), { flag: 'wx', mode: 0o600 })
console.log(JSON.stringify(summary))
