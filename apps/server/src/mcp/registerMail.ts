import { resolveStoreConfig } from '../config.js'
import { createStore } from '../stores/index.js'
import { estimateEagerTokens, probeMcpServer } from './probe.js'
import { mailMcpDraft } from './mailAttachment.js'

/**
 * Puts the mail connector into the registry, once its credentials are present, from
 * the command line.
 *
 * The Connectors form is the normal way to register a server, and for `npx some-mcp`
 * it is the right one. This server's `command` and `args` are absolute paths into the
 * running Node and a pnpm-hashed `tsx` directory, which is not something to retype by
 * hand into a form. So it is derived here and probed on the way in, exactly as the
 * form would, and `reconcileMailServers` keeps it pointing at the right runtime after
 * every restart.
 *
 *   pnpm --filter @manor/server register:mail
 *
 * Idempotent: running it again re-probes and overwrites the same row. Missing
 * env keys fail with the keys to set.
 */
async function main(): Promise<void> {
  const resolved = resolveStoreConfig(process.env)
  if (!resolved.ok) throw new Error(resolved.message)
  // Beside a running Manor: never the one to migrate the database under it.
  const store = createStore(resolved.config, { migrate: false })
  const registry = await store.listMcpServers()

  const draft = mailMcpDraft()
  const missing = draft.envKeys.filter((key) => {
    const value = process.env[key]
    return value === undefined || value.length === 0
  })
  if (missing.length > 0) {
    throw new Error(`the mail credentials are missing: set ${missing.join(', ')} on the machine, then run register:mail again`)
  }

  const existing = registry.find((server) => server.name === draft.name)
  const withId = { ...draft, ...(existing === undefined ? {} : { id: existing.id }) }
  const probed = await probeMcpServer(withId)
  const saved = await store.saveMcpServer(withId, probed)

  process.stdout.write(
    `${existing === undefined ? 'registered' : 'updated'} "${saved.name}" (${saved.id})\n` +
      `  tools: ${saved.tools.join(', ')}\n` +
      `  cost: ${saved.schemaChars} schema chars, about ${estimateEagerTokens(saved.schemaChars)} input tokens ` +
      'per persona per turn\n',
  )
}

void main().catch((error: unknown) => {
  process.stderr.write(`[manor-mail-register] ${error instanceof Error ? error.message : 'failed'}\n`)
  process.exitCode = 1
})
