import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { dataPaths } from '../src/paths.js'

describe('data paths', () => {
  afterEach(() => vi.unstubAllEnvs())

  // 09-27 and 09-30: a memory-store server on the real HOME swept every live chat's scratch.
  it('never gives an empty store the shared scratch or worktree dirs', () => {
    vi.stubEnv('MANOR_DATA_DIR', undefined)
    vi.stubEnv('MANOR_SCRATCH_DIR', undefined)
    vi.stubEnv('MANOR_WORKTREES_DIR', undefined)
    const shared = path.join(os.homedir(), '.manor')
    const live = dataPaths(undefined)
    const empty = dataPaths(undefined, { ephemeral: true })
    expect(live.scratch).toBe(path.join(shared, 'scratch'))
    expect(empty.scratch.startsWith(shared)).toBe(false)
    expect(empty.worktrees.startsWith(shared)).toBe(false)
    expect(live.trash).toBe(path.join(shared, 'trash'))
    expect(empty.trash.startsWith(shared)).toBe(false)
    expect(empty.skills).toBe(live.skills)
  })
})
