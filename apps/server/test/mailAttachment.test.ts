import { describe, expect, it } from 'vitest'
import { mailMcpDraft } from '../src/mcp/mailAttachment.js'
import { derivedRowCurrent, derivedRowDraft, derivedRuntimeUnchanged, reconcileMailServers } from '../src/mcp/mailRegistration.js'
import { remindersMcpDraft } from '../src/mcp/remindersRegistration.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'

describe('mailMcpDraft', () => {
  const runtime = { execPath: '/usr/bin/node', execArgv: [], entryPath: '/tmp/mailMcp.ts' }

  it('keeps the personal mailbox on the original server name and env keys', () => {
    const draft = mailMcpDraft(runtime)
    expect(draft.name).toBe('mail')
    expect(draft.envKeys).toEqual(['MANOR_MAIL_IMAP_USER', 'MANOR_MAIL_IMAP_PASSWORD'])
    expect(draft.args.at(-1)).toBe('--env-prefix=MANOR_MAIL')
  })
})

describe('derivedRowDraft', () => {
  it('keeps a hand-added host key when re-deriving the row', () => {
    const derived = mailMcpDraft({
      execPath: '/usr/bin/node',
      execArgv: [],
      entryPath: '/tmp/mailMcp.ts',
    })
    const existing = {
      ...derived,
      id: 'mcp_1',
      tools: ['mail_search'],
      readOnlyTools: [],
      schemaChars: 1,
      envKeys: [...derived.envKeys, 'MANOR_MAIL_IMAP_HOST'],
    }
    expect(derivedRowDraft(existing, derived).envKeys).toEqual([
      'MANOR_MAIL_IMAP_USER',
      'MANOR_MAIL_IMAP_PASSWORD',
      'MANOR_MAIL_IMAP_HOST',
    ])
  })
})

describe('derivedRowCurrent', () => {
  const derived = remindersMcpDraft({ execPath: '/usr/bin/node', execArgv: [], entryPath: '/tmp/remindersMcp.ts' })
  const row = { ...derived, id: 'mcp_1', tools: ['list_reminders'], readOnlyTools: [], schemaChars: 1 }

  it('accepts a row that carries every derived env key, and any the user added', () => {
    expect(derivedRowCurrent({ ...row, envKeys: [...derived.envKeys, 'EXTRA'] }, derived)).toBe(true)
  })

  it('rejects a row saved before the shared list names became an env key', () => {
    // The delete guard reads the names in the connector's own process, so a row
    // without the key leaves the guard with nothing to match against.
    const stale = { ...row, envKeys: ['HOME'] }
    expect(derivedRuntimeUnchanged(stale, derived)).toBe(true)
    expect(derivedRowCurrent(stale, derived)).toBe(false)
  })
})

describe('reconcileMailServers', () => {
  it('does not create a mail row that was never registered', async () => {
    const store = createMemoryStore()
    expect(await reconcileMailServers(store, [])).toEqual([])
    expect(await store.listMcpServers()).toEqual([])
  })

  it('leaves a row whose runtime already matches this process', async () => {
    const store = createMemoryStore()
    const derived = mailMcpDraft()
    const saved = await store.saveMcpServer(derived, { tools: ['mail_search'], readOnlyTools: [], schemaChars: 1 })
    const next = await reconcileMailServers(store, [saved])
    expect(next).toEqual([saved])
    expect(derivedRuntimeUnchanged(saved, derived)).toBe(true)
  })
})
