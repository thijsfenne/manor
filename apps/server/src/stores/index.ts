import { existsSync, statSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import type { Store } from '../store.js'
import type { StoreConfig } from '../config.js'
import { SqliteRecords } from './sqliteDatabase.js'
import { createSqliteStore } from './sqliteStore.js'
import { createMemoryStore } from './memoryStore.js'

/** Written on the first start, so the next one knows this file was begun by Manor and not left half-imported. */
export const FRESH_DATABASE_MARK = 'fresh'

/**
 * The one place a resolved config becomes a store. Nothing else constructs one.
 * A database file that does not exist yet is a first run: it starts as an empty
 * house, with no agents and no projects, and the onboarding fills it. An existing
 * file must carry the first-run mark, or the `verified` mark of a database that
 * was imported from Postgres before the importer was deleted, so a half-written
 * database never serves chats. The server's owner claim creates the
 * file before this runs, hence the size test.
 */
export function createStore(config: StoreConfig, options: { migrate?: boolean } = {}): Store & { db?: DatabaseSync; close?: () => void } {
  if (config.kind === 'sqlite') {
    const firstRun = !existsSync(config.filename) || statSync(config.filename).size === 0
    const store = createSqliteStore({ ...config, ...(options.migrate === undefined ? {} : { migrate: options.migrate }) })
    const origin = new SqliteRecords<unknown>(store.db, 'migration')
    if (firstRun) origin.set(FRESH_DATABASE_MARK, { at: Date.now() })
    else if (!origin.has('verified') && !origin.has(FRESH_DATABASE_MARK)) {
      store.close()
      throw new Error(`${config.filename} was never finished: it has no first-run or import mark. Move it aside to start fresh, or restore a backup.`)
    }
    return store
  }
  return createMemoryStore()
}
