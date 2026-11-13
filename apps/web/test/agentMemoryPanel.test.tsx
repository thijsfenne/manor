import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentMemoryPanel, agentMemoryCoverage } from '../src/components/AgentMemoryPanel'
import type { RequestEvents, RequestResponse } from '../src/useRequest'

vi.mock('motion/react', () => ({
  motion: { span: ({ layoutId: _layoutId, initial: _initial, transition: _transition, ...rest }: Record<string, unknown>) => <span {...rest} /> },
  useReducedMotion: () => true,
}))
vi.mock('../src/components/Markdown', () => ({ Markdown: ({ text }: { text: string }) => <p>{text}</p> }))

let panel: ReactTestRenderer
let listeners: Set<(response: RequestResponse) => void>
let events: RequestEvents
const load = vi.fn((_chatId: string, _requestId: string) => true)
const close = vi.fn()
const props = () => ({
  chatId: 'dm_sage',
  status: 'live' as const,
  requestEvents: events,
  onLoad: load,
  onClose: close,
  width: 412,
  resizing: false,
  resizeProps: {},
})
const content = () => JSON.stringify(panel.toJSON())
const reply = (requestId: string, chatId = 'dm_sage'): RequestResponse => ({
  type: 'chat_summary',
  requestId,
  chatId,
  summary: {
    text: 'The saved conversation summary.',
    fromEventId: 'evt_1',
    fromAt: Date.UTC(2026, 8, 14, 9, 10),
    throughEventId: 'evt_9',
    throughAt: Date.UTC(2026, 8, 15, 10, 20),
    updatedAt: Date.UTC(2026, 8, 15, 10, 30),
  },
})
const emit = (response: RequestResponse) => act(() => { for (const listener of listeners) listener(response) })

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  listeners = new Set()
  events = { subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  load.mockReset().mockReturnValue(true)
  act(() => { panel = create(<AgentMemoryPanel {...props()} />) })
})

afterEach(() => {
  act(() => panel.unmount())
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('agent memory panel', () => {
  it('waits for its own DM response, then shows the stored summary and metadata', () => {
    const requestId = load.mock.calls[0]![1]
    expect(content()).toContain('Loading agent memory')
    emit(reply('other'))
    emit(reply(requestId, 'dm_other'))
    expect(content()).not.toContain('The saved conversation summary')
    emit(reply(requestId))
    expect(content()).toContain('The saved conversation summary')
    expect(content()).toContain('Covers')
    expect(content()).toContain('Updated')
    expect(content()).toContain('evt_1 through evt_9')
  })

  it('shows honestly when no summary has been saved', () => {
    const response = reply(load.mock.calls[0]![1])
    if (response.type !== 'chat_summary') throw new Error('Expected a summary response')
    emit({ ...response, summary: null })
    expect(content()).toContain('No agent memory saved for this conversation yet')
  })

  it('shows a correlated error and retries with a fresh request', () => {
    const requestId = load.mock.calls[0]![1]
    emit({ type: 'notice', requestId, kind: 'error', text: 'Cannot read summary' })
    expect(content()).toContain('Cannot read summary')
    act(() => panel.root.findAllByType('button').find((button) => button.children.includes('Retry'))!.props.onClick())
    expect(load).toHaveBeenCalledTimes(2)
    expect(load.mock.calls[1]![1]).not.toBe(requestId)
  })

  it('switches between the summary and the standing notes, starting on Summary for each chat', () => {
    const response = reply(load.mock.calls[0]![1])
    if (response.type !== 'chat_summary') throw new Error('Expected a summary response')
    const tab = (label: string) => panel.root.findAll((node) => node.props.role === 'tab' && node.children.some(
      (child) => typeof child !== 'string' && child.children.includes(label),
    ))[0]!
    emit({ ...response, notes: { path: 'memory/agents/sage.md', content: 'Log first, then answer once.', truncated: false } })
    expect(content()).toContain('The saved conversation summary')
    expect(content()).not.toContain('Log first, then answer once')
    act(() => tab('Notes').props.onClick())
    expect(content()).toContain('Log first, then answer once')
    expect(content()).toContain('memory/agents/sage.md')
    expect(content()).not.toContain('The saved conversation summary')
    expect(tab('Notes').props['aria-selected']).toBe(true)

    act(() => panel.update(<AgentMemoryPanel {...props()} chatId="dm_smith" />))
    emit(reply(load.mock.calls[1]![1], 'dm_smith'))
    expect(tab('Summary').props['aria-selected']).toBe(true)
    expect(tab('Notes').props.disabled).toBe(true)
  })

  it('does not invent a source range when the stored cursor cannot be resolved', () => {
    const response = reply('request')
    if (response.type !== 'chat_summary' || response.summary === null) throw new Error('Expected a summary')
    expect(agentMemoryCoverage({ ...response.summary, fromAt: null })).toBe('Source range unavailable')
  })
})
