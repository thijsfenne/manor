import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectMemoryPanel, projectMemoryBody, projectMemoryTitles } from '../src/components/ProjectMemoryPanel'
import { lastTurnSelectedMemoryPaths, selectedMemoryPaths } from '../src/messageMeta'
import type { RequestEvents, RequestResponse } from '../src/useRequest'

let panel: ReactTestRenderer
let listeners: Set<(response: RequestResponse) => void>
let events: RequestEvents
const load = vi.fn((_projectId: string, _requestId: string) => true)
const close = vi.fn()
const props = () => ({
  projectId: 'manor',
  status: 'live' as const,
  requestEvents: events,
  onLoad: load,
  onClose: close,
  width: 412,
  resizing: false,
  resizeProps: {},
})
const content = () => JSON.stringify(panel.toJSON())
const reply = (requestId: string, projectId = 'manor'): Extract<RequestResponse, { type: 'project_memory' }> => ({
  type: 'project_memory',
  requestId,
  projectId,
  files: [
    {
      path: '/memory/manor/MEMORY.md',
      kind: 'index',
      modifiedAt: 1,
      content: '- [Runtime decisions](runtime.md) — How Manor runs.',
    },
    {
      path: '/memory/manor/runtime.md',
      kind: 'file',
      modifiedAt: 1,
      content: '---\nname: runtime\n---\n\nA remembered decision',
    },
  ],
  truncated: false,
})
const emit = (response: RequestResponse) => act(() => { for (const listener of listeners) listener(response) })

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', { setTimeout, clearTimeout })
  listeners = new Set()
  events = { subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } } }
  load.mockReset().mockReturnValue(true)
  act(() => { panel = create(<ProjectMemoryPanel {...props()} />) })
})
afterEach(() => {
  act(() => panel.unmount())
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('project memory panel', () => {
  it('waits for its own project response, then shows a compact title-only row', () => {
    const requestId = load.mock.calls[0]![1]
    expect(content()).toContain('Loading project memory')
    emit(reply('other'))
    emit(reply(requestId, 'other-project'))
    expect(content()).not.toContain('A remembered decision')
    emit(reply(requestId))
    expect(content()).toContain('Runtime decisions')
    expect(content()).not.toContain('A remembered decision')
    expect(content()).not.toContain('MEMORY.md')
    expect(content()).not.toContain('Loading project memory')
  })

  it('opens one clean detail and returns to the list', () => {
    emit(reply(load.mock.calls[0]![1]))
    act(() => panel.root.findByProps({ title: '/memory/manor/runtime.md' }).props.onClick())
    expect(content()).toContain('Runtime decisions')
    expect(content()).toContain('A remembered decision')
    expect(content()).not.toContain('name: runtime')
    expect(content()).not.toContain('runtime.md')
    expect(panel.root.findByProps({ 'aria-label': 'Back to context' }).props.children[1].props.children).toBe('Runtime decisions')

    act(() => panel.root.findByProps({ 'aria-label': 'Back to context' }).props.onClick())
    expect(content()).not.toContain('A remembered decision')
  })

  it('uses the document heading without adding a second title', () => {
    const response = reply(load.mock.calls[0]![1])
    response.files[1]!.content = '---\nname: runtime\n---\n\n# Runtime decisions\n\nA remembered decision'
    emit(response)
    act(() => panel.root.findByProps({ title: '/memory/manor/runtime.md' }).props.onClick())
    expect(panel.root.findAllByType('h1')).toHaveLength(0)
    expect(panel.root.findAllByType('h2').map((heading) => heading.children)).toEqual([['Runtime decisions']])
    expect(content()).toContain('A remembered decision')
  })

  it('opens a loaded sibling card from Markdown using the existing detail selection', () => {
    const response = reply(load.mock.calls[0]![1])
    response.files.push({
      path: '/memory/manor/preferences.md', kind: 'file', modifiedAt: 2,
      content: '[Default](runtime.md) and [Explicit sibling](./runtime.md)',
    })
    emit(response)
    act(() => panel.root.findByProps({ title: '/memory/manor/preferences.md' }).props.onClick())
    const links = panel.root.findAllByType('button').filter((button) => button.children.includes('Default') || button.children.includes('Explicit sibling'))
    expect(links).toHaveLength(2)
    expect(links[0]!.props.className).toContain('text-[var(--accent-fg)]')
    act(() => links[1]!.props.onClick())
    expect(content()).toContain('A remembered decision')
    expect(content()).not.toContain('Explicit sibling')
    act(() => panel.root.findByProps({ 'aria-label': 'Back to context' }).props.onClick())
    expect(panel.root.findByProps({ title: '/memory/manor/preferences.md' })).toBeDefined()
  })

  it('keeps unavailable or non-sibling links plain while preserving website links', () => {
    const response = reply(load.mock.calls[0]![1])
    response.files.push(
      {
        path: '/memory/manor/preferences.md', kind: 'file', modifiedAt: 2,
        content: '[Missing](missing.md) [Archive](_archive/old.md) [Outside](../other/runtime.md) [Absolute](/memory/manor/runtime.md) [HTTPS](https://example.com) [HTTP](http://example.com)',
      },
      { path: '/memory/manor/_archive/old.md', kind: 'file', modifiedAt: 2, content: 'Archived' },
      { path: '/memory/other/runtime.md', kind: 'file', modifiedAt: 2, content: 'Another folder' },
    )
    emit(response)
    act(() => panel.root.findByProps({ title: '/memory/manor/preferences.md' }).props.onClick())
    for (const label of ['Missing', 'Archive', 'Outside', 'Absolute']) {
      const text = panel.root.findAllByType('span').find((span) => span.children.includes(label))
      expect(text).toBeDefined()
      expect(text!.props.onClick).toBeUndefined()
    }
    expect(panel.root.findAllByType('a').map((link) => link.props.href)).toEqual(['https://example.com', 'http://example.com'])
  })

  it('marks a memory selected for this turn', () => {
    const response = reply(load.mock.calls[0]![1])
    response.files.push(
      { path: '/memory/manor/old.md', kind: 'file', modifiedAt: 2, content: 'Older' },
      { path: '/memory/manor/new.md', kind: 'file', modifiedAt: 3, content: 'Newer' },
    )
    emit(response)
    const path = '/memory/manor/runtime.md'
    act(() => panel.update(<ProjectMemoryPanel {...props()} usedPaths={new Set([path])} />))
    expect(panel.root.findByProps({ title: `${path}, Selected this turn` })).toBeDefined()
    expect(content()).toContain('This turn')
    expect(panel.root.findAllByType('button').flatMap((button) => button.props.title ?? [])
      .filter((title) => title.startsWith('/memory/'))).toEqual([
      `${path}, Selected this turn`,
      '/memory/manor/new.md',
      '/memory/manor/old.md',
    ])
    expect(panel.root.findAllByProps({ role: 'separator' })).toHaveLength(1)

    act(() => panel.root.findByProps({ title: `${path}, Selected this turn` }).props.onClick())
    expect(content()).toContain('This turn')
  })

  it('lists this turn\'s sources in knowledge work, not the project tree', () => {
    const listed = '/memory/manor/runtime.md'
    const other = '/Users/sam/notes/memory/structured/manor/architecture.md'
    const response = reply(load.mock.calls[0]![1])
    response.files.push({ path: '/memory/manor/old.md', kind: 'file', modifiedAt: 2, content: 'Older' })
    emit(response)
    act(() => panel.update(
      <ProjectMemoryPanel
        {...props()}
        memoryScope="knowledge"
        usedPaths={new Set([listed, other])}
      />,
    ))
    expect(content()).toContain('Knowledge work memory')
    expect(content()).toContain('Runtime decisions')
    expect(content()).toContain('Architecture')
    expect(content()).not.toContain('This turn')
    expect(content()).not.toContain('/memory/manor/old.md')
    expect(content()).not.toContain('No project memories saved yet')

    act(() => panel.root.findByProps({ title: listed }).props.onClick())
    expect(content()).toContain('A remembered decision')
    act(() => panel.root.findByProps({ 'aria-label': 'Back to knowledge work memory' }).props.onClick())
    expect(panel.root.findAllByType('button').some((button) => button.props.title === other)).toBe(false)
    expect(panel.root.findByProps({ title: other }).props.onClick).toBeUndefined()
  })

  it('says when knowledge work has no selected sources this turn', () => {
    emit(reply(load.mock.calls[0]![1]))
    act(() => panel.update(<ProjectMemoryPanel {...props()} memoryScope="knowledge" />))
    expect(content()).toContain('No memories selected this turn')
    expect(content()).not.toContain('Runtime decisions')
  })

  it('shows empty and incomplete results honestly', () => {
    emit({ ...reply(load.mock.calls[0]![1]), files: [], truncated: false })
    expect(content()).toContain('No project memories saved yet')
    emit({ ...reply(load.mock.calls[0]![1]), files: [], truncated: true })
    expect(content()).toContain('No project memory files could be loaded')
    expect(content()).not.toContain('Some memories could not be included')
    expect(content()).not.toContain('No project memories saved yet')
  })

  it('shows a correlated error and retries with a new request', () => {
    const requestId = load.mock.calls[0]![1]
    emit({ type: 'notice', requestId, kind: 'error', text: 'Cannot read memory' })
    expect(content()).toContain('Cannot read memory')
    act(() => panel.root.findAllByType('button').find((button) => button.children.includes('Retry'))!.props.onClick())
    expect(load).toHaveBeenCalledTimes(2)
    expect(load.mock.calls[1]![1]).not.toBe(requestId)
    emit(reply(requestId))
    expect(content()).not.toContain('A remembered decision')
  })

  it("shows a project thread's conversation summary above the project folder, read-only", () => {
    emit(reply(load.mock.calls[0]![1]))
    expect(content()).not.toContain('Conversation summary')
    const loadSummary = vi.fn((_chatId: string, _requestId: string) => true)
    act(() => panel.update(<ProjectMemoryPanel {...props()} summaryChatId="thread" onLoadSummary={loadSummary} />))
    expect(loadSummary).toHaveBeenCalledTimes(1)
    expect(loadSummary.mock.calls[0]![0]).toBe('thread')
    const requestId = loadSummary.mock.calls[0]![1]
    expect(content()).toContain('Loading…')
    emit({ type: 'chat_summary', requestId, chatId: 'thread', summary: null })
    expect(content()).toContain('Not summarized yet')
    expect(panel.root.findAllByType('button').some((button) => button.props.title === 'Conversation summary, read-only')).toBe(false)

    emit({
      type: 'chat_summary', requestId, chatId: 'thread', summary: {
        text: 'Corners are always round.', fromEventId: 'evt_1', fromAt: 1, throughEventId: 'evt_9', throughAt: 2, updatedAt: 3,
      },
    })
    const json = content()
    expect(json.indexOf('Conversation summary')).toBeLessThan(json.indexOf('Project folder'))
    expect(json).not.toContain('Corners are always round.')
    act(() => panel.root.findByProps({ title: 'Conversation summary, read-only' }).props.onClick())
    expect(content()).toContain('Corners are always round.')
    expect(content()).toContain('Covers')
    expect(content()).not.toContain('Runtime decisions')
    act(() => panel.root.findByProps({ 'aria-label': 'Back to context' }).props.onClick())
    expect(content()).toContain('Runtime decisions')
    expect(content()).not.toContain('Corners are always round.')
  })

  it('ends loading on timeout and reloads after reconnecting', () => {
    act(() => { vi.advanceTimersByTime(15_000) })
    expect(content()).toContain('took too long')
    act(() => panel.update(<ProjectMemoryPanel {...props()} status="connecting" />))
    expect(content()).toContain('Connect to Manor')
    act(() => panel.update(<ProjectMemoryPanel {...props()} />))
    expect(load).toHaveBeenCalledTimes(2)
  })
})

describe('project memory presentation', () => {
  it('uses index labels and strips routing frontmatter without a model call', () => {
    const response = reply('request')
    expect(projectMemoryTitles(response.files).get('runtime.md')).toBe('Runtime decisions')
    expect(projectMemoryBody(response.files[1]!.content)).toBe('A remembered decision')
  })
})

describe('this-turn selected memory', () => {
  const structured = '/Users/sam/notes/memory/structured/manor/architecture.md'
  const index = '/Users/sam/notes/memory/structured/manor/MEMORY.md'
  const notes = '/Users/sam/notes/memory/projects/manor.md'
  const onDemand = '/Users/sam/notes/memory/structured/feedback_kickoff.md'

  it('keeps injected structured files and drops indexes, notes and on-demand reads', () => {
    expect(selectedMemoryPaths([
      { source: 'injected', path: index },
      { source: 'injected', path: structured },
      { source: 'injected', path: structured },
      { source: 'injected', path: notes },
      { source: 'on_demand', path: onDemand },
    ])).toEqual([structured])
  })

  it('unions every finished persona after the last user message', () => {
    const smith = '/Users/sam/notes/memory/structured/manor/worktrees.md'
    const user = { kind: 'event' as const, event: { type: 'user_message' as const } }
    const sageTurn = { kind: 'turn' as const, memoryTrace: { reads: [{ source: 'injected' as const, path: structured }] } }
    const smithTurn = { kind: 'turn' as const, memoryTrace: { reads: [{ source: 'injected' as const, path: smith }] } }
    const live = { kind: 'turn' as const, live: { turnId: 'turn_3' } }
    expect(lastTurnSelectedMemoryPaths([user, sageTurn, smithTurn])).toEqual([structured, smith])
    expect(lastTurnSelectedMemoryPaths([user, sageTurn, smithTurn, live])).toEqual([structured, smith])
    expect(lastTurnSelectedMemoryPaths([
      sageTurn,
      { kind: 'event', event: { type: 'user_message' } },
      { kind: 'turn' },
    ])).toEqual([])
  })
})
