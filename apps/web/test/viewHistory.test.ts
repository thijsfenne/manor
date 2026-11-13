import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  emptyViewHistory,
  recordLocation,
  readReloadLocation,
  sameLocation,
  stepBack,
  stepForward,
  writeReloadLocation,
  type WorkspaceLocation,
} from '../src/useViewHistory'
import { locationOf } from '../src/useWorkspaceNav'

describe('reload location storage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('ignores broken or obsolete stored destinations', () => {
    for (const raw of ['not json', 'null', '{"sidebarView":"inbox","location":{"kind":"chat"}}',
      '{"sidebarView":"inbox","location":{"kind":"unknown"}}']) {
      vi.stubGlobal('window', { sessionStorage: { getItem: () => raw } })
      expect(readReloadLocation()).toBeNull()
    }
  })

  it('keeps navigation usable when browser storage is blocked', () => {
    const blocked = () => { throw new Error('Storage disabled') }
    vi.stubGlobal('window', { sessionStorage: { getItem: blocked, setItem: blocked } })
    expect(readReloadLocation()).toBeNull()
    expect(() => writeReloadLocation({ location: { kind: 'connectors' }, sidebarView: 'inbox' })).not.toThrow()
  })
})

describe('sameLocation', () => {
  it('treats two chats as the same place only when they are the same thread', () => {
    const a: WorkspaceLocation = { kind: 'chat', chatId: 'one' }
    expect(sameLocation(a, { kind: 'chat', chatId: 'one' })).toBe(true)
    expect(sameLocation(a, { kind: 'chat', chatId: 'two' })).toBe(false)
    expect(sameLocation(a, { kind: 'connectors' })).toBe(false)
  })

  it('compares a new-chat draft by its target, not by being a draft', () => {
    const project: WorkspaceLocation = { kind: 'new-chat', target: { kind: 'project', projectId: 'p1' } }
    const dm: WorkspaceLocation = { kind: 'new-chat', target: { kind: 'dm', agentId: 'sage' } }
    expect(sameLocation(project, { kind: 'new-chat', target: { kind: 'project', projectId: 'p1' } })).toBe(true)
    expect(sameLocation(project, { kind: 'new-chat', target: { kind: 'project', projectId: 'p2' } })).toBe(false)
    expect(sameLocation(project, dm)).toBe(false)
  })

  it('keeps a routine index distinct from one routine\'s detail', () => {
    const index: WorkspaceLocation = { kind: 'routines', routineId: null }
    expect(sameLocation(index, { kind: 'routines', routineId: null })).toBe(true)
    expect(sameLocation(index, { kind: 'routines', routineId: 'r1' })).toBe(false)
  })
})

describe('the view history stack', () => {
  const chat = (id: string): WorkspaceLocation => ({ kind: 'chat', chatId: id })

  it('records the first place, then refuses to record it again', () => {
    const once = recordLocation(emptyViewHistory, chat('a'))
    expect(once).toEqual({ entries: [chat('a')], index: 0 })
    expect(recordLocation(once, chat('a'))).toBe(once)
  })

  it('walks back and forward without losing the stack', () => {
    let state = recordLocation(emptyViewHistory, chat('a'))
    state = recordLocation(state, chat('b'))
    state = recordLocation(state, { kind: 'connectors' })

    const back = stepBack(state)
    expect(back?.location).toEqual(chat('b'))
    const backAgain = stepBack(back!.state)
    expect(backAgain?.location).toEqual(chat('a'))
    expect(stepBack(backAgain!.state)).toBeNull()

    const forward = stepForward(backAgain!.state)
    expect(forward?.location).toEqual(chat('b'))
  })

  it('drops the forward stack when a new place is recorded after going back', () => {
    let state = recordLocation(emptyViewHistory, chat('a'))
    state = recordLocation(state, chat('b'))
    state = stepBack(state)!.state
    state = recordLocation(state, { kind: 'skills' })

    expect(state.entries).toEqual([chat('a'), { kind: 'skills' }])
    expect(state.index).toBe(1)
    expect(stepForward(state)).toBeNull()
  })
})

describe('locationOf', () => {
  it('prefers a live draft over whatever view the stage is still on', () => {
    expect(
      locationOf('connectors', 'c1', { kind: 'project', projectId: 'p1' }, null),
    ).toEqual({ kind: 'new-chat', target: { kind: 'project', projectId: 'p1' } })
  })

  it('records nothing for a new-chat view that has no draft yet', () => {
    expect(locationOf('new-chat', null, undefined, null)).toBeNull()
  })

  it('records nothing for a chat view with no thread', () => {
    expect(locationOf('chat', null, undefined, null)).toBeNull()
  })

  it('keeps a routine index distinct from one routine detail', () => {
    expect(locationOf('routines', null, undefined, null)).toEqual({ kind: 'routines', routineId: null })
    expect(locationOf('routines', null, undefined, 'r1')).toEqual({ kind: 'routines', routineId: 'r1' })
  })
})
