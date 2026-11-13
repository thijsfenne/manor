import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PERSONA_TOOLS, type AgentConfig, type AgentDraft } from '@manor/contracts'
import { QUEUED_SAVE_WAIT_MS, TYPING_SAVE_MS, useAgentAutosave } from '../src/components/agents/useAgentAutosave'
import type { RequestEvents, RequestResponse } from '../src/useRequest'
import type { ConnectionStatus } from '../src/useWorkspace'

const iris: AgentConfig = {
  id: 'iris', name: 'Iris', color: '#8B7EC8', character: 'You plan.', driver: 'claude', model: 'claude-opus-5-5',
  effort: 'high', allowedTools: [...PERSONA_TOOLS], mcpServers: [], skillIds: [], memoryScope: true,
  role: '', description: 'Plans.', isCos: false, mentionAllowlist: [],
}

let listeners: Set<(response: RequestResponse) => void>
let events: RequestEvents
let renderer: ReactTestRenderer
let hook: ReturnType<typeof useAgentAutosave>
const save = vi.fn((_draft: AgentDraft, _requestId: string) => true)

function Harness({ agent, status = 'live' }: { agent: AgentConfig; status?: ConnectionStatus }) {
  hook = useAgentAutosave(agent, status, events, save)
  return null
}

const mount = (agent: AgentConfig = iris) => act(() => { renderer = create(<Harness agent={agent} />) })
const rerender = (agent: AgentConfig, status: ConnectionStatus = 'live') => act(() => renderer.update(<Harness agent={agent} status={status} />))
const emit = (response: RequestResponse) => act(() => { for (const listener of listeners) listener(response) })
const sent = (call: number) => save.mock.calls[call]![0]
const ack = (call: number) => emit({ type: 'ack', requestId: save.mock.calls[call]![1] })

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  listeners = new Set()
  events = { subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  save.mockReset().mockReturnValue(true)
})

afterEach(() => {
  act(() => renderer.unmount())
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('agent settings autosave', () => {
  it('saves a switch at once and typing only once it rests', () => {
    mount()
    act(() => hook.edit({ memoryScope: false }))
    expect(save).toHaveBeenCalledTimes(1)
    expect(sent(0)).toMatchObject({ id: 'iris', memoryScope: false })
    expect(hook.state.kind).toBe('saving')
    ack(0)
    expect(hook.state.kind).toBe('saved')

    act(() => hook.edit({ name: 'Ir' }, true))
    act(() => hook.edit({ name: 'Iri' }, true))
    act(() => { vi.advanceTimersByTime(TYPING_SAVE_MS - 1) })
    expect(save).toHaveBeenCalledTimes(1)
    act(() => { vi.advanceTimersByTime(1) })
    expect(save).toHaveBeenCalledTimes(2)
    expect(sent(1)).toMatchObject({ name: 'Iri' })
  })

  it('sends one save at a time, and an edit made meanwhile rides on the next', () => {
    mount()
    act(() => hook.edit({ isCos: true }))
    act(() => hook.edit({ railPinned: true }))
    act(() => hook.edit({ pinned: true }))
    expect(save).toHaveBeenCalledTimes(1)
    ack(0)
    expect(save).toHaveBeenCalledTimes(2)
    expect(sent(1)).toMatchObject({ isCos: true, railPinned: true, pinned: true })
    ack(1)
    expect(save).toHaveBeenCalledTimes(2)
    expect(hook.state.kind).toBe('saved')
  })

  it('holds an empty name back instead of sending it, and saves once it is fixed', () => {
    mount()
    act(() => hook.edit({ name: '  ' }))
    expect(save).not.toHaveBeenCalled()
    expect(hook.state).toMatchObject({ kind: 'held' })
    act(() => hook.edit({ name: 'Ivy' }))
    expect(sent(0)).toMatchObject({ name: 'Ivy' })
  })

  it('keeps the draft after a refusal and tries again on the next change', () => {
    mount()
    act(() => hook.edit({ description: 'Refused.' }))
    emit({ type: 'notice', kind: 'error', text: 'No.', requestId: save.mock.calls[0]![1] })
    expect(hook.state).toEqual({ kind: 'failed', text: 'No.' })
    expect(hook.draft.description).toBe('Refused.')
    act(() => hook.edit({ effort: 'medium' }))
    expect(sent(1)).toMatchObject({ description: 'Refused.', effort: 'medium' })
  })

  it('says so when nothing could be sent', () => {
    save.mockReturnValue(false)
    mount()
    act(() => hook.edit({ memoryScope: false }))
    expect(hook.state.kind).toBe('failed')
  })

  it('takes a change from elsewhere while idle, but never over an edit not yet saved', () => {
    mount()
    rerender({ ...iris, description: 'Changed in another window.' })
    expect(hook.draft.description).toBe('Changed in another window.')

    act(() => hook.edit({ name: 'Iri' }, true))
    rerender({ ...iris, description: 'Another change.' })
    expect(hook.draft.name).toBe('Iri')
    expect(hook.draft.description).toBe('Changed in another window.')
  })

  it('does not reset the draft when the roster echoes what was just sent', () => {
    mount()
    act(() => hook.edit({ name: 'Ivy' }))
    act(() => hook.edit({ name: 'Ivy Two' }, true))
    rerender({ ...iris, name: 'Ivy' })
    expect(hook.draft.name).toBe('Ivy Two')
  })

  it('sends an edit queued behind a save still out once that save is answered, even after the panel closed', () => {
    mount()
    act(() => hook.edit({ isCos: true }))
    act(() => hook.edit({ pinned: true }))
    act(() => renderer.unmount())
    // Not beside the first save, which could land after it: behind its answer.
    expect(save).toHaveBeenCalledTimes(1)
    ack(0)
    expect(save).toHaveBeenCalledTimes(2)
    expect(sent(1)).toMatchObject({ isCos: true, pinned: true })
    mount()
  })

  it('releases a queued closing save on a refusal of the one ahead, or after a wait for an answer that never comes', () => {
    mount()
    act(() => hook.edit({ name: 'Taken' }))
    act(() => hook.edit({ name: 'Free' }))
    act(() => renderer.unmount())
    emit({ type: 'notice', kind: 'error', text: 'Name taken.', requestId: save.mock.calls[0]![1] })
    expect(sent(1)).toMatchObject({ name: 'Free' })

    mount()
    act(() => hook.edit({ memoryScope: false }))
    act(() => hook.edit({ effort: 'low' }))
    act(() => renderer.unmount())
    expect(save).toHaveBeenCalledTimes(3)
    act(() => { vi.advanceTimersByTime(QUEUED_SAVE_WAIT_MS) })
    expect(sent(3)).toMatchObject({ memoryScope: false, effort: 'low' })
    mount()
  })

  it('gives up a save whose answer the connection dropped, and sends the draft again once it is back', () => {
    mount()
    act(() => hook.edit({ memoryScope: false }))
    rerender(iris, 'offline')
    expect(hook.state.kind).toBe('failed')
    save.mockReturnValue(false)
    act(() => hook.edit({ effort: 'medium' }))
    save.mockReturnValue(true)
    rerender(iris, 'live')
    expect(save).toHaveBeenCalledTimes(3)
    expect(sent(2)).toMatchObject({ memoryScope: false, effort: 'medium' })
    ack(2)
    expect(hook.state.kind).toBe('saved')
  })

  it('saves resting typing when the panel closes', () => {
    mount()
    act(() => hook.edit({ character: 'You plan carefully.' }, true))
    act(() => renderer.unmount())
    expect(sent(0)).toMatchObject({ character: 'You plan carefully.' })
    mount()
  })
})
