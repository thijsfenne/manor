import { resolveStoreConfig } from '../config.js'
import { createStore } from '../stores/index.js'
import { calendarMcpDraft } from './calendarRegistration.js'
import { estimateEagerTokens, probeMcpServer } from './probe.js'
import { remindersMcpDraft } from './remindersRegistration.js'
import { codexComputerMcpDraft } from './codexComputerRegistration.js'

/**
 * Registers a derived personal connector and attaches it to the named personas.
 *
 *   pnpm --filter @manor/server register:calendar -- --attach Nova
 *   pnpm --filter @manor/server register:reminders -- --attach Nova
 *   pnpm --filter @manor/server register:codex-computer
 *
 * Idempotent. The calendar needs MANOR_ICLOUD_CALDAV_USER and
 * MANOR_ICLOUD_CALDAV_PASSWORD in apps/server/.env; reminders need RemCTL (or
 * remindctl as the plain fallback) with its Reminders access; codex-computer needs the
 * ChatGPT app with Computer Use turned on for Codex once. Attaching is the access
 * decision, so nobody gets one unless named here or in the agent editor.
 */
const DRAFTS = { calendar: calendarMcpDraft, reminders: remindersMcpDraft, 'codex-computer': codexComputerMcpDraft }

async function main(): Promise<void> {
  const connector = process.argv[2]
  if (connector !== 'calendar' && connector !== 'reminders' && connector !== 'codex-computer') {
    throw new Error('usage: registerConnector.ts calendar|reminders|codex-computer [--attach Name]')
  }
  const resolved = resolveStoreConfig(process.env)
  if (!resolved.ok) throw new Error(resolved.message)
  // Beside a running Manor: never the one to migrate the database under it.
  const store = createStore(resolved.config, { migrate: false })

  const draft = DRAFTS[connector]()
  const missing = draft.envKeys.filter((key) => !process.env[key])
  if (missing.length > 0) throw new Error(`set ${missing.join(', ')} in apps/server/.env first`)

  const existing = (await store.listMcpServers()).find((server) => server.name === draft.name)
  const withId = { ...draft, ...(existing === undefined ? {} : { id: existing.id }) }
  const saved = await store.saveMcpServer(withId, await probeMcpServer(withId))
  process.stdout.write(
    `${existing === undefined ? 'registered' : 'updated'} "${saved.name}" (${saved.id})\n` +
      `  tools: ${saved.tools.join(', ')}\n` +
      `  cost: ${saved.schemaChars} schema chars, about ${estimateEagerTokens(saved.schemaChars)} input tokens per persona per turn\n`,
  )

  const at = process.argv.indexOf('--attach')
  const names = at === -1 ? [] : (process.argv[at + 1] ?? '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean)
  const roster = await store.loadRoster()
  for (const name of names) {
    const agent = roster.find((candidate) => candidate.name.toLowerCase() === name)
    if (agent === undefined) {
      process.stdout.write(`  no persona named ${name}, skipped\n`)
      continue
    }
    if (agent.mcpServers.some((attachment) => attachment.serverId === saved.id)) continue
    await store.saveAgent({ ...agent, mcpServers: [...agent.mcpServers, { serverId: saved.id, disabledTools: [] }] })
    process.stdout.write(`  attached to ${agent.name}\n`)
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`[manor-register] ${error instanceof Error ? error.message : 'failed'}\n`)
  process.exitCode = 1
})
