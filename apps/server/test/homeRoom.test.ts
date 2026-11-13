import { mkdtempSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { HOME_PROJECT_ID } from '@manor/contracts'
import { openSqlite, SQLITE_SCHEMA_VERSION } from '../src/stores/sqliteDatabase.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'

const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite')

describe('the home room', () => {
  it('answers for its id with the memory folder, and is in no project list', async () => {
    const store = createMemoryStore()
    await store.setHomeFolders(['/memory'])

    expect(await store.getProject(HOME_PROJECT_ID)).toMatchObject({ id: HOME_PROJECT_ID, repoPaths: ['/memory'], memoryScope: 'knowledge' })
    expect((await store.listProjects()).map((project) => project.id)).not.toContain(HOME_PROJECT_ID)
    // The name is no longer held: General is a project like any other.
    const general = await store.createProject('General')
    expect(general.id).not.toBe(HOME_PROJECT_ID)
  })

  it('holds a Session without a project, and refuses a room nobody made', async () => {
    const store = createMemoryStore()
    const session = await store.createChat({ projectId: HOME_PROJECT_ID, mode: 'single' })
    expect(session).toMatchObject({ kind: 'project', projectId: HOME_PROJECT_ID })
    expect((await store.chatsForProject(HOME_PROJECT_ID)).map((chat) => chat.id)).toEqual([session.id])
    await expect(store.createChat({ projectId: 'nowhere' })).rejects.toThrow('unknown project')
  })

  it('cannot be deleted, which would take every Session without a project with it', async () => {
    const store = createMemoryStore()
    const session = await store.createChat({ projectId: HOME_PROJECT_ID })
    await expect(store.deleteProject(HOME_PROJECT_ID)).rejects.toThrow('cannot be deleted')
    expect(await store.getChat(session.id)).toBeDefined()
  })
})

describe('the migration that retires General', () => {
  const record = (db: InstanceType<typeof DatabaseSync>, collection: string, key: string, value: object) =>
    db.prepare('INSERT INTO records(collection, key, value) VALUES(?, ?, ?)').run(collection, key, JSON.stringify(value))
  const read = (db: InstanceType<typeof DatabaseSync>, collection: string, key: string) => {
    const row = db.prepare('SELECT value FROM records WHERE collection = ? AND key = ?').get(collection, key)
    return row === undefined ? undefined : JSON.parse(String(row.value)) as Record<string, unknown>
  }

  it('moves everything in a threadless General to the home room and drops the row', () => {
    const filename = path.join(mkdtempSync(path.join(os.tmpdir(), 'manor-home-')), 'manor.db')
    openSqlite(filename).close()
    const before = new DatabaseSync(filename)
    record(before, 'projects', 'general', { id: 'general', name: 'General', repoPaths: ['/memory'], memoryScope: 'knowledge' })
    record(before, 'projects', 'client', { id: 'client', name: 'Client', repoPaths: [] })
    record(before, 'chats', 'in-general', { id: 'in-general', kind: 'project', projectId: 'general', title: 'kept' })
    record(before, 'chats', 'in-client', { id: 'in-client', kind: 'project', projectId: 'client' })
    record(before, 'chats', 'dm', { id: 'dm', kind: 'dm', projectId: null })
    record(before, 'routines', 'task', { id: 'task', projectId: 'general', chatId: null })
    record(before, 'routines', 'bare', { id: 'bare', projectId: null, chatId: null })
    record(before, 'routines', 'in-dm', { id: 'in-dm', projectId: null, chatId: 'dm' })
    record(before, 'workHandoffs', 'work', { id: 'work', projectId: 'general', projectName: 'General' })
    record(before, 'workHandoffs', 'other', { id: 'other', projectId: 'client', projectName: 'Client' })
    // The version before 014_home_room.sql, the migration under test.
    before.exec('PRAGMA user_version = 13')
    before.close()

    const db = openSqlite(filename)
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(SQLITE_SCHEMA_VERSION)
    expect(read(db, 'projects', 'general')).toBeUndefined()
    expect(read(db, 'projects', 'client')).toMatchObject({ name: 'Client' })
    expect(read(db, 'chats', 'in-general')).toMatchObject({ projectId: HOME_PROJECT_ID, title: 'kept' })
    expect(read(db, 'chats', 'in-client')).toMatchObject({ projectId: 'client' })
    expect(read(db, 'chats', 'dm')).toMatchObject({ projectId: null })
    expect(read(db, 'routines', 'task')).toMatchObject({ projectId: HOME_PROJECT_ID })
    // A task that ran with no room at all gets the home room too: one meaning for "No project".
    expect(read(db, 'routines', 'bare')).toMatchObject({ projectId: HOME_PROJECT_ID })
    // A persona's task in a direct message has its chat as its target and keeps it.
    expect(read(db, 'routines', 'in-dm')).toMatchObject({ projectId: null, chatId: 'dm' })
    expect(read(db, 'workHandoffs', 'work')).toMatchObject({ projectId: HOME_PROJECT_ID, projectName: 'No project' })
    expect(read(db, 'workHandoffs', 'other')).toMatchObject({ projectId: 'client', projectName: 'Client' })
    db.close()
  })

  it('is applied by the server only: a helper beside a running Manor refuses to migrate', () => {
    const filename = path.join(mkdtempSync(path.join(os.tmpdir(), 'manor-home-')), 'manor.db')
    openSqlite(filename).close()
    const before = new DatabaseSync(filename)
    record(before, 'projects', 'general', { id: 'general', name: 'General', repoPaths: [] })
    before.exec('PRAGMA user_version = 13')
    before.close()

    expect(() => openSqlite(filename, { migrate: false })).toThrow('Start Manor once')
    const untouched = new DatabaseSync(filename, { readOnly: true })
    expect(untouched.prepare('PRAGMA user_version').get()?.user_version).toBe(13)
    expect(read(untouched, 'projects', 'general')).toMatchObject({ name: 'General' })
    untouched.close()
    // A database that is current opens as usual.
    openSqlite(filename).close()
    openSqlite(filename, { migrate: false }).close()
  })

  it('leaves a General that has a thread alone: that one is a project the user sees', () => {
    const filename = path.join(mkdtempSync(path.join(os.tmpdir(), 'manor-home-')), 'manor.db')
    openSqlite(filename).close()
    const before = new DatabaseSync(filename)
    record(before, 'projects', 'general', { id: 'general', name: 'General', repoPaths: [], threadChatId: 'thread' })
    record(before, 'chats', 'thread', { id: 'thread', kind: 'project', projectId: 'general' })
    before.exec('PRAGMA user_version = 13')
    before.close()

    const db = openSqlite(filename)
    expect(read(db, 'projects', 'general')).toMatchObject({ name: 'General', threadChatId: 'thread' })
    expect(read(db, 'chats', 'thread')).toMatchObject({ projectId: 'general' })
    db.close()
  })
})
