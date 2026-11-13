import { resolveStoreConfig } from '../config.js'
import { createStore } from '../stores/index.js'
import { estimateEagerTokens } from './probe.js'
import { paperMcpDraft } from './paperAttachment.js'
import { probePaperRow } from './paperRegistration.js'

/**
 * Adds Paper's desktop MCP to the registry after learning its live tool list.
 * Paper Desktop must have a file open while this command runs.
 *
 *   pnpm --filter @manor/server register:paper
 */
async function main(): Promise<void> {
  const resolved = resolveStoreConfig(process.env)
  if (!resolved.ok) throw new Error(resolved.message)
  // Beside a running Manor: never the one to migrate the database under it.
  const store = createStore(resolved.config, { migrate: false })
  const registry = await store.listMcpServers()
  const draft = paperMcpDraft()
  const existing = registry.find((server) => server.name === draft.name)
  const withId = { ...draft, ...(existing === undefined ? {} : { id: existing.id }) }

  const probed = await probePaperRow(withId)
  const saved = await store.saveMcpServer(withId, probed)
  process.stdout.write(
    `${existing === undefined ? 'registered' : 'updated'} "${saved.name}" (${saved.id})\n` +
      `  url: ${saved.url}\n` +
      `  tools: ${saved.tools.join(', ')}\n` +
      `  cost: ${saved.schemaChars} schema chars, about ${estimateEagerTokens(saved.schemaChars)} input tokens ` +
      'per persona per turn\n',
  )
}

void main().catch((error: unknown) => {
  process.stderr.write(`[manor-paper-register] ${error instanceof Error ? error.message : 'failed'}\n`)
  process.exitCode = 1
})
