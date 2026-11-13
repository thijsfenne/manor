import { describe, expect, it } from 'vitest'
import {
  agentNotesPath,
  memoryDirPinned,
  memoryTargetNotice,
  resolveMemoryTarget,
} from '../src/memoryTarget.js'

const home = '/Users/someone'

describe('resolveMemoryTarget', () => {
  it('defaults to a folder beside the database, wherever the data directory is', () => {
    expect(resolveMemoryTarget({}, home)).toEqual({ dailyDir: '/Users/someone/.manor/memory/memory/daily' })
    expect(resolveMemoryTarget({ MANOR_DATA_DIR: '/tmp/spike/' }, home)).toEqual({ dailyDir: '/tmp/spike/memory/memory/daily' })
  })

  it('takes the folder from MANOR_MEMORY_DIR', () => {
    expect(resolveMemoryTarget({ MANOR_MEMORY_DIR: '~/Notes' }, home)).toEqual({ dailyDir: '/Users/someone/Notes/memory/daily' })
  })

  // Empty used to switch to a relay that pushed files to a repository. Memory is a
  // local folder now, so a blank setting is no setting.
  it('falls back to the default folder when the variable is set to nothing', () => {
    const fallback = { dailyDir: '/Users/someone/.manor/memory/memory/daily' }
    expect(resolveMemoryTarget({ MANOR_MEMORY_DIR: '' }, home)).toEqual(fallback)
    expect(resolveMemoryTarget({ MANOR_MEMORY_DIR: '   ' }, home)).toEqual(fallback)
  })

  it('takes the folder picked in Settings, and lets the environment win over it', () => {
    expect(resolveMemoryTarget({}, home, '~/Picked/')).toEqual({ dailyDir: '/Users/someone/Picked/memory/daily' })
    expect(resolveMemoryTarget({ MANOR_MEMORY_DIR: '~/Notes' }, home, '~/Picked')).toEqual({ dailyDir: '/Users/someone/Notes/memory/daily' })
    expect(memoryDirPinned({ MANOR_MEMORY_DIR: '~/Old' })).toBe(true)
    expect(memoryDirPinned({ MANOR_MEMORY_DIR: ' ' })).toBe(false)
  })

  it('takes an explicit path, expanding ~ and dropping a trailing slash', () => {
    expect(resolveMemoryTarget({ MANOR_MEMORY_DIR: '~/Work/notes/' }, home)).toEqual({
      dailyDir: '/Users/someone/Work/notes/memory/daily',
    })
    expect(resolveMemoryTarget({ MANOR_MEMORY_DIR: '/srv/notes' }, home)).toEqual({
      dailyDir: '/srv/notes/memory/daily',
    })
  })

  it('names the folder in force, so the startup log can be read instead of inferred', () => {
    expect(memoryTargetNotice(resolveMemoryTarget({}, home))).toContain('/Users/someone/.manor/memory/memory/daily')
  })

  it('resolves standing notes next to the daily log, and nowhere without a folder or an agent', () => {
    expect(agentNotesPath(resolveMemoryTarget({}, home), 'sage')).toBe(
      '/Users/someone/.manor/memory/memory/agents/sage.md',
    )
    expect(agentNotesPath(undefined, 'sage')).toBeUndefined()
    expect(agentNotesPath(resolveMemoryTarget({}, home), '')).toBeUndefined()
  })
})
