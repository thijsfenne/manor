import type { AgentConfig } from '@manor/contracts'
import type { Store } from '../store.js'
import { createSqliteStore } from './sqliteStore.js'

export interface MemoryStoreOptions {
  agents?: readonly AgentConfig[]
  projectName?: string
}

/** The production store in an ephemeral database, with the test roster and deterministic IDs. */
export function createMemoryStore(options: MemoryStoreOptions = {}): Store {
  return createSqliteStore({ ...options, filename: ':memory:', seed: true })
}
