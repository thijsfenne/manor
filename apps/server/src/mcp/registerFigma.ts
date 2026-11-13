import { resolveStoreConfig } from '../config.js'
import { createStore } from '../stores/index.js'
import { estimateEagerTokens } from './probe.js'
import { figmaMcpDraft } from './figmaAttachment.js'
import { probeFigmaRow } from './figmaRegistration.js'

/**
 * Puts the Figma remote connector into the registry, from the command line.
 *
 *   pnpm --filter @manor/server register:figma
 *
 * The URL is Figma's hosted MCP. A 401 is expected: OAuth is the CLI's, not Manor's.
 * Authenticate once with the runtime that will call it, then attach the row to a
 * persona. Idempotent.
 */
async function main(): Promise<void> {
  const resolved = resolveStoreConfig(process.env)
  if (!resolved.ok) throw new Error(resolved.message)
  // Beside a running Manor: never the one to migrate the database under it.
  const store = createStore(resolved.config, { migrate: false })
  const registry = await store.listMcpServers()
  const draft = figmaMcpDraft()
  const existing = registry.find((server) => server.name === draft.name)
  const withId = { ...draft, ...(existing === undefined ? {} : { id: existing.id }) }

  const probed = await probeFigmaRow(withId)
  const saved = await store.saveMcpServer(withId, probed)
  process.stdout.write(
    `${existing === undefined ? 'registered' : 'updated'} "${saved.name}" (${saved.id})\n` +
      `  url: ${saved.url}\n` +
      `  tools: ${saved.tools.join(', ')}\n` +
      `  cost: ${saved.schemaChars} schema chars, about ${estimateEagerTokens(saved.schemaChars)} input tokens ` +
      'per persona per turn\n',
  )
  if (probed.oauthPending) {
    process.stdout.write(
      '  OAuth is pending in the CLI, not in Manor. Authenticate once:\n' +
        '    claude mcp add --transport http figma https://mcp.figma.com/mcp\n' +
        '    grok mcp add --transport http figma https://mcp.figma.com/mcp\n',
    )
  }
}

void main().catch((error: unknown) => {
  const detail = error instanceof Error ? error.message : 'failed'
  process.stderr.write(`[manor-figma-register] ${detail}\n`)
  process.exitCode = 1
})
