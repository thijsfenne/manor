import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeTab,
  moveTab,
  NO_TABS,
  openInActive,
  openInNew,
  pruneTabs,
  readTabs,
  renamePaths,
  writeTabs,
  type ContentTabs,
} from '../src/contentTabs'

const paths = (state: ContentTabs) => state.tabs.map((tab) => tab.path)
const activePath = (state: ContentTabs) => state.tabs.find((tab) => tab.id === state.activeId)?.path

/** a, b, c open with b active. */
const three = () => {
  const state = openInNew(openInNew(openInNew(NO_TABS, 'a'), 'b'), 'c')
  return { ...state, activeId: state.tabs[1]!.id }
}

describe('content tabs', () => {
  it('opens a plain click in the active tab and a new-tab open beside it', () => {
    const first = openInActive(NO_TABS, 'a')
    expect(paths(first)).toEqual(['a'])
    const replaced = openInActive(first, 'b')
    expect(paths(replaced)).toEqual(['b'])
    expect(replaced.tabs[0]!.id).toBe(first.tabs[0]!.id)

    const added = openInNew(three(), 'd')
    expect(paths(added)).toEqual(['a', 'b', 'd', 'c'])
    expect(activePath(added)).toBe('d')
  })

  it('switches to a path already open instead of opening it twice', () => {
    const state = three()
    expect(paths(openInActive(state, 'c'))).toEqual(['a', 'b', 'c'])
    expect(activePath(openInActive(state, 'c'))).toBe('c')
    expect(paths(openInNew(state, 'a'))).toEqual(['a', 'b', 'c'])
  })

  it('opens a drop at its index and moves a dropped path that is already open', () => {
    expect(paths(openInNew(three(), 'd', 0))).toEqual(['d', 'a', 'b', 'c'])
    // Dropped in the gap after b: a's own slot no longer counts.
    const moved = openInNew(three(), 'a', 2)
    expect(paths(moved)).toEqual(['b', 'a', 'c'])
    expect(activePath(moved)).toBe('a')
  })

  it('opens a finder tab with no path', () => {
    const state = openInNew(three(), null)
    expect(paths(state)).toEqual(['a', 'b', null, 'c'])
    expect(activePath(state)).toBeNull()
    expect(paths(openInActive(state, 'd'))).toEqual(['a', 'b', 'd', 'c'])
  })

  it('hands the active tab to its right neighbour on close, else its left', () => {
    const state = three()
    expect(activePath(closeTab(state, state.tabs[1]!.id))).toBe('c')
    const last = { ...state, activeId: state.tabs[2]!.id }
    expect(activePath(closeTab(last, last.tabs[2]!.id))).toBe('b')
    expect(activePath(closeTab(state, state.tabs[0]!.id))).toBe('b')
    const only = openInActive(NO_TABS, 'a')
    expect(closeTab(only, only.tabs[0]!.id)).toEqual(NO_TABS)
  })

  it('reorders without changing the active tab', () => {
    const state = three()
    const moved = moveTab(state, state.tabs[0]!.id, 2)
    expect(paths(moved)).toEqual(['b', 'c', 'a'])
    expect(activePath(moved)).toBe('b')
  })

  it('follows a renamed folder and drops tabs whose file is gone', () => {
    const state = openInNew(openInNew(NO_TABS, 'notes/a.md'), 'b.md')
    expect(paths(renamePaths(state, (path) => path.replace(/^notes\//, 'archive/')))).toEqual(['archive/a.md', 'b.md'])
    expect(paths(pruneTabs(state, (path) => path === 'b.md'))).toEqual(['b.md'])
    expect(paths(pruneTabs(state, () => false, 'b.md'))).toEqual(['b.md'])
  })

  describe('storage', () => {
    let store: Map<string, string>
    beforeEach(() => {
      store = new Map()
      vi.stubGlobal('window', {
        localStorage: {
          getItem: (key: string) => store.get(key) ?? null,
          setItem: (key: string, value: string) => store.set(key, value),
          removeItem: (key: string) => store.delete(key),
        },
      })
    })
    afterEach(() => vi.unstubAllGlobals())

    it('restores order and the active tab, and forgets an empty strip', () => {
      const state = three()
      writeTabs('tabs', state)
      expect(readTabs('tabs')).toEqual(state)
      writeTabs('tabs', NO_TABS)
      expect(store.has('tabs')).toBe(false)
    })

    it('reads damaged storage as no tabs and a lost active id as the first tab', () => {
      store.set('broken', '{not json')
      expect(readTabs('broken')).toEqual(NO_TABS)
      store.set('odd', JSON.stringify({ tabs: [{ id: 'x', path: 'a' }, { id: 7 }], activeId: 'gone' }))
      expect(readTabs('odd')).toEqual({ tabs: [{ id: 'x', path: 'a' }], activeId: 'x' })
    })
  })
})
