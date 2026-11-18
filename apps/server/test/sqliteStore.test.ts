import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSqliteStore } from '../src/stores/sqliteStore.js'
import { createChatMedia } from '../src/chatMedia.js'
import { readDeliverable } from '../src/fileDelivery.js'
import { claimDatabaseOwner, SqliteRecords, SQLITE_SCHEMA_VERSION } from '../src/stores/sqliteDatabase.js'
import { sage, recording, scratchFor, until } from './helpers.js'
import { Orchestrator } from '../src/orchestrator.js'
import { DEFAULT_HOUSE_SETTINGS, GoalReportSchema, type ThreadEvent, type TurnInput } from '@manor/contracts'
import { createMockDriver } from '../src/drivers/mockDriver.js'
import { WorkModule } from '../src/workModule.js'
import { prepareWorkCompletion } from '../src/workCompletion.js'
import type { Store } from '../src/store.js'

const directories: string[] = []
const opened: ReturnType<typeof createSqliteStore>[] = []
afterEach(() => {
  for (const store of opened.splice(0)) { try { store.close() } catch { /* A restart test closed this handle already. */ } }
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'manor-sqlite-'))
  directories.push(directory)
  const filename = path.join(directory, 'manor.db')
  const store = createSqliteStore({ filename, seed: true, agents: [sage] })
  opened.push(store)
  return { store, filename }
}

describe('database owner', () => {
  it('refuses a second server on the database until the first process is gone, even killed', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'manor-owner-'))
    directories.push(directory)
    const filename = path.join(directory, 'manor.db')
    const module = new URL('../src/stores/sqliteDatabase.ts', import.meta.url).href
    const first = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      `const { claimDatabaseOwner } = await import(${JSON.stringify(module)})
      globalThis.owner = claimDatabaseOwner(${JSON.stringify(filename)})
      console.log('claimed')
      setInterval(() => {}, 1000)`], { stdio: ['ignore', 'pipe', 'inherit'] })
    try {
      await once(first.stdout!, 'data')
      expect(() => claimDatabaseOwner(filename)).toThrow('Another Manor server already uses')
    } finally {
      first.kill('SIGKILL')
    }
    await once(first, 'exit')
    claimDatabaseOwner(filename).close()
  })

  it('meets the same claim through a symlink to the database', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'manor-owner-'))
    directories.push(directory)
    const filename = path.join(directory, 'manor.db')
    writeFileSync(filename, '')
    symlinkSync(filename, path.join(directory, 'alias.db'))
    const held = claimDatabaseOwner(filename)
    try {
      expect(() => claimDatabaseOwner(path.join(directory, 'alias.db'))).toThrow('Another Manor server already uses')
    } finally {
      held.close()
    }
  })
})

describe('project setup records', () => {
  it('persists the version across restart, reads a legacy record as its version and skips unchanged writes', async () => {
    const { store, filename } = fixture()
    const project = await store.createProject('Client')
    const chat = await store.createChat({ kind: 'project', projectId: project.id, mode: 'single' })
    await store.setProjectThread(project.id, chat.id)
    await store.setProjectSetupVersion(project.id, 1)
    // A record from before hiding replaced the removal flag still carries it.
    store.db.prepare("UPDATE records SET value = json_set(value, '$.threadRemoved', json('true')) WHERE collection = 'projectSetup'").run()
    store.close()
    const restarted = createSqliteStore({ filename })
    opened.push(restarted)
    expect(await restarted.getProjectSetup(project.id)).toEqual({ version: 1 })
    const before = restarted.db.prepare('SELECT total_changes() AS count').get()?.count
    await restarted.setProjectSetupVersion(project.id, 1)
    expect(restarted.db.prepare('SELECT total_changes() AS count').get()?.count).toBe(before)
    await restarted.setProjectThread(project.id, null)
    await restarted.setProjectThread(project.id, chat.id)
    await restarted.deleteChat(chat.id)
    expect((await restarted.getProject(project.id))?.threadChatId).toBeUndefined()
    expect(await restarted.getProjectSetup(project.id)).toEqual({ version: 1 })
    await restarted.deleteProject(project.id)
    expect(await restarted.getProjectSetup(project.id)).toBeUndefined()
  })

  it('keeps a no to the verify skills offer across restart, even when a yes is stored after it', async () => {
    const { store, filename } = fixture()
    const project = await store.createProject('Shop')
    await store.setProjectVerifySkills(project.id, 'declined')
    await store.setProjectVerifySkills(project.id, 'added')
    store.close()
    const restarted = createSqliteStore({ filename })
    opened.push(restarted)
    expect((await restarted.getProject(project.id))?.verifySkills).toBe('declined')
  })
})

describe('house settings record', () => {
  it('reads defaults until saved, fills keys a saved record lacks, and survives a restart', async () => {
    const { store, filename } = fixture()
    expect(await store.getHouseSettings()).toEqual(DEFAULT_HOUSE_SETTINGS)
    // A record saved before a key existed reads that key's default.
    new SqliteRecords(store.db, 'settings').set('house', { autoSettleDays: 5 })
    expect(await store.getHouseSettings()).toEqual({ ...DEFAULT_HOUSE_SETTINGS, autoSettleDays: 5 })
    // One that no longer parses falls back to the defaults and is left on disk to repair.
    new SqliteRecords(store.db, 'settings').set('house', { autoSettleDays: 'soon' })
    expect(await store.getHouseSettings()).toEqual(DEFAULT_HOUSE_SETTINGS)
    expect(new SqliteRecords(store.db, 'settings').get('house')).toEqual({ autoSettleDays: 'soon' })

    await store.saveHouseSettings({ ...DEFAULT_HOUSE_SETTINGS, backupRetentionDays: null })
    store.close()
    const reopened = createSqliteStore({ filename })
    opened.push(reopened)
    expect(await reopened.getHouseSettings()).toEqual({ ...DEFAULT_HOUSE_SETTINGS, backupRetentionDays: null })
  })
})

describe('persistent SQLite store', () => {
  it('refuses placement migration without altering a persona still attached to a group', async () => {
    const { store, filename } = fixture()
    new SqliteRecords(store.db, 'agents').set('wren', { ...sage, id: 'wren', name: 'Wren' })
    await store.createChat({ kind: 'group', memberIds: ['sage', 'wren'], title: 'Existing team' })
    store.db.exec('PRAGMA user_version = 6')
    expect(() => createSqliteStore({ filename })).toThrow('out of groups and routines')
    expect((await store.loadRoster()).find((agent) => agent.id === 'wren')?.placement).toBeUndefined()
    expect(store.db.prepare('PRAGMA user_version').get()?.user_version).toBe(6)
  })

  it('migrates only accepted unfinished teams and preserves persona settings and history', async () => {
    const { store, filename } = fixture()
    const roster = new SqliteRecords(store.db, 'agents')
    const wren = { ...sage, id: 'wren', name: 'Wren', model: 'custom-model', memoryScope: true,
      mentionAllowlist: ['sage'], character: 'Existing craft instructions.', skillIds: ['pdf'] }
    roster.set('wren', wren)
    roster.set('argus', { ...sage, id: 'argus', name: 'Argus', driver: 'codex', mentionAllowlist: ['sage'] })
    const accepted = await pendingProposal(store)
    const target = await workModule(store).module.accept(accepted.id)
    await store.appendEvent(target, { type: 'agent_message', agentId: 'wren', turnId: 'old', text: 'Existing work.' })
    const originalEvents = await store.loadEvents(target)
    const pending = await pendingProposal(store, 'another-turn')
    const oldChat = await store.createChat({ projectId: accepted.projectId })
    store.db.exec('PRAGMA user_version = 6')
    store.close()
    const restarted = createSqliteStore({ filename })
    opened.push(restarted)
    expect((await restarted.getChat(target))?.legacySessionAgentIds?.sort()).toEqual(['sage', 'wren'])
    expect((await restarted.getChat(oldChat.id))?.legacySessionAgentIds).toBeUndefined()
    expect((await restarted.listWorkHandoffs()).find((h) => h.id === pending.id)?.acceptedAt).toBeNull()
    expect(await restarted.loadEvents(target)).toEqual(originalEvents)
    const migrated = await restarted.loadRoster()
    expect(migrated.find((a) => a.id === 'sage')?.placement).toBe('chat')
    expect(migrated.find((a) => a.id === 'wren')).toMatchObject({ placement: 'session',
      model: 'custom-model', memoryScope: true, skillIds: ['pdf'] })
    expect(migrated.find((a) => a.id === 'wren')?.character).toContain(wren.character)
    expect(migrated.find((a) => a.id === 'argus')?.mentionAllowlist).toContain('sage')
    expect(migrated.find((a) => a.id === 'ellis')).toMatchObject({ name: 'Ellis', placement: 'session', isCos: false })
    await restarted.setChatSettled(target, true)
    await restarted.setChatSettled(target, false)
    expect((await restarted.getChat(target))?.legacySessionAgentIds).toBeUndefined()
    restarted.close()
    const again = createSqliteStore({ filename })
    opened.push(again)
    expect(await again.loadRoster()).toEqual(migrated)
  })
  it('rewrites only the seeded wording of Wren\'s character to the Session engineer who never commits', async () => {
    const { store, filename } = fixture()
    const seeded = [
      'You are Wren, responsible for client components, screens, styling, interaction, motion and client state. Implement decided designs with the smallest fitting change. Route open design decisions to Iris and work beyond the client to Smith through the current chat route. Keep motion purposeful.',
      'Changes going to Argus for review stay uncommitted for him; address his findings and return for review. For work that does not require review, commit and push it yourself once checks pass. Before committing or pushing, verify that the staged changes and outgoing commits contain only your verified work and target the intended branch; otherwise stop and report the blocker.',
      'Use plain language with Sam.',
      'Your Session role now covers architecture, backend, runtime, tooling and frontend. Implement the approved brief across the stack. Preserve your frontend craft. Bring Argus in for review. Do not route backend implementation to Smith; he is the technical contact in chat.',
    ].join('\n\n')
    const roster = new SqliteRecords(store.db, 'agents')
    roster.set('wren', { ...sage, id: 'wren', name: 'Wren', character: seeded })
    roster.set('smith', { ...sage, id: 'smith', name: 'Smith', character: 'Sam edited: commit and push it yourself.' })
    store.db.exec('PRAGMA user_version = 10')
    store.close()
    const migrated = createSqliteStore({ filename })
    opened.push(migrated)
    const roster11 = await migrated.loadRoster()
    const character = roster11.find((agent) => agent.id === 'wren')?.character ?? ''
    expect(character).not.toMatch(/Iris|commit and push it yourself|Your Session role now covers/)
    expect(character).toContain('Never commit or push yourself.')
    expect(character).toContain("Manor commits a Session's changes at the user's Confirm")
    expect(character).toContain('Smith is the technical contact in chat, not a route for implementation.')
    expect(character.endsWith('Use plain language with Sam.')).toBe(true)
    expect(roster11.find((agent) => agent.id === 'smith')?.character).toBe('Sam edited: commit and push it yourself.')
  })

  it('clears the retired DM-only flag and folder link from every agent, leaving chats and the rest of the agent', async () => {
    const { store, filename } = fixture()
    const roster = new SqliteRecords(store.db, 'agents')
    roster.set('post', { ...sage, id: 'post', name: 'Post', dmOnly: true, projectId: null })
    roster.set('nova', { ...sage, id: 'nova', name: 'Nova', dmOnly: true, projectId: 'project_gone', mentionAllowlist: ['sage'] })
    const dm = await store.createChat({ kind: 'dm', memberIds: ['post'], title: 'Post' })
    store.db.exec('PRAGMA user_version = 12')
    store.close()
    const migrated = createSqliteStore({ filename })
    opened.push(migrated)
    const agents = await migrated.loadRoster()
    for (const id of ['post', 'nova', 'sage']) {
      const agent = agents.find((row) => row.id === id)
      expect(agent).toBeDefined()
      expect(agent).not.toHaveProperty('dmOnly')
      expect(agent).not.toHaveProperty('projectId')
    }
    expect(agents.find((row) => row.id === 'nova')).toMatchObject({ name: 'Nova', character: sage.character, mentionAllowlist: ['sage'] })
    expect((await migrated.getChat(dm.id))?.memberIds).toEqual(['post'])
  })

  it('gives a project hidden before the link was kept its old thread back, only where one chat is the clear thread', async () => {
    const { store, filename } = fixture()
    const thread = (projectId: string, title: string, extra: Partial<Parameters<typeof store.createChat>[0]> = {}) =>
      store.createChat({ kind: 'project', projectId, mode: 'single', title, ...extra })
    const hidden = await store.createProject('Eurotrip')
    const orphan = await thread(hidden.id, 'Eurotrip')
    await store.appendEvent(orphan.id, { type: 'user_message', text: 'Book the ferry.', mentions: [] })
    await store.setChatArchived(orphan.id, true)
    const loose = await thread(hidden.id, 'Packing list')
    // Hidden twice: the thread last written in wins, the older one stays a loose chat.
    const twice = await store.createProject('Garden')
    const older = await thread(twice.id, 'Garden')
    const newer = await thread(twice.id, 'Garden')
    store.db.prepare("UPDATE records SET value = json_set(value, '$.lastMessageAt', json_extract(value, '$.lastMessageAt') + 1000) WHERE collection = 'chats' AND key = ?").run(newer.id)
    // A Session that happens to carry the project's name is no thread.
    const sessionOnly = await store.createProject('Taxes')
    const session = await thread(sessionOnly.id, 'Taxes')
    new SqliteRecords(store.db, 'workHandoffs').set('h1', { id: 'h1', projectId: sessionOnly.id, workChatId: session.id })
    // A project the user already added back keeps the thread it has now.
    const listed = await store.createProject('Studio')
    const former = await thread(listed.id, 'Studio')
    const current = await thread(listed.id, 'Studio')
    await store.setProjectThread(listed.id, current.id)
    store.db.exec('PRAGMA user_version = 14')
    store.close()
    const migrated = createSqliteStore({ filename })
    opened.push(migrated)
    expect((await migrated.getProject(hidden.id))?.threadChatId).toBe(orphan.id)
    expect((await migrated.getChat(orphan.id))?.archivedAt).not.toBeNull()
    expect((await migrated.loadEvents(orphan.id)).map((event) => event.type)).toEqual(['user_message'])
    expect((await migrated.getProject(twice.id))?.threadChatId).toBe(newer.id)
    expect((await migrated.getProject(sessionOnly.id))?.threadChatId).toBeUndefined()
    expect((await migrated.getProject(listed.id))?.threadChatId).toBe(current.id)
    const linked = (await migrated.listProjects()).map((project) => project.threadChatId)
    for (const untouched of [loose, older, session, former]) {
      expect(linked).not.toContain(untouched.id)
      expect(await migrated.getChat(untouched.id)).toMatchObject({ id: untouched.id, archivedAt: null })
    }
  })

  it('keeps a 32 MiB page cache for transcript reads', () => {
    const { store } = fixture()
    expect(store.db.prepare('PRAGMA cache_size').get()?.cache_size).toBe(-32768)
  })

  it('uses the chat and event id index for event replacement after a schema upgrade', () => {
    const { store, filename } = fixture()
    store.db.exec('DROP INDEX IF EXISTS events_chat_event_id; PRAGMA user_version = 4;')
    store.close()
    const reopened = createSqliteStore({ filename })
    opened.push(reopened)
    expect(reopened.db.prepare('PRAGMA user_version').get()?.user_version).toBe(SQLITE_SCHEMA_VERSION)
    const plan = reopened.db.prepare('EXPLAIN QUERY PLAN UPDATE events SET payload = ? WHERE chat_id = ? AND event_id = ?')
      .all('{}', 'chat', 'evt_1')
    expect(String(plan[0]?.detail)).toContain('events_chat_event_id (chat_id=? AND event_id=?)')
  })

  it('migrates each pair session to the row of the provider that minted it', async () => {
    const { store, filename } = fixture()
    const chat = (await store.listChats())[0]!
    const sessions = new SqliteRecords(store.db, 'sessions')
    sessions.clear()
    // The shape every row had before sessions were kept per provider.
    sessions.set(`${chat.id}::${sage.id}`, { sessionId: 'on-codex', driver: 'codex', seededThroughEventId: 'evt_000003' })
    sessions.set(`${chat.id}::smith`, { sessionId: 'nobody-vouches' })
    store.db.exec('PRAGMA user_version = 7')
    store.close()
    const migrated = createSqliteStore({ filename })
    opened.push(migrated)
    expect(migrated.db.prepare('PRAGMA user_version').get()?.user_version).toBe(SQLITE_SCHEMA_VERSION)
    expect(await migrated.getSessions(chat.id, sage.id))
      .toEqual([{ sessionId: 'on-codex', driver: 'codex', seededThroughEventId: 'evt_000003' }])
    // Unknown provenance is kept, and still matches no provider.
    expect(await migrated.getSessions(chat.id, 'smith')).toEqual([{ sessionId: 'nobody-vouches' }])
    // A second provider now sits beside the first instead of replacing it.
    await migrated.setSession(chat.id, sage.id, 'on-claude', { driver: 'claude' })
    expect((await migrated.getSessions(chat.id, sage.id)).map((held) => held.sessionId)).toEqual(['on-claude', 'on-codex'])
  })

  it('refolds usage runs from the transcript with provider and cache split', async () => {
    const { store, filename } = fixture()
    const chat = (await store.listChats())[0]!
    await store.appendEvent(chat.id, {
      type: 'turn_result', agentId: sage.id, turnId: 'tu', driver: 'codex', reportedModel: 'gpt-5.6-sol',
      usage: { inputTokens: 100, outputTokens: 5, breakdown: { freshInputTokens: 10, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0, cacheReadTokens: 90, apiPricedInputEquivalent: 19 } },
    })
    // The shape rows had before the split and provider were recorded.
    const runs = new SqliteRecords(store.db, 'usageRuns')
    runs.clear()
    runs.set('stale', { chatId: chat.id, agentId: sage.id, at: 0, toolCalls: 3, inputTokens: 1, outputTokens: 1, costUsd: null, reported: true })
    store.db.exec('PRAGMA user_version = 8')
    store.close()
    const migrated = createSqliteStore({ filename })
    opened.push(migrated)
    expect(migrated.db.prepare('PRAGMA user_version').get()?.user_version).toBe(SQLITE_SCHEMA_VERSION)
    expect(await migrated.usageRuns()).toMatchObject([
      { chatId: chat.id, agentId: sage.id, driver: 'codex', reportedModel: 'gpt-5.6-sol', inputTokens: 100, split: { uncached: 10, cached: 90, cacheWrite: 0 } },
    ])
  })

  it('keeps a delivered file openable after its scratch copy is gone and the server restarts', async () => {
    const { store, filename } = fixture()
    const chat = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'manor-scratch-'))
    directories.push(scratch)
    writeFileSync(path.join(scratch, 'report.pdf'), '%PDF-1.7 report')
    const { file, bytes } = await readDeliverable(path.join(scratch, 'report.pdf'))
    const event = await store.appendEvent(chat.id, { type: 'file_delivery', agentId: 'sage', turnId: 't1', file }, [{ id: file.id, bytes }])
    rmSync(scratch, { recursive: true, force: true })
    store.close()

    const reopened = createSqliteStore({ filename })
    opened.push(reopened)
    const media = createChatMedia({
      loadEvents: async (chatId) => reopened.loadEvents(chatId),
      loadDocument: async (chatId, id) => reopened.loadDocument(chatId, id),
    })
    const frame = media.forClient({ type: 'event', chatId: chat.id, event })
    const src = frame.type === 'event' && frame.event.type === 'file_delivery' ? frame.event.file.src : undefined
    const server = createServer((request, response) => { media.handle(request, response) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}${src}?download=1`)
      expect(response.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''report.pdf")
      expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('%PDF-1.7 report')
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('scrubs credential-shaped text before persisting an event', async () => {
    const { store } = fixture()
    const chat = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
    const token = `sk-${'A'.repeat(24)}`
    const saved = await store.appendEvent(chat.id, { type: 'user_message', text: `Use ${token}`, mentions: [] })
    expect(saved).toMatchObject({ text: 'Use [redacted]' })
    expect(await store.loadEvents(chat.id)).toContainEqual(expect.objectContaining({ text: 'Use [redacted]' }))

    if (saved.type !== 'user_message') throw new Error('expected the saved user message')
    await store.replaceEvent(chat.id, { ...saved, text: `Bearer ${'B'.repeat(24)}` })
    expect(await store.loadEvents(chat.id)).toContainEqual(expect.objectContaining({ text: 'Bearer [redacted]' }))
  })

  it('recovers accepted waiting input in order after restart, without replaying started work', async () => {
    const { store, filename } = fixture()
    const chat = (await store.listChats())[0]!
    const seen: TurnInput[] = []
    let accepted = 0
    const create = (current: Store) => new Orchestrator({
      store: current, agents: () => [sage], mcpServers: () => [],
      resolveDriver: () => recording(createMockDriver({ deltaDelayMs: 0 }), seen), ensureScratchDir: scratchFor,
      emit: (message) => { if (message.type === 'event' && message.event.type === 'user_message' && message.event.dispatchState === 'pending') accepted += 1 },
    })
    const original = create(store)
    // An occupied chat accepts input durably even though no queued callback runs.
    void original.runExclusive(chat.id, () => new Promise<void>(() => {}))
    const claim = await store.appendEvent(chat.id, { type: 'user_message', text: '@Sage already started', mentions: ['sage'], dispatchState: 'started' })
    void original.submitUserMessage(chat.id, '@Sage first waiting', [], undefined, [], [{ name: 'source.txt', mime: 'text/plain', content: 'keep exact' }])
    void original.submitUserMessage(chat.id, '@Sage second waiting')
    await until(() => accepted === 2, 'durable waiting inputs')
    // The previous answer's cursor is newer than the accepted waiting messages.
    await store.setSession(chat.id, sage.id, 'existing', { driver: sage.driver })
    await store.appendEvent(chat.id, { type: 'turn_result', turnId: 'earlier', agentId: sage.id })
    store.close()
    const reopened = createSqliteStore({ filename })
    opened.push(reopened)
    const recovered = create(reopened)
    await recovered.recoverWaitingMessages()
    await recovered.runExclusive(chat.id, async () => {})
    expect(seen).toHaveLength(2)
    expect(seen[0]?.catchUp).toContainEqual(expect.objectContaining({ text: '@Sage first waiting', files: [expect.objectContaining({ content: 'keep exact' })] }))
    expect(seen[0]?.catchUp.some((event) => event.type === 'user_message' && event.text === '@Sage second waiting')).toBe(false)
    expect(seen[1]?.catchUp).toContainEqual(expect.objectContaining({ text: '@Sage second waiting' }))
    expect(seen[1]?.catchUp[0]).toMatchObject({ type: 'user_message', text: '@Sage second waiting' })
    const events = await reopened.loadEvents(chat.id)
    expect(events.find((event) => event.id === claim.id)).toMatchObject({ dispatchState: 'uncertain' })
    expect(events.filter((event) => event.type === 'user_message').map((event) => event.dispatchState))
      .toEqual(['uncertain', 'completed', 'completed'])
    await recovered.recoverWaitingMessages()
    await recovered.runExclusive(chat.id, async () => {})
    expect(seen).toHaveLength(2)
  })
  it('preserves the Auto lock across restart, manual picks and removal of other pin fields', async () => {
    const { store, filename } = fixture()
    const chat = (await store.listChats())[0]!
    await store.setChatOverride(chat.id, sage.id, { auto: true })
    expect((await store.loadChatOverrides(chat.id))[sage.id]).toEqual({ auto: true })
    await store.setChatOverride(chat.id, sage.id, { auto: true, autoResolved: true, model: 'claude-sonnet-5', effort: 'low' })
    store.close()
    const reopened = createSqliteStore({ filename })
    opened.push(reopened)
    expect((await reopened.loadChatOverrides(chat.id))[sage.id]).toMatchObject({ auto: true, autoResolved: true })
    await reopened.setChatOverride(chat.id, sage.id, {})
    expect((await reopened.loadChatOverrides(chat.id))[sage.id]).toEqual({ autoResolved: true })
    await reopened.setChatOverride(chat.id, sage.id, { auto: true })
    expect((await reopened.loadChatOverrides(chat.id))[sage.id]).toEqual({ auto: true, autoResolved: true })
  })
  it('drops a DM pin whole when it is cleared, the Auto lock included', async () => {
    const { store } = fixture()
    const dm = await store.createChat({ kind: 'dm', memberIds: [sage.id], title: 'Sage' })
    await store.setChatOverride(dm.id, sage.id, { auto: true, autoResolved: true, model: 'claude-sonnet-5', effort: 'low' })
    await store.setChatOverride(dm.id, sage.id, {})
    expect(await store.loadChatOverrides(dm.id)).toEqual({})
  })
  it('migrates old chats to house mode without changing their transcript', async () => {
    const { store, filename } = fixture()
    const chat = (await store.listChats())[0]!
    await store.appendEvent(chat.id, { type: 'user_message', text: 'Keep this conversation.', mentions: [] })
    const before = await store.loadEvents(chat.id)
    store.db.exec("UPDATE records SET value = json_remove(value, '$.mode') WHERE collection = 'chats'; PRAGMA user_version = 2")
    store.close()
    const migrated = createSqliteStore({ filename })
    opened.push(migrated)
    expect(await migrated.getChat(chat.id)).toMatchObject({ mode: 'house' })
    expect(await migrated.loadEvents(chat.id)).toEqual(before)
  })
  it('migrates old projects to the narrow memory scope', async () => {
    const { store, filename } = fixture()
    const project = (await store.listProjects())[0]!
    store.db.exec("UPDATE records SET value = json_remove(value, '$.memoryScope') WHERE collection = 'projects'; PRAGMA user_version = 3")
    store.close()
    const migrated = createSqliteStore({ filename })
    opened.push(migrated)
    expect(await migrated.getProject(project.id)).toMatchObject({ name: project.name, memoryScope: 'project' })
  })
  it('stores Auto on a Single chat', async () => {
    const { store } = fixture()
    const project = (await store.listProjects())[0]!
    const chat = await store.createChat({ projectId: project.id, mode: 'single' })
    await store.setChatOverride(chat.id, '__single__', { auto: true })
    expect(await store.loadChatOverrides(chat.id)).toEqual({ __single__: { auto: true } })
  })
  it('persists a single session independently of the persona roster and removes its runtime on deletion', async () => {
    const { store, filename } = fixture()
    const project = (await store.listProjects())[0]!
    const chat = await store.createChat({ projectId: project.id, mode: 'single' })
    const pin = { driver: 'codex', model: 'gpt-5.6-sol', effort: 'medium' } as const
    await store.setChatOverride(chat.id, '__single__', pin)
    await store.setSession(chat.id, '__single__', 'provider-session', { driver: 'codex' })
    const namesake = await store.saveAgent({ ...sage, id: undefined, name: 'Single' })
    await store.deleteAgent(namesake.id)
    expect(await store.getSessions(chat.id, '__single__')).toMatchObject([{ sessionId: 'provider-session' }])
    await expect(store.setChatOverride(chat.id, sage.id, pin)).rejects.toThrow('no persona pins')
    await expect(store.createChat({ kind: 'dm', memberIds: [sage.id], mode: 'single' })).rejects.toThrow('project chats')
    store.close()
    const reopened = createSqliteStore({ filename })
    opened.push(reopened)
    expect(await reopened.getChat(chat.id)).toMatchObject({ mode: 'single' })
    expect(await reopened.loadChatOverrides(chat.id)).toEqual({ __single__: pin })
    expect((await reopened.listChats()).find((row) => row.id === chat.id)?.singleDriver).toBe('codex')
    expect((await reopened.listChats()).filter((row) => row.mode !== 'single').every((row) => row.singleDriver === undefined)).toBe(true)
    await reopened.setChatOverride(chat.id, '__single__', { driver: 'cursor', model: 'cursor-composer-2.5', effort: 'high' })
    expect((await reopened.listChats()).find((row) => row.id === chat.id)?.singleDriver).toBe('cursor')
    expect((await reopened.listChats()).find((row) => row.id === chat.id)?.singleOverride)
      .toEqual({ driver: 'cursor', model: 'cursor-composer-2.5', effort: 'high' })
    const refreshed = createSqliteStore({ filename })
    opened.push(refreshed)
    expect((await refreshed.listChats()).find((row) => row.id === chat.id)?.singleDriver).toBe('cursor')
    expect(await reopened.getSessions(chat.id, '__single__')).toMatchObject([{ sessionId: 'provider-session' }])
    await reopened.deleteChat(chat.id)
    expect(await reopened.loadChatOverrides(chat.id)).toEqual({})
    expect(await reopened.getSessions(chat.id, '__single__')).toEqual([])
  })
  it('keeps a selected quote and its source after reopening the database', async () => {
    const { store, filename } = fixture()
    const chat = (await store.listChats())[0]!
    const source = await store.appendEvent(chat.id, { type: 'user_message', text: 'First. Second.', mentions: [] })
    const quote = { eventId: source.id, text: 'Second.' }
    const reply = await store.appendEvent(chat.id, { type: 'user_message', text: 'Why?', mentions: [], quote })
    store.close()
    const reopened = createSqliteStore({ filename })
    opened.push(reopened)
    expect(await reopened.loadEvents(chat.id)).toEqual([source, reply])
    expect(reply).toMatchObject({ quote })
  })

  it('preserves the explicit first executor across reopen without changing legacy rows', async () => {
    const { store, filename } = fixture()
    const project = (await store.listProjects())[0]!
    const source = await store.createChat({ kind: 'dm', memberIds: [sage.id], title: 'Source' })
    const draft = { sourceChatId: source.id, sourceTurnId: 'turn_1', projectId: project.id,
      projectName: project.name, title: 'Work', leadAgentId: sage.id, leadAgentName: sage.name,
      supportingAgentIds: [], supportingAgentNames: [],
    }
    const assigned = await store.reserveWorkHandoff({ ...draft, assignmentKey: 'implementation', firstExecutor: { agentId: 'smith', agentName: 'Smith' } })
    const legacy = await store.reserveWorkHandoff({ ...draft, sourceTurnId: 'turn_2' })
    store.close()
    const reopened = createSqliteStore({ filename })
    opened.push(reopened)
    const rows = await reopened.listWorkHandoffs()
    expect(rows.find((row) => row.id === assigned.handoff.id)).toMatchObject({ assignmentKey: 'implementation' })
    expect(rows.find((row) => row.id === assigned.handoff.id)?.firstExecutor)
      .toEqual({ agentId: 'smith', agentName: 'Smith' })
    expect(rows.find((row) => row.id === legacy.handoff.id)).toMatchObject({ assignmentKey: 'default' })
    expect(rows.find((row) => row.id === legacy.handoff.id)?.firstExecutor).toBeUndefined()
  })

  it('does not recreate a deleted connector when its probe finishes late', async () => {
    const { store } = fixture()
    const probed = { tools: [], readOnlyTools: [], schemaChars: 0 }
    const server = await store.saveMcpServer({ name: 'Example', command: '/bin/true', args: [], envKeys: [], description: '', writes: false, effectPolicy: 'confirm_writes' }, probed)
    await store.deleteMcpServer(server.id)
    await expect(store.saveMcpServer(server, probed)).rejects.toThrow('unknown MCP server')
    expect(await store.listMcpServers()).toEqual([])
  })

  it('refuses a late provider session after its persona or chat was deleted', async () => {
    const { store } = fixture()
    const chat = (await store.listChats())[0]
    if (!chat) throw new Error('missing chat')
    await store.setSession(chat.id, sage.id, 'before-delete')
    await store.deleteAgent(sage.id)
    await expect(store.setSession(chat.id, sage.id, 'late-result')).rejects.toThrow('unknown agent')
    expect(await store.getSessions(chat.id, sage.id)).toEqual([])
    await store.deleteChat(chat.id)
    await expect(store.setSession(chat.id, sage.id, 'late-result')).rejects.toThrow('unknown chat')
  })

  it('survives reopen with transcript, pins, summaries, sessions and private skill bytes', async () => {
    const { store, filename } = fixture()
    const chat = (await store.listChats())[0]
    if (chat === undefined) throw new Error('missing seeded chat')
    const event = await store.appendEvent(chat.id, { type: 'user_message', text: 'Preserve me', mentions: [] })
    await store.setSession(chat.id, sage.id, 'provider-session', { driver: 'codex', seededThroughEventId: event.id })
    await store.setChatSummary(chat.id, 'A summary', event.id)
    await store.setChatOverride(chat.id, sage.id, { model: 'gpt-5.5' })
    await store.saveAgent({ ...sage, avatarTone: 0.9 })
    await store.saveSkill({ id: 'example', name: 'Example', description: '', instructions: '', sources: [] }, [
      { path: 'SKILL.md', bytes: new Uint8Array([1, 2, 3]), sha256: 'test-hash', mode: 0o644 },
    ])
    store.close()
    const reopened = createSqliteStore({ filename })
    opened.push(reopened)
    expect(await reopened.loadEvents(chat.id)).toEqual([event])
    expect(await reopened.getSessions(chat.id, sage.id)).toMatchObject([{ sessionId: 'provider-session', seededThroughEventId: event.id }])
    expect(await reopened.getChatSummary(chat.id)).toMatchObject({ summary: 'A summary' })
    expect(await reopened.loadChatOverrides(chat.id)).toEqual({ [sage.id]: { model: 'gpt-5.5' } })
    expect((await reopened.loadRoster())[0]?.avatarTone).toBe(0.9)
    expect((await reopened.loadSkillBundle('example'))[0]?.bytes).toEqual(new Uint8Array([1, 2, 3]))
    expect((await reopened.listChats())[0]?.lastMessagePreview).toBe('Preserve me')
  })

  it('keeps the last whole line as the preview when a stop cuts a reply off', async () => {
    const { store } = fixture()
    const chat = (await store.listChats())[0]!
    await store.appendEvent(chat.id, { type: 'user_message', text: 'Look into it', mentions: [] })
    await store.appendEvent(chat.id, { type: 'agent_message', agentId: sage.id, turnId: 't1', messageId: 'm1', text: 'Half a sent', interrupted: true })
    expect((await store.listChats())[0]?.lastMessagePreview).toBe('Look into it')
  })

  it('carries the latest tasks card as done/total on the chat, absent before one exists', async () => {
    const { store, filename } = fixture()
    const chat = (await store.listChats())[0]!
    expect((await store.listChats())[0]).not.toHaveProperty('planProgress')
    const todo = (todos: [string, 'pending' | 'in_progress' | 'completed'][]) => store.appendEvent(chat.id, {
      type: 'todo_update', agentId: sage.id, turnId: 't1', todos: todos.map(([text, status]) => ({ text, status })),
    })
    await todo([['Read', 'completed'], ['Build', 'in_progress'], ['Test', 'pending']])
    expect((await store.listChats())[0]?.planProgress).toEqual({ done: 1, total: 3 })
    await todo([['Read', 'completed'], ['Build', 'completed'], ['Test', 'in_progress'], ['Ship', 'pending']])
    expect((await store.listChats())[0]?.planProgress).toEqual({ done: 2, total: 4 })
    store.close()
    const reopened = createSqliteStore({ filename })
    opened.push(reopened)
    expect((await reopened.listChats())[0]?.planProgress).toEqual({ done: 2, total: 4 })
    // A card cleared to no lines draws nothing, so it leaves no count.
    await reopened.appendEvent(chat.id, { type: 'todo_update', agentId: sage.id, turnId: 't1', todos: [] })
    expect((await reopened.listChats())[0]).not.toHaveProperty('planProgress')
  })

  it('persists a Fast default and a Standard chat override across restart, and clears the default', async () => {
    const { store, filename } = fixture()
    const chat = (await store.listChats())[0]!
    await store.saveAgent({ ...sage, driver: 'codex', model: 'gpt-6.1-sol', speed: 'fast' })
    await store.setChatOverride(chat.id, sage.id, { speed: 'standard' })
    store.close()
    const reopened = createSqliteStore({ filename })
    opened.push(reopened)
    const fast = (await reopened.loadRoster())[0]!
    expect(fast.speed).toBe('fast')
    expect(await reopened.loadChatOverrides(chat.id)).toEqual({ [sage.id]: { speed: 'standard' } })
    await reopened.saveAgent({ ...fast, speed: undefined })
    expect((await reopened.loadRoster())[0]).not.toHaveProperty('speed')
  })

  it('serializes two connections and invalidates cached transcripts after an external write', async () => {
    const { store, filename } = fixture()
    const other = createSqliteStore({ filename })
    opened.push(other)
    const chat = (await store.listChats())[0]
    if (!chat) throw new Error('missing chat')
    await store.loadEvents(chat.id)
    const writes = await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? store : other).appendEvent(chat.id, {
      type: 'user_message', text: String(index), mentions: [],
    })))
    expect(new Set(writes.map((event) => event.id)).size).toBe(12)
    expect(await store.loadEvents(chat.id)).toHaveLength(12)
    expect(await other.loadEvents(chat.id)).toHaveLength(12)
  })

  it('keeps reads available while another connection holds the write lock', async () => {
    const { store, filename } = fixture()
    const other = createSqliteStore({ filename })
    opened.push(other)
    store.db.exec('PRAGMA busy_timeout = 50')
    other.db.exec('BEGIN IMMEDIATE')
    try {
      expect(await store.listProjects()).toHaveLength(1)
      expect(await store.listChats()).toHaveLength(1)
      await expect(store.createProject('Blocked')).rejects.toThrow(/locked/)
    } finally {
      other.db.exec('ROLLBACK')
    }
    expect(await store.listProjects()).toHaveLength(1)
  })

  it('retains assignment identities across restart and independent database connections', async () => {
    const { store, filename } = fixture()
    const source = (await store.listChats())[0]!
    const draft = {
      sourceChatId: source.id, sourceTurnId: 'turn_1', projectId: source.projectId!,
      projectName: 'Manor', title: 'First', leadAgentId: sage.id, leadAgentName: sage.name,
      supportingAgentIds: [], supportingAgentNames: [],
    }
    const first = await store.reserveWorkHandoff({ ...draft, assignmentKey: 'first' })
    const second = await store.reserveWorkHandoff({ ...draft, assignmentKey: 'second' })
    expect(first.handoff.id).not.toBe(second.handoff.id)
    store.close()
    const reopened = createSqliteStore({ filename })
    const other = createSqliteStore({ filename })
    opened.push(reopened, other)
    for (const connection of [reopened, other]) {
      expect(await connection.reserveWorkHandoff({ ...draft, assignmentKey: 'first', title: 'Retry' }))
        .toEqual({ handoff: first.handoff, created: false })
      expect(await connection.listWorkHandoffs()).toHaveLength(2)
    }
  })

  it('rolls back a compound write when its source receipt cannot be stored', async () => {
    const { store } = fixture()
    const chat = (await store.listChats())[0]
    if (!chat) throw new Error('missing chat')
    await store.loadEvents(chat.id)
    const rows = new SqliteRecords(store.db, 'workHandoffs')
    rows.set('broken', { id: 'broken', sourceChatId: chat.id, workChatId: null, version: 0 })
    store.db.exec("CREATE TRIGGER fail_metadata BEFORE INSERT ON records WHEN new.collection = 'transcriptMetadata' BEGIN SELECT RAISE(ABORT, 'write refused'); END")
    await expect(store.finalizeWorkHandoff('broken', chat.id, { type: 'system_note', kind: 'info', text: 'Started' })).rejects.toThrow('write refused')
    expect(rows.get('broken')).toMatchObject({ workChatId: null, version: 0 })
    expect(await store.loadEvents(chat.id)).toEqual([])
  })
})

function workModule(store: Store) {
  const start = vi.fn(async () => undefined)
  const submit = vi.fn(async (_chatId: string, _text: string) => undefined)
  const run = vi.fn(async (_chatId: string, _event: ThreadEvent) => undefined)
  return { start, submit, run, module: new WorkModule({
    store, agents: () => [sage], broadcast: () => undefined, broadcastDirectory: async () => undefined,
    orchestrator: { isActiveTurn: () => true, startStoredWorkHandoff: start,
      discard: () => undefined, stopChat: () => undefined, resumeChat: () => undefined, submitUserMessage: submit,
      runStoredUserMessage: run, runExclusive: <T>(_chatId: string, fn: () => Promise<T>) => fn() },
  }) }
}

async function pendingProposal(store: Store, title = 'Pending task') {
  const project = (await store.listProjects())[0]!
  const source = await store.createChat({ kind: 'dm', memberIds: ['sage'] })
  const runtime = workModule(store)
  await runtime.module.useTool({ chatId: source.id, agentId: 'sage', turnId: 'source-turn' }, {
    assignmentKey: title, project: project.id, title, task: `Brief for ${title}`, supportingPersonas: [],
  })
  return (await store.listWorkHandoffs()).find((row) => row.title === title)!
}

describe('durable Work proposals', () => {
  it('reopens a confirmed result on a new message, preserving its commit and manual Unsettle across restart', async () => {
    const { store, filename } = fixture()
    const proposal = await pendingProposal(store)
    const target = await workModule(store).module.accept(proposal.id)
    const reach = () => store.reachWorkGoal(proposal.id, { type: 'system_note', kind: 'info', text: 'Ready.',
      workGoalHandoffId: proposal.id, goalReport: { result: 'Fixed.' } })
    await reach()
    let current = (await store.workHandoffForTarget(target))!
    const completion = { status: 'complete', operation: 'commit', repos: [], completedAt: 1 } as const
    await store.confirmWorkGoal(proposal.id, current.version, { ...completion, repos: [] })
    const confirmed = (await store.workHandoffForTarget(target))!
    await store.transitionWorkLifecycle(target, proposal.id, { state: 'active', result: null, resultAt: null },
      { type: 'system_note', kind: 'info', text: 'Unsettled.' })
    store.db.exec("CREATE TRIGGER fail_reopen BEFORE UPDATE ON records WHEN new.collection = 'workHandoffs' BEGIN SELECT RAISE(ABORT, 'write refused'); END")
    await expect(store.appendEvent(target, { type: 'user_message', text: 'Follow up.', mentions: [] })).rejects.toThrow('write refused')
    store.db.exec('DROP TRIGGER fail_reopen')
    expect((await store.loadEvents(target)).some((event) => event.type === 'user_message' && event.text === 'Follow up.')).toBe(false)
    await store.appendEvent(target, { type: 'user_message', text: 'Follow up.', mentions: [], steersTurnId: 'commit' })
    current = (await store.workHandoffForTarget(target))!
    expect(current).toMatchObject({ state: 'active', version: confirmed.version + 1, unsettledAt: expect.any(Number),
      goalConfirmations: [{ confirmedAt: confirmed.goalConfirmedAt, version: confirmed.version, completion }] })
    expect(current.goalConfirmedAt).toBeUndefined()
    expect(current.goalReachedAt).toBeUndefined()
    expect(current.goalReport).toBeUndefined()
    expect(current.goalCompletion).toBeUndefined()
    await expect(store.confirmWorkGoal(proposal.id, confirmed.version)).rejects.toThrow('Nobody has marked')
    store.close()
    const restarted = createSqliteStore({ filename })
    opened.push(restarted)
    expect(await restarted.workHandoffForTarget(target)).toEqual(current)
    await restarted.reachWorkGoal(proposal.id, { type: 'system_note', kind: 'info', text: 'Ready again.',
      workGoalHandoffId: proposal.id, goalReport: { result: 'Follow up fixed.' } })
    const ready = (await restarted.workHandoffForTarget(target))!
    await restarted.confirmWorkGoal(proposal.id, ready.version, { ...completion, repos: [] })
    expect((await restarted.workHandoffForTarget(target))?.unsettledAt).toBeUndefined()
    expect((await restarted.workHandoffForTarget(target))?.goalConfirmations).toEqual(current.goalConfirmations)
  })

  it('repairs legacy stale confirmations at startup, excluding the commit request and manual Settle', async () => {
    const { store, filename } = fixture()
    const rows = new SqliteRecords<Awaited<ReturnType<Store['listWorkHandoffs']>>[number]>(store.db, 'workHandoffs')
    const targets: string[] = []
    for (const title of ['stale', 'commit only', 'manually settled', 'legacy commit only']) {
      const proposal = await pendingProposal(store, title)
      const target = await workModule(store).module.accept(proposal.id)
      targets.push(target)
      await store.reachWorkGoal(proposal.id, { type: 'system_note', kind: 'info', text: 'Ready.',
        workGoalHandoffId: proposal.id, goalReport: { result: 'Fixed.' } })
      const ready = (await store.workHandoffForTarget(target))!
      await store.confirmWorkGoal(proposal.id, ready.version, { status: 'pending', operation: 'commit', repos: [] }, 'Commit it.')
      const confirmed = (await store.workHandoffForTarget(target))!
      await store.updateWorkCompletion(proposal.id, { ...confirmed.goalCompletion!, status: 'complete', completedAt: 1 })
      const landed = (await store.workHandoffForTarget(target))!
      if (title === 'legacy commit only') {
        const request = (await store.loadEvents(target)).find((event) => event.id === landed.goalCompletion?.requestEventId)!
        if (request.type !== 'user_message') throw new Error('Missing legacy commit request')
        // Before `instruction`, the request's wording sat in `text`.
        const { instruction: _instruction, ...bare } = request
        await store.replaceEvent(target, { ...bare, text: "[Manor] The user confirmed the ready result, and that is their approval to commit. @Sage, commit this Session's changes now." })
        const { goalReport: _report, goalCompletion: _completion, ...legacy } = landed
        rows.set(proposal.id, legacy)
        continue
      }
      if (title === 'commit only') continue
      if (title === 'manually settled') await store.setChatSettled(target, true)
      await store.appendEvent(target, { type: 'user_message', text: 'New work.', mentions: [] })
      // Reproduce the old server keeping confirmation on a handoff despite the later user message.
      rows.set(proposal.id, landed)
    }
    store.close()
    const restarted = createSqliteStore({ filename })
    opened.push(restarted)
    const stale = (await restarted.workHandoffForTarget(targets[0]!))!
    expect(stale.goalConfirmedAt).toBeUndefined()
    expect(stale.goalConfirmations?.[0]?.completion?.status).toBe('complete')
    expect((await restarted.workHandoffForTarget(targets[1]!))?.goalConfirmedAt).toEqual(expect.any(Number))
    expect((await restarted.workHandoffForTarget(targets[2]!))?.goalConfirmedAt).toEqual(expect.any(Number))
    expect((await restarted.workHandoffForTarget(targets[3]!))?.goalConfirmedAt).toEqual(expect.any(Number))
  })

  it('atomically accepts and queues one commit request, preserving it through restart', async () => {
    const { store, filename } = fixture()
    const proposal = await pendingProposal(store)
    const target = await workModule(store).module.accept(proposal.id)
    await store.reachWorkGoal(proposal.id, { type: 'system_note', kind: 'info', text: 'Ready.',
      workGoalHandoffId: proposal.id, goalReport: { result: 'The document is ready.' } })
    const reached = (await store.workHandoffForTarget(target))!
    const completion = { status: 'pending', operation: 'commit', repos: [] } as const
    store.db.exec("CREATE TRIGGER fail_completion BEFORE UPDATE ON records WHEN new.collection = 'workHandoffs' BEGIN SELECT RAISE(ABORT, 'write refused'); END")
    await expect(store.confirmWorkGoal(proposal.id, reached.version, { ...completion, repos: [] }, '@Sage commit')).rejects.toThrow('write refused')
    expect((await store.loadEvents(target)).some((event) => event.type === 'user_message' && event.dispatchState === 'pending')).toBe(false)
    expect((await store.workHandoffForTarget(target))?.goalConfirmedAt).toBeUndefined()
    store.db.exec('DROP TRIGGER fail_completion')
    expect(await store.confirmWorkGoal(proposal.id, reached.version, { ...completion, repos: [] }, '@Sage commit')).toBe(true)
    expect(await store.confirmWorkGoal(proposal.id, reached.version, { ...completion, repos: [] }, '@Sage commit')).toBe(false)
    const saved = (await store.workHandoffForTarget(target))!
    store.close()
    const restarted = createSqliteStore({ filename })
    opened.push(restarted)
    const pending = (await restarted.loadEvents(target)).filter((event) => event.type === 'user_message' && event.dispatchState === 'pending')
    expect(pending).toHaveLength(1)
    expect(pending[0]?.id).toBe(saved.goalCompletion?.requestEventId)
    const runtime = workModule(restarted)
    await runtime.module.reconcileCompletion()
    expect(runtime.submit).not.toHaveBeenCalled()
    expect((await restarted.workHandoffForTarget(target))?.goalCompletion?.status).toBe('pending')
  })

  it('keeps an unsettled confirmed Session out of Settled until it is settled again', async () => {
    const { store } = fixture()
    const proposal = await pendingProposal(store)
    const target = await workModule(store).module.accept(proposal.id)
    await store.reachWorkGoal(proposal.id, { type: 'system_note', kind: 'info', text: 'Ready.',
      workGoalHandoffId: proposal.id, goalReport: { result: 'The document is ready.' } })
    const reached = (await store.workHandoffForTarget(target))!
    await store.confirmWorkGoal(proposal.id, reached.version, { status: 'complete', operation: 'commit', repos: [] }, '@Sage commit')
    const reopen = { state: 'active', result: null, resultAt: null } as const
    const note = { type: 'system_note', kind: 'info', text: 'reopened', workHandoffId: proposal.id, workHandoffPhase: 'reopened' } as const

    await store.transitionWorkLifecycle(target, proposal.id, reopen, note)
    const out = (await store.workHandoffForTarget(target))!
    expect(out.unsettledAt).toEqual(expect.any(Number))
    expect(out.goalConfirmedAt).toEqual(expect.any(Number))

    await store.transitionWorkLifecycle(target, proposal.id, { state: 'settled', result: null, resultAt: 1 }, { ...note, workHandoffPhase: 'settled' })
    expect((await store.workHandoffForTarget(target))?.unsettledAt).toBeUndefined()
    await store.transitionWorkLifecycle(target, proposal.id, reopen, note)
    expect((await store.workHandoffForTarget(target))?.unsettledAt).toEqual(expect.any(Number))
  })

  it('publishes a compact result atomically and keeps feedback in the same Session across restart', async () => {
    const { store, filename } = fixture()
    const runtime = workModule(store)
    const proposal = await pendingProposal(store)
    const target = await runtime.module.accept(proposal.id)
    const goalReport = { result: 'Export is available in the chat menu.', limitations: 'Attachments remain links.' }
    const note = { type: 'system_note', kind: 'info', text: 'Ready.', workGoalHandoffId: proposal.id,
      goalReport, goalClaims: [{ claim: 'Export verified.', level: 'ran', ref: 'export.test.ts' }],
    } as const
    await store.reachWorkGoal(proposal.id, { ...note, goalClaims: [...note.goalClaims] })
    const reached = (await store.listWorkHandoffs())[0]!
    expect(reached).toMatchObject({ goalReport, version: proposal.version + 1 })
    const receipt = (await store.loadEvents(proposal.sourceChatId)).at(-1)!
    expect(receipt).toMatchObject({ type: 'system_note', workHandoffId: proposal.id,
      text: 'Export is available in the chat menu.\nAttachments remain links.', workHandoffVersion: reached.version })
    expect(receipt).not.toHaveProperty('goalClaims')
    await expect(runtime.module.confirmGoal(proposal.id, undefined, proposal.version)).rejects.toThrow('result has changed')
    await expect(runtime.module.confirmGoal(proposal.id)).rejects.toThrow('result has changed')

    store.db.exec("CREATE TRIGGER fail_feedback BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'write refused'); END")
    await expect(store.reviseWorkGoal(proposal.id, reached.version, 'Use the chat title.')).rejects.toThrow('write refused')
    store.db.exec('DROP TRIGGER fail_feedback')
    expect((await store.listWorkHandoffs())[0]).toEqual(reached)

    const revised = await store.reviseWorkGoal(proposal.id, reached.version, 'Use the chat title.')
    expect(revised.handoff).toMatchObject({ workChatId: target, version: reached.version + 1, state: 'active' })
    expect(revised.handoff.goalReachedAt).toBeUndefined()
    expect(revised.handoff.goalReport).toBeUndefined()
    expect(revised.event).toMatchObject({ type: 'user_message', text: '@Sage Use the chat title.', dispatchState: 'pending' })
    await expect(store.reviseWorkGoal(proposal.id, reached.version, 'Use the chat title.')).rejects.toThrow('result has changed')
    await expect(store.confirmWorkGoal(proposal.id, reached.version)).rejects.toThrow('Nobody has marked')
    store.close()

    const restarted = createSqliteStore({ filename })
    opened.push(restarted)
    expect((await restarted.loadEvents(target)).at(-1)).toEqual(revised.event)
    expect(await restarted.listWorkHandoffs()).toHaveLength(1)
    await restarted.reachWorkGoal(proposal.id, { ...note, goalClaims: [...note.goalClaims] })
    const latest = (await restarted.listWorkHandoffs())[0]!
    await expect(restarted.confirmWorkGoal(proposal.id, reached.version)).rejects.toThrow('result has changed')
    expect(await restarted.confirmWorkGoal(proposal.id, latest.version)).toBe(true)
    expect(await restarted.confirmWorkGoal(proposal.id, latest.version)).toBe(false)
    await expect(restarted.reviseWorkGoal(proposal.id, latest.version, 'One more.')).rejects.toThrow('already been confirmed')
  })

  it('keeps the choices a report leaves to the user across a restart, and a report without them unchanged', async () => {
    const { store, filename } = fixture()
    const proposal = await pendingProposal(store)
    await workModule(store).module.accept(proposal.id)
    const choices = [{ title: 'Open large', question: 'Wide pages are cramped in the chat. Where should they open large?', options: ["Manor's Browser", 'a zoom view like T3'], recommended: 'zoom' }]
    await store.reachWorkGoal(proposal.id, { type: 'system_note', kind: 'info', text: 'Ready.',
      workGoalHandoffId: proposal.id, goalReport: { result: 'Native-looking HTML works in the chat.', choices } })
    store.close()
    const restarted = createSqliteStore({ filename })
    opened.push(restarted)
    expect((await restarted.listWorkHandoffs())[0]?.goalReport).toEqual({ result: 'Native-looking HTML works in the chat.', choices })
    expect(GoalReportSchema.parse({ result: 'Done.' })).toEqual({ result: 'Done.' })
    expect(GoalReportSchema.safeParse({ result: 'Done.', choices: [{ title: 'Pick', options: ['only one'] }] }).success).toBe(false)
  })

  it('sends Request changes with its pictures only to the Session and leaves no feedback message in the source DM', async () => {
    const { store } = fixture()
    const proposal = await pendingProposal(store)
    const target = await workModule(store).module.accept(proposal.id)
    await store.reachWorkGoal(proposal.id, { type: 'system_note', kind: 'info', text: 'Ready.',
      workGoalHandoffId: proposal.id, goalReport: { result: 'The pipeline is green.' } })
    const reached = (await store.workHandoffForTarget(target))!
    const before = (await store.loadEvents(proposal.sourceChatId)).length
    const broadcast = vi.fn()
    const run = vi.fn(async () => undefined)
    const module = new WorkModule({
      store, agents: () => [sage], broadcast, broadcastDirectory: async () => undefined,
      orchestrator: { isActiveTurn: () => true, startStoredWorkHandoff: async () => undefined,
        discard: () => undefined, stopChat: () => undefined, resumeChat: () => undefined,
        submitUserMessage: async () => undefined, runStoredUserMessage: run, runExclusive: <T>(_chatId: string, fn: () => Promise<T>) => fn() },
    })

    const screenshot = { name: 'pasted-image.jpg', dataUrl: 'data:image/jpeg;base64,/9j/4AAQ' }
    await module.reviseGoal(proposal.id, reached.version, 'Commit changes', [screenshot])

    const added = (await store.loadEvents(proposal.sourceChatId)).slice(before)
    expect(added).toEqual([expect.objectContaining({ type: 'system_note', workHandoffId: proposal.id, workHandoffPhase: 'reopened' })])
    expect(broadcast.mock.calls.map(([message]) => message.event)).toEqual(added)
    const feedback = (await store.loadEvents(target)).at(-1)
    expect(feedback).toMatchObject({ type: 'user_message', text: '@Sage Commit changes', mentions: ['sage'], dispatchState: 'pending', images: [screenshot] })
    expect(run.mock.calls).toEqual([[target, feedback]])
    const reopened = (await store.workHandoffForTarget(target))!
    expect(reopened).toMatchObject({ state: 'active', version: reached.version + 1 })
    expect(reopened.goalReachedAt).toBeUndefined()
  })

  it('starts feedback of more than one line below the mention so its first block keeps its form', async () => {
    const { store } = fixture()
    const proposal = await pendingProposal(store)
    const target = await workModule(store).module.accept(proposal.id)
    await store.reachWorkGoal(proposal.id, { type: 'system_note', kind: 'info', text: 'Ready.',
      workGoalHandoffId: proposal.id, goalReport: { result: 'Done.' } })
    const reached = (await store.workHandoffForTarget(target))!

    const table = '| A | B |\n| --- | --- |\n| a | b |'
    const revised = await store.reviseWorkGoal(proposal.id, reached.version, table)

    expect(revised.event.text).toBe(`@Sage\n\n${table}`)
  })

  it('starts a one-line list below the mention and keeps one line of prose beside it', async () => {
    const { store } = fixture()
    const proposal = await pendingProposal(store)
    const target = await workModule(store).module.accept(proposal.id)
    const reach = async () => {
      await store.reachWorkGoal(proposal.id, { type: 'system_note', kind: 'info', text: 'Ready.',
        workGoalHandoffId: proposal.id, goalReport: { result: 'Done.' } })
      return (await store.workHandoffForTarget(target))!.version
    }

    const sent = []
    for (const feedback of ['- Rename the button', '1. Rename the button', 'Rename the button']) {
      sent.push((await store.reviseWorkGoal(proposal.id, await reach(), feedback)).event.text)
    }

    expect(sent).toEqual(['@Sage\n\n- Rename the button', '@Sage\n\n1. Rename the button', '@Sage Rename the button'])
  })

  it('confirms a reached goal once, apart from Settle, and keeps both stamps across restart', async () => {
    const { store, filename } = fixture()
    const runtime = workModule(store)
    const proposal = await pendingProposal(store)
    const target = await runtime.module.accept(proposal.id)

    await expect(runtime.module.confirmGoal(proposal.id)).rejects.toThrow('Nobody has marked this goal reached yet.')
    await store.reachWorkGoal(proposal.id, { type: 'system_note', kind: 'info', text: 'Sage marked the goal reached.', workGoalHandoffId: proposal.id })
    const [reached] = await store.listWorkHandoffs()
    await runtime.module.confirmGoal(proposal.id)
    const [first] = await store.listWorkHandoffs()
    // A second click a minute later keeps the first time.
    const later = vi.spyOn(Date, 'now').mockReturnValue((first?.goalConfirmedAt ?? 0) + 60_000)
    await runtime.module.confirmGoal(proposal.id)
    later.mockRestore()
    expect((await store.listWorkHandoffs())[0]?.goalConfirmedAt).toBe(first?.goalConfirmedAt)
    expect(first).toMatchObject({ state: 'active', goalReachedAt: reached?.goalReachedAt, goalConfirmedAt: expect.any(Number) })
    expect((await store.getChat(target))?.settledAt).toBeNull()
    store.close()

    const restarted = createSqliteStore({ filename })
    opened.push(restarted)
    expect((await restarted.listWorkHandoffs())[0]).toMatchObject({
      goalReachedAt: reached?.goalReachedAt, goalConfirmedAt: first?.goalConfirmedAt,
    })
    // This Session changed no files, so confirming asked nobody to commit.
    expect(runtime.submit).not.toHaveBeenCalled()
  })

  it('asks the lead to commit once when the user confirms a goal whose Session changed files', async () => {
    const { store } = fixture()
    const runtime = workModule(store)
    const proposal = await pendingProposal(store)
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-legacy-confirm-'))
    directories.push(root)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
    git('init', '--quiet', '-b', 'main')
    git('-c', 'user.name=Manor', '-c', 'user.email=manor@local', 'commit', '--quiet', '--allow-empty', '-m', 'init')
    writeFileSync(path.join(root, 'a.ts'), 'changed\n')
    await store.updateProject(proposal.projectId, 'Manor', [root])
    const target = await runtime.module.accept(proposal.id)
    await store.appendEvent(target, {
      type: 'turn_result', agentId: 'sage', turnId: 't1',
      fileChanges: [{ path: path.join(root, 'a.ts'), status: 'edited', added: 1, removed: 0, edits: [] }],
    })
    await store.reachWorkGoal(proposal.id, { type: 'system_note', kind: 'info', text: 'Sage marked the goal reached.', workGoalHandoffId: proposal.id })

    // A refused transcript read stores nothing, so the next click still asks.
    const refused = vi.spyOn(store, 'loadEvents').mockRejectedValueOnce(new Error('read refused'))
    await expect(runtime.module.confirmGoal(proposal.id)).rejects.toThrow('read refused')
    refused.mockRestore()
    expect((await store.listWorkHandoffs())[0]?.goalConfirmedAt).toBeUndefined()
    expect(runtime.submit).not.toHaveBeenCalled()

    await Promise.all([runtime.module.confirmGoal(proposal.id), runtime.module.confirmGoal(proposal.id)])

    expect(runtime.run).toHaveBeenCalledTimes(1)
    expect(runtime.run.mock.calls[0]?.[0]).toBe(target)
    const request = runtime.run.mock.calls[0]?.[1]
    expect(request?.type === 'user_message' && request.instruction).toContain('@Sage, commit this Session')
    expect(request?.type === 'user_message' && request.instruction).toContain('do not push')
    expect((await store.workHandoffForTarget(target))?.goalConfirmedAt).toEqual(expect.any(Number))
    expect((await store.workHandoffForTarget(target))?.goalCompletion?.requestEventId).toBe(request?.id)
  })

  it('in a worktree Session, approves the merge only into the branch the button showed', async () => {
    const { store } = fixture()
    const runtime = workModule(store)
    const source = mkdtempSync(path.join(os.tmpdir(), 'manor-goal-source-'))
    directories.push(source)
    const git = (...args: string[]) => execFileSync('git', args, { cwd: source, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
    const tree = `${source}-tree`
    directories.push(tree)
    git('init', '--quiet', '-b', 'main')
    git('-c', 'user.name=Manor', '-c', 'user.email=manor@local', 'commit', '--quiet', '--allow-empty', '-m', 'init')
    git('worktree', 'add', '--quiet', '-b', 'manor/goal', tree)
    await store.updateProject((await store.listProjects())[0]!.id, 'Manor', [source])
    const reachedInWorktree = async (title: string, createdAt = Date.now()) => {
      writeFileSync(path.join(tree, 'a.ts'), `${title}\n`)
      const proposal = await pendingProposal(store, title)
      const target = await runtime.module.accept(proposal.id)
      await store.replaceChatWorktrees(target, [{ sourcePath: source, worktreePath: tree, branch: 'manor/goal', createdAt }])
      await store.appendEvent(target, {
        type: 'turn_result', agentId: 'sage', turnId: 't1',
        fileChanges: [{ path: path.join(tree, 'a.ts'), status: 'edited', added: 1, removed: 0, edits: [] }],
      })
      await store.reachWorkGoal(proposal.id, { type: 'system_note', kind: 'info', text: 'Sage marked the goal reached.', workGoalHandoffId: proposal.id })
      return proposal.id
    }
    const confirmedAt = async (id: string) => (await store.listWorkHandoffs()).find((row) => row.id === id)?.goalConfirmedAt
    /** Confirm's request as stored, once Manor's own commit of it landed. */
    const requestOf = async (id: string) => {
      const completion = async () => (await store.listWorkHandoffs()).find((row) => row.id === id)?.goalCompletion
      await vi.waitFor(async () => expect((await completion())?.status).toBe('complete'), { timeout: 10_000 })
      const target = (await store.listWorkHandoffs()).find((row) => row.id === id)!.workChatId!
      const requestEventId = (await completion())?.requestEventId
      const event = (await store.loadEvents(target)).find((row) => row.id === requestEventId)
      return event?.type === 'user_message' ? event : undefined
    }

    const merged = await reachedInWorktree('Merged')
    // The linked folder left main after the button showed it: a blocked merge stores nothing.
    git('switch', '--quiet', '-c', 'elsewhere')
    await expect(runtime.module.confirmGoal(merged, 'main')).rejects.toThrow('is on elsewhere now, not main')
    expect(await confirmedAt(merged)).toBeUndefined()
    expect(runtime.submit).not.toHaveBeenCalled()
    git('switch', '--quiet', 'main')

    await Promise.all([runtime.module.confirmGoal(merged, 'main'), runtime.module.confirmGoal(merged, 'main')])
    // Manor commits and merges itself: the request stays in the transcript and no turn answers it.
    const first = await requestOf(merged)
    expect(first?.confirmRequest?.manor).toBe(true)
    expect(first?.instruction).toContain('approval to commit and to merge into main. Manor commits')
    expect(first?.instruction).toContain('nothing is asked of you')
    expect(first?.instruction).toContain(`- worktree ${tree} on branch manor/goal, linked folder ${source}`)
    expect(first?.text).toBe('')
    expect(execFileSync('git', ['show', 'main:a.ts'], { cwd: source, encoding: 'utf8' })).toBe('Merged\n')

    // A client that showed no branch approved the commit alone.
    const unmerged = await reachedInWorktree('Unmerged')
    await runtime.module.confirmGoal(unmerged)
    const second = await requestOf(unmerged)
    expect(second?.instruction).toContain('approval to commit, not to merge. Manor commits')
    expect(second?.instruction).toContain('leaves them unmerged')
    // Committed on the branch alone: main still holds the first Session's change.
    expect(execFileSync('git', ['show', 'manor/goal:a.ts'], { cwd: source, encoding: 'utf8' })).toBe('Unmerged\n')
    expect(execFileSync('git', ['show', 'main:a.ts'], { cwd: source, encoding: 'utf8' })).toBe('Merged\n')
    expect(runtime.run).not.toHaveBeenCalled()

    // Older work already on the branch was never part of this approval, so the merge is withheld and named.
    execFileSync('git', ['-c', 'user.name=Manor', '-c', 'user.email=manor@local', 'commit', '--quiet', '--allow-empty', '-m', 'Older unreviewed work'], { cwd: tree, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } })
    // This Session's worktree mapping is newer than both commits, so neither is its own.
    const withHistory = await reachedInWorktree('History', Date.now() + 1000)
    await runtime.module.confirmGoal(withHistory, 'main')
    // The lead commits that one itself, so it can say which commits blocked the merge.
    expect(runtime.run).toHaveBeenCalledTimes(1)
    const third = runtime.run.mock.calls[0]?.[1]
    const withheld = third?.type === 'user_message' ? third.instruction ?? '' : ''
    expect(withheld).toContain('The merge into main is withheld')
    expect(withheld).toMatch(/- manor\/goal: [0-9a-f]+ Older unreviewed work/)
    expect(withheld).toContain('leave them unmerged, do not push, and tell the user which commits blocked the merge')
    expect(withheld).not.toContain('git merge --ff-only')
    expect(await confirmedAt(withHistory)).toEqual(expect.any(Number))
  }, 30_000)

  // 2026-11-07: a reopened Session's own first round, committed on its branch, failed
  // Confirm as "earlier, unreviewed commits". Only commits the Session did not make count.
  it('merges a goal Session over its own earlier commit, and hands commits it did not make to the lead', async () => {
    const { store } = fixture()
    const runtime = workModule(store)
    const source = mkdtempSync(path.join(os.tmpdir(), 'manor-own-commits-'))
    directories.push(source)
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Manor', '-c', 'user.email=manor@local', ...args], {
      cwd, stdio: 'pipe', encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', ...dated },
    })
    // Backdates a commit and its reflog entry, as if it was made before the Session.
    let dated: { GIT_COMMITTER_DATE?: string } = {}
    git(source, 'init', '--quiet', '-b', 'main')
    git(source, 'commit', '--quiet', '--allow-empty', '-m', 'init')
    await store.updateProject((await store.listProjects())[0]!.id, 'Manor', [source])
    /** A goal Session in its own worktree whose branch holds one earlier commit, made by the Session or before it. */
    const reached = async (title: string, earlier: 'own' | 'foreign') => {
      const branch = `manor/${earlier}`
      const tree = `${source}-${earlier}`
      directories.push(tree)
      git(source, 'worktree', 'add', '--quiet', '-b', branch, tree)
      const commitEarlier = () => {
        writeFileSync(path.join(tree, `${earlier}-first.md`), 'first\n')
        git(tree, 'add', '.')
        git(tree, 'commit', '--quiet', '-m', `${title} first round`)
      }
      if (earlier === 'foreign') {
        dated = { GIT_COMMITTER_DATE: `@${Math.floor(Date.now() / 1000) - 60} +0000` }
        commitEarlier()
        dated = {}
      }
      const proposal = await pendingProposal(store, title)
      const target = await runtime.module.accept(proposal.id)
      // Reflog times are whole seconds; keep the mapping clear of the current second.
      await store.replaceChatWorktrees(target, [{ sourcePath: source, worktreePath: tree, branch, createdAt: Date.now() - 5000 }])
      if (earlier === 'own') commitEarlier()
      // main moves and the Session rebases onto it: a rewrite keeps each commit's owner.
      writeFileSync(path.join(source, `main-${earlier}.md`), 'main\n')
      git(source, 'add', '.')
      git(source, 'commit', '--quiet', '-m', `Main beside ${title}`)
      git(tree, 'rebase', '--quiet', 'main')
      writeFileSync(path.join(tree, `${earlier}.md`), `${title}\n`)
      await store.appendEvent(target, {
        type: 'turn_result', agentId: 'sage', turnId: 't1',
        fileChanges: [{ path: path.join(tree, `${earlier}.md`), status: 'created', added: 1, removed: 0, edits: [] }],
      })
      await store.reachWorkGoal(proposal.id, { type: 'system_note', kind: 'info', text: 'Ready.',
        workGoalHandoffId: proposal.id, goalReport: { result: 'The result is in.' } })
      return (await store.workHandoffForTarget(target))!
    }

    // (a) The earlier round is the Session's own: Manor commits and merges both, no turn needed.
    const own = await reached('Own round', 'own')
    await runtime.module.confirmGoal(own.id, 'main', own.version)
    await vi.waitFor(async () => expect((await store.workHandoffForTarget(own.workChatId!))?.goalCompletion?.status).toBe('complete'), { timeout: 10_000 })
    expect(git(source, 'show', 'main:own-first.md')).toBe('first\n')
    expect(git(source, 'show', 'main:own.md')).toBe('Own round\n')
    expect(runtime.run).not.toHaveBeenCalled()

    // (b) The branch carried a commit before the Session: Confirm still succeeds, the merge
    // is withheld and the lead gets one turn to commit and name the blocking commit.
    const foreign = await reached('Foreign round', 'foreign')
    await runtime.module.confirmGoal(foreign.id, 'main', foreign.version)
    expect(runtime.run).toHaveBeenCalledTimes(1)
    const request = runtime.run.mock.calls[0]?.[1]
    expect(request?.type === 'user_message' && request.confirmRequest?.variant).toBe('merge_withheld')
    expect(request?.type === 'user_message' && request.instruction).toMatch(/- manor\/foreign: [0-9a-f]+ Foreign round first round/)
    expect(request?.type === 'user_message' && request.instruction).not.toContain('Own round')
    expect((await store.workHandoffForTarget(foreign.workChatId!))?.goalConfirmedAt).toEqual(expect.any(Number))
    expect(() => git(source, 'show', 'main:foreign-first.md')).toThrow()
  }, 30_000)

  it('in the shared checkout, confirms a goal Session over its own earlier commit by asking the lead to commit', async () => {
    const { store } = fixture()
    const runtime = workModule(store)
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-checkout-own-'))
    directories.push(root)
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Manor', '-c', 'user.email=manor@local', ...args], {
      cwd: root, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
    })
    git('init', '--quiet', '-b', 'main')
    git('commit', '--quiet', '--allow-empty', '-m', 'init')
    const proposal = await pendingProposal(store)
    await store.updateProject(proposal.projectId, 'Manor', [root])
    const target = await runtime.module.accept(proposal.id)
    // The first round already landed on main; the follow-up changed one more file.
    writeFileSync(path.join(root, 'first.md'), 'first\n')
    git('add', 'first.md')
    git('commit', '--quiet', '-m', 'First round')
    writeFileSync(path.join(root, 'second.md'), 'second\n')
    await store.appendEvent(target, {
      type: 'turn_result', agentId: 'sage', turnId: 't1',
      fileChanges: [{ path: path.join(root, 'second.md'), status: 'created', added: 1, removed: 0, edits: [] }],
    })
    await store.reachWorkGoal(proposal.id, { type: 'system_note', kind: 'info', text: 'Ready.',
      workGoalHandoffId: proposal.id, goalReport: { result: 'The follow-up is in.' } })
    const reached = (await store.workHandoffForTarget(target))!
    await runtime.module.confirmGoal(proposal.id, undefined, reached.version)
    expect(runtime.run).toHaveBeenCalledTimes(1)
    const request = runtime.run.mock.calls[0]?.[1]
    expect(request?.type === 'user_message' && request.confirmRequest?.variant).toBe('checkout')
    expect(request?.type === 'user_message' && request.instruction).toContain('@Sage, commit this Session')
  })

  // 2026-10-07: a Session settled after its changes were already committed showed "closed
  // before commit or merge completion was verified". Closing proves nothing; Git decides.
  it('settles a confirmed Session as committed when its changes are on the branch, and warns only when Git shows them missing', async () => {
    const { store } = fixture()
    const settle = async (title: string, land: boolean) => {
      const repo = mkdtempSync(path.join(os.tmpdir(), 'manor-settle-'))
      directories.push(repo)
      const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Manor', '-c', 'user.email=manor@local', ...args], {
        cwd: repo, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
      })
      git('init', '--quiet', '-b', 'main')
      git('commit', '--quiet', '--allow-empty', '-m', 'init')
      writeFileSync(path.join(repo, 'result.txt'), 'approved\n')
      const runtime = workModule(store)
      const proposal = await pendingProposal(store, title)
      const target = await runtime.module.accept(proposal.id)
      await store.reachWorkGoal(proposal.id, { type: 'system_note', kind: 'info', text: 'Ready.',
        workGoalHandoffId: proposal.id, goalReport: { result: 'The result is in.' } })
      const reached = (await store.workHandoffForTarget(target))!
      const completion = await prepareWorkCompletion([repo], [path.join(repo, 'result.txt')], [])
      expect(await store.confirmWorkGoal(proposal.id, reached.version, completion, '@Sage commit')).toBe(true)
      if (land) {
        git('add', 'result.txt')
        git('commit', '--quiet', '-m', 'Session result')
      }
      await runtime.module.setSettled(target, true)
      return (await store.workHandoffForTarget(target))?.goalCompletion
    }
    expect(await settle('Landed', true)).toMatchObject({ status: 'complete' })
    expect(await settle('Missing', false)).toMatchObject({ status: 'blocked', message: 'result.txt is not committed on main.' })
  })

  it('stores a reached goal only together with the note that carries its Confirm button', async () => {
    const { store, filename } = fixture()
    const runtime = workModule(store)
    const proposal = await pendingProposal(store)
    const target = await runtime.module.accept(proposal.id)
    const note = { type: 'system_note', kind: 'info', text: 'Sage marked the goal reached.', workGoalHandoffId: proposal.id } as const
    const goalNotes = async (connection: Store) =>
      (await connection.loadEvents(target)).filter((event) => event.type === 'system_note' && event.workGoalHandoffId === proposal.id)

    store.db.exec("CREATE TRIGGER fail_note BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'write refused'); END")
    await expect(store.reachWorkGoal(proposal.id, note)).rejects.toThrow('write refused')
    store.db.exec('DROP TRIGGER fail_note')
    store.close()

    const restarted = createSqliteStore({ filename })
    opened.push(restarted)
    expect((await restarted.listWorkHandoffs())[0]?.goalReachedAt).toBeUndefined()
    expect(await goalNotes(restarted)).toEqual([])
    // The retry lands both, and a repeat lands neither again.
    expect(await restarted.reachWorkGoal(proposal.id, note)).toMatchObject(note)
    expect(await restarted.reachWorkGoal(proposal.id, note)).toBeUndefined()
    expect((await restarted.listWorkHandoffs())[0]?.goalReachedAt).toEqual(expect.any(Number))
    expect(await goalNotes(restarted)).toHaveLength(1)
  })

  it.each(['house', 'single'] as const)('keeps %s proposals pending and accepts exactly once across restart', async (mode) => {
    const { store, filename } = fixture()
    const proposal = await pendingProposal(store)
    const before = (await store.listChats()).map((chat) => chat.id).sort()
    store.close()
    const restarted = createSqliteStore({ filename })
    opened.push(restarted)
    const runtime = workModule(restarted)
    await restarted.settleIdleChats(Date.now() + 1)
    expect((await restarted.listChats()).map((chat) => chat.id).sort()).toEqual(before)
    expect((await restarted.listWorkHandoffs())[0]).toMatchObject({ workChatId: null, acceptedAt: null, state: 'active', task: proposal.task })
    expect(runtime.start).not.toHaveBeenCalled()
    const target = await runtime.module.accept(proposal.id, mode === 'single'
      ? { mode, runtime: { driver: 'codex', model: 'gpt-5.6-sol', effort: 'medium' } }
      : { mode })
    const transcript = await restarted.loadEvents(target)
    expect(transcript).toHaveLength(1)
    // The model-only opening lives beside the task, never in the text the user reads.
    expect(transcript[0]).toMatchObject({ type: 'user_message', text: proposal.task, ...(mode === 'single'
      ? { instruction: expect.stringMatching(/^\[Manor\] Session accepted as Single with .*\n\n$/) } : {}) })
    if (mode !== 'single') expect(transcript[0]).not.toHaveProperty('instruction')

    expect(runtime.start).toHaveBeenCalledOnce()
    restarted.close()
    const again = createSqliteStore({ filename })
    opened.push(again)
    const retry = workModule(again)
    expect(await retry.module.accept(proposal.id)).toBe(target)
    expect(retry.start).not.toHaveBeenCalled()
    expect(await again.loadEvents(target)).toEqual(transcript)
    expect((await again.listChats()).filter((chat) => chat.title === proposal.title)).toHaveLength(1)
  })

  it('migrates only unused old shells and preserves accepted work, content and sessions', async () => {
    const { store, filename } = fixture()
    const cases = []
    for (const kind of ['pending', 'accepted', 'content', 'session', 'rejected'] as const) {
      const proposal = await pendingProposal(store, kind)
      const target = (await store.materializeWorkHandoff(proposal.id)).workChatId!
      if (kind === 'accepted') await store.acceptWorkHandoff(target)
      if (kind === 'content') await store.appendEvent(target, { type: 'user_message', text: 'Keep my extra context.', mentions: [] })
      if (kind === 'session') await store.setSession(target, sage.id, 'existing-session')
      if (kind === 'rejected') await workModule(store).module.setSettled(target, true)
      // The old kickoff predates display-name snapshots as well as proposals.
      const transcript = (await store.loadEvents(target)).map((event) => {
        if (event.type !== 'user_message') return event
        const { workAuthorAgentName: _name, ...legacyEvent } = event
        return legacyEvent
      })
      store.db.prepare("UPDATE events SET payload = json_remove(payload, '$.workAuthorAgentName') WHERE chat_id = ?").run(target)
      // Simulate the pre-proposal shape, where the kickoff lived only in the target.
      const records = new SqliteRecords<Record<string, unknown>>(store.db, 'workHandoffs')
      const legacy = records.get(proposal.id)!
      delete legacy.task
      delete legacy.kickoff
      delete legacy.authorAgentId
      records.set(proposal.id, legacy)
      cases.push({ kind, proposal, target, transcript })
    }
    store.db.exec('PRAGMA user_version = 1')
    store.close()
    const migrated = createSqliteStore({ filename })
    opened.push(migrated)
    const runtime = workModule(migrated)
    for (const entry of cases) {
      const handoff = (await migrated.listWorkHandoffs()).find((row) => row.id === entry.proposal.id)!
      if (entry.kind === 'pending' || entry.kind === 'rejected') {
        expect(handoff).toMatchObject({ workChatId: null, acceptedAt: null, kickoff: entry.proposal.task, authorAgentId: 'sage' })
        expect(await migrated.getChat(entry.target)).toBeUndefined()
        expect(new SqliteRecords(migrated.db, 'workHandoffs').get(handoff.id)).toMatchObject({ legacyKickoffEvent: entry.transcript[0] })
      } else {
        expect(handoff.workChatId).toBe(entry.target)
        expect(await migrated.loadEvents(entry.target)).toEqual(entry.transcript)
      }
    }
    expect(runtime.start).not.toHaveBeenCalled()
    const pending = cases.find((entry) => entry.kind === 'pending')!
    const target = await runtime.module.accept(pending.proposal.id)
    expect(target).not.toBe(pending.target)
    expect(await runtime.module.accept(pending.proposal.id)).toBe(target)
    expect(runtime.start).toHaveBeenCalledOnce()
  })
})
