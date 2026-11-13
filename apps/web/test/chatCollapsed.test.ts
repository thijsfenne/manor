import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COLLAPSED_KEY, reloadCollapsed, useCollapsed, type CollapsibleSurface } from '../src/chatCollapsed'

describe('folded side surfaces, per chat', () => {
  let view: ReactTestRenderer
  let hook: ReturnType<typeof useCollapsed>
  let storage: Map<string, string>
  function Probe({ chatId, surface = 'knowledge-tree' }: { chatId: string | null; surface?: CollapsibleSurface }) {
    hook = useCollapsed(chatId, surface)
    return null
  }
  beforeEach(() => {
    storage = new Map()
    vi.stubGlobal('window', {
      localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    })
    reloadCollapsed()
  })
  afterEach(() => {
    act(() => view?.unmount())
    vi.unstubAllGlobals()
  })

  it('keeps A folded after switching to B and back, and leaves B alone', () => {
    act(() => { view = create(createElement(Probe, { chatId: 'a' })) })
    expect(hook[0]).toBe(false)
    act(() => hook[1](true))
    expect(hook[0]).toBe(true)
    act(() => view.update(createElement(Probe, { chatId: 'b' })))
    expect(hook[0]).toBe(false)
    act(() => view.update(createElement(Probe, { chatId: 'a' })))
    expect(hook[0]).toBe(true)
    // A screen switch unmounts the panel altogether; the fold is not component state.
    act(() => view.unmount())
    act(() => { view = create(createElement(Probe, { chatId: 'a' })) })
    expect(hook[0]).toBe(true)
  })

  it('folds each surface on its own', () => {
    act(() => { view = create(createElement(Probe, { chatId: 'a', surface: 'sessions-overview' })) })
    act(() => hook[1](true))
    act(() => view.update(createElement(Probe, { chatId: 'a', surface: 'files-tree' })))
    expect(hook[0]).toBe(false)
  })

  it('survives a reload, and shows again once reopened', () => {
    act(() => { view = create(createElement(Probe, { chatId: 'a' })) })
    act(() => hook[1](true))
    reloadCollapsed()
    expect(hook[0]).toBe(true)
    act(() => hook[1](false))
    expect(storage.get(COLLAPSED_KEY)).toBe('{}')
  })

  it('reads a damaged store as nothing folded', () => {
    storage.set(COLLAPSED_KEY, '{"a":["knowledge-tree","nonsense"],"b":"x"}')
    reloadCollapsed()
    act(() => { view = create(createElement(Probe, { chatId: 'a' })) })
    expect(hook[0]).toBe(true)
    act(() => view.update(createElement(Probe, { chatId: 'b' })))
    expect(hook[0]).toBe(false)
  })

  it('keeps a chatless surface (the vault home) as plain state that is never stored', () => {
    act(() => { view = create(createElement(Probe, { chatId: null })) })
    act(() => hook[1](true))
    expect(hook[0]).toBe(true)
    expect(storage.size).toBe(0)
  })
})
