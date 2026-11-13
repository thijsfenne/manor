import path from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { resolveStoreConfig } from '../src/config.js'
import { resolveMemoryTarget } from '../src/memoryTarget.js'
import { ProjectThreads } from '../src/projectThreads.js'
import { createSqliteStore } from '../src/stores/sqliteStore.js'

try {
  process.loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)))
} catch {
  // The environment may already carry the configuration, as at server startup.
}

const memoryTarget = resolveMemoryTarget(process.env, homedir())
const resolved = resolveStoreConfig(process.env)
if (!resolved.ok) throw new Error(resolved.message)
if (resolved.config.kind !== 'sqlite') throw new Error('The setup CLI requires the local SQLite store.')
const database = resolved.config.filename
const structuredRoot = path.resolve(memoryTarget.dailyDir, '..', 'structured')

// Dry-run is the default. No provider turn or archive cleanup runs through this tool.
const dryRun = !process.argv.includes('--apply')
const allowIndexAdditions = process.argv.includes('--allow-index-additions')
const store = createSqliteStore({ filename: database })
const threads = new ProjectThreads({
  store,
  structuredRoot,
  agentName: (id) => id,
  emit: () => undefined,
  broadcastDirectory: async () => undefined,
  wake: () => undefined,
  answerQuestion: async () => false,
  awaitingInput: () => ({}),
  isActiveTurn: () => false,
  acceptHandoff: async () => { throw new Error('No handoffs during setup') },
  reopenSession: async () => undefined,
  acceptInSession: async () => undefined,
})
const plan = await threads.reconcileSetup(true)
const refuse = (message: string): never => {
  console.log(JSON.stringify({ dryRun: true, database, structuredRoot, projects: plan }, null, 2))
  store.close()
  throw new Error(message)
}
if (!dryRun && plan.some((project) => project.error !== undefined)) {
  refuse('Project setup has errors. Read the dry-run report before applying.')
}
if (!dryRun && plan.some((project) => project.files.some((file) => file.kinds.some((kind) =>
  kind === 'heading' || (kind === 'index-row-added' && !allowIndexAdditions))))) {
  refuse('Setup needs changes beyond added files, owner markers and index-row conversions. Read the dry-run report and ask the user before applying.')
}
const projects = dryRun ? plan : await threads.reconcileSetup()
const databaseWrites = Number(store.db.prepare('SELECT total_changes() AS count').get()?.count)
console.log(JSON.stringify({ dryRun, database, structuredRoot, databaseWrites, projects }, null, 2))
if (projects.some((project) => project.error !== undefined)) process.exitCode = 1
store.close()
