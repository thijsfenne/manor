import { describe, expect, it } from 'vitest'
import { canRefreshOpenNote } from './KnowledgePanel'

const idle = {
  visible: true,
  live: true,
  path: 'career/note.md',
  fresh: null,
  dirty: false,
  saving: false,
  conflict: false,
  pending: false,
  reading: false,
}

describe('canRefreshOpenNote', () => {
  it('re-reads a clean open note while Knowledge is visible', () => {
    expect(canRefreshOpenNote(idle)).toBe(true)
  })

  it('leaves a dirty buffer alone', () => {
    expect(canRefreshOpenNote({ ...idle, dirty: true })).toBe(false)
  })

  it('does not stack on a read already in flight', () => {
    expect(canRefreshOpenNote({ ...idle, reading: true })).toBe(false)
  })

  it('does not poll in the background', () => {
    expect(canRefreshOpenNote({ ...idle, visible: false })).toBe(false)
  })
})
