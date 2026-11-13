import { resolveStoreConfig } from '../config.js'
import { createStore } from '../stores/index.js'
import { computerMcpDraft } from './computerAttachment.js'
import { estimateEagerTokens, probeMcpServer } from './probe.js'

/**
 * Adds the Cua computer connector to the registry after probing its live tools.
 * Run `pnpm --filter @manor/server provision:computer` first.
 *
 *   pnpm --filter @manor/server register:computer
 */
async function main(): Promise<void> {
  const resolved = resolveStoreConfig(process.env)
  if (!resolved.ok) throw new Error(resolved.message)
  // Beside a running Manor: never the one to migrate the database under it.
  const store = createStore(resolved.config, { migrate: false })
  const registry = await store.listMcpServers()
  const draft = computerMcpDraft()
  const existing = registry.find((server) => server.name === draft.name)
  const withId = { ...draft, ...(existing === undefined ? {} : { id: existing.id }) }
  const saved = await store.saveMcpServer(withId, await probeMcpServer(withId))
  process.stdout.write(
    `${existing === undefined ? 'registered' : 'updated'} "${saved.name}" (${saved.id})\n` +
      `  tools: ${saved.tools.join(', ')}\n` +
      `  cost: ${saved.schemaChars} schema chars, about ${estimateEagerTokens(saved.schemaChars)} input tokens ` +
      'per persona per turn\n',
  )
}

void main().catch((error: unknown) => {
  process.stderr.write(`[manor-computer-register] ${error instanceof Error ? error.message : 'failed'}\n`)
  process.exitCode = 1
})
