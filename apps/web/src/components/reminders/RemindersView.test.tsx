import { renderToStaticMarkup } from 'react-dom/server'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Reminder, ReminderList } from '@manor/contracts'
import type { RequestResponse } from '../../useRequest'
import type { RemindersSnapshot } from '@manor/client-runtime/reminders'
import { RemindersSidebar } from './RemindersSidebar'
import { RemindersView } from './RemindersView'

// The test renderer has no DOM: popups render in place, and layout animation stays off.
vi.mock('react-dom', async (original) => ({
  ...(await original<typeof import('react-dom')>()),
  createPortal: (children: unknown) => children,
}))
vi.mock('motion/react', async (original) => {
  const actual = await original<typeof import('motion/react')>()
  const { createElement, forwardRef } = await import('react')
  const plain = new Map<string, unknown>()
  const motion = new Proxy({}, {
    get: (_target, tag: string) => {
      if (!plain.has(tag)) {
        plain.set(tag, forwardRef<unknown, Record<string, unknown>>(
          ({ initial: _i, animate: _a, exit: _e, transition: _t, layout: _l, layoutId: _li, layoutScroll: _ls, variants: _v, ...props }, ref) =>
            createElement(tag, { ...props, ref }),
        ))
      }
      return plain.get(tag)
    },
  })
  const Reorder = {
    Group: forwardRef<unknown, Record<string, unknown>>(({ as, axis: _a, values: _v, onReorder: _o, ...props }, ref) =>
      createElement(as as string, { ...props, ref })),
    Item: ({ as, value: _v, layout: _l, drag: _d, dragListener: _dl, dragControls: _dc, dragConstraints: _dn, dragElastic: _de, dragMomentum: _dm, dragTransition: _dt, transition: _t, onDragEnd: _e, onDragTransitionEnd: _te, ...props }: Record<string, unknown>) =>
      createElement(as as string, props),
  }
  return { ...actual, motion, Reorder, AnimatePresence: ({ children }: { children: unknown }) => children, useReducedMotion: () => true }
})

const todo: ReminderList = {
  id: 'todo',
  title: 'To do',
  shared: true,
  open: 2,
  sections: [{ id: 'week', title: 'Prioriteit deze week' }, { id: 'wish', title: 'Wishlist' }],
  sharees: [],
}

const snapshot = (extra: Partial<RemindersSnapshot> = {}): RemindersSnapshot => ({
  type: 'reminders_state',
  status: 'ready',
  source: 'remctl',
  revision: 'r1',
  today: '2026-09-30',
  groups: [],
  lists: [todo],
  reminders: [
    { id: 'a', title: 'Paint the hall', listId: 'todo', completed: false, flagged: true, priority: 'none', tags: [], sectionId: 'week' },
    { id: 'b', title: 'New bike', listId: 'todo', completed: false, flagged: false, priority: 'none', tags: [], sectionId: 'wish' },
  ],
  completedCount: 12,
  ...extra,
})

const render = (state: RemindersSnapshot | null, stored: unknown) => {
  vi.stubGlobal('window', {
    addEventListener: () => {},
    removeEventListener: () => {},
    localStorage: { getItem: (key: string) => (key === 'manor:reminders-scope' ? JSON.stringify(stored) : null), setItem: () => {} },
  })
  return renderToStaticMarkup(
    <RemindersView
      reminders={{ available: true, snapshot: state, completed: null }}
      status="live"
      requestEvents={{ subscribe: () => () => {} }}
      sidebarCollapsed={false}
      sidebarSlot={null}
      onLoad={() => true}
      onLoadCompleted={() => true}
      onWrite={() => true}
    />,
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('Reminders door', () => {
  it('shows a list by its sections, reading and not an empty grid while nothing is loaded', () => {
    expect(render(null, { kind: 'list', listId: 'todo' })).toContain('Reading Reminders…')
    const html = render(snapshot(), { kind: 'list', listId: 'todo' })
    expect(html).toContain('Prioriteit deze week')
    expect(html).toContain('Paint the hall')
    expect(html).toContain('aria-label="Complete “New bike”"')
  })

  it('says why when Reminders cannot be read at all', () => {
    const html = render(snapshot({ status: 'unavailable', notice: 'RemCTL could not read Reminders.' }), { kind: 'tile', tile: 'today' })
    expect(html).toContain('Reminders could not be read')
    expect(html).toContain('RemCTL could not read Reminders.')
  })

  it('in plain mode drops the private tiles and sections and says so once', () => {
    const html = renderToStaticMarkup(
      <RemindersSidebar
        scope={{ kind: 'tile', tile: 'today' }}
        counts={{ today: 0, scheduled: 0, flagged: 0, assigned: 0, all: 2 }}
        completedCount={null}
        groups={[]}
        lists={[todo]}
        sectionCounts={new Map()}
        plain
        notice="RemCTL could not read Reminders."
        onScope={() => {}}
      />,
    )
    expect(html).not.toContain('Flagged')
    expect(html).not.toContain('Assigned to me')
    expect(html).not.toContain('Prioriteit deze week')
    expect(html).toContain('Sections, assignees, flags, tags and subtasks are unavailable right now.')
  })
})

describe('Reminders door writes', () => {
  it('keeps a confirmed delete out of Completed until a page without it arrives, and re-reads it', () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      addEventListener: () => {},
      removeEventListener: () => {},
      setInterval, clearInterval, setTimeout, clearTimeout,
      localStorage: { getItem: (key: string) => (key === 'manor:reminders-scope' ? JSON.stringify({ kind: 'tile', tile: 'completed' }) : null), setItem: () => {} },
    })
    vi.stubGlobal('document', { visibilityState: 'visible' })
    const done: Reminder = { id: 'old', title: 'Old errand', listId: 'chores', completed: true, flagged: false, priority: 'none', tags: [] }
    const chores: ReminderList = { id: 'chores', title: 'Chores', shared: false, open: 0, sections: [], sharees: [] }
    const state = snapshot({ lists: [chores], reminders: [] })
    let answer: (response: RequestResponse) => void = () => {}
    const onLoadCompleted = vi.fn(() => true)
    const onWrite = vi.fn((_requestId: string) => true)
    let view: ReactTestRenderer | undefined
    const door = (reminders: Parameters<typeof RemindersView>[0]['reminders']) => (
      <RemindersView
        reminders={reminders}
        status="live"
        requestEvents={{ subscribe: (listener) => { answer = listener; return () => {} } }}
        sidebarCollapsed={false}
        sidebarSlot={null}
        onLoad={() => true}
        onLoadCompleted={onLoadCompleted}
        onWrite={onWrite}
      />
    )
    const page = { reminders: [done], total: 1, nextOffset: null }
    act(() => { view = create(door({ available: true, snapshot: state, completed: page })) })
    const rows = () => view!.root.findAllByProps({ 'data-reminder-row': 'old' })
    const deleteButton = () => view!.root.findAllByType('button').find((button) => button.children.includes('Delete'))!
    act(() => rows()[0]!.props.onClick())
    act(() => deleteButton().props.onClick())
    act(() => deleteButton().props.onClick())
    const requestId = onWrite.mock.calls[0]![0]
    expect(rows()).toHaveLength(0)

    // The answer asks for page one again; until it lands the stale page stays filtered.
    const reads = onLoadCompleted.mock.calls.length
    act(() => answer({ type: 'ack', requestId }))
    expect(onLoadCompleted.mock.calls.length).toBe(reads + 1)
    act(() => { vi.advanceTimersByTime(10_000) })
    expect(rows()).toHaveLength(0)
    act(() => view!.update(door({ available: true, snapshot: { ...state, revision: 'r2' }, completed: page })))
    expect(rows()).toHaveLength(0)
    act(() => view!.update(door({ available: true, snapshot: { ...state, revision: 'r2' }, completed: { reminders: [], total: 0, nextOffset: null } })))
    expect(rows()).toHaveLength(0)
    act(() => view!.unmount())
  })

  it('re-reads Completed on focus and on the poll, since the fallback revision does not cover it', () => {
    vi.useFakeTimers()
    const listeners = new Map<string, () => void>()
    vi.stubGlobal('window', {
      addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
      removeEventListener: () => {},
      setInterval, clearInterval, setTimeout, clearTimeout,
      localStorage: { getItem: (key: string) => (key === 'manor:reminders-scope' ? JSON.stringify({ kind: 'tile', tile: 'completed' }) : null), setItem: () => {} },
    })
    vi.stubGlobal('document', { visibilityState: 'visible' })
    const onLoadCompleted = vi.fn(() => true)
    let view: ReactTestRenderer | undefined
    act(() => {
      view = create(
        <RemindersView
          reminders={{ available: true, snapshot: snapshot({ source: 'eventkit', reminders: [] }), completed: { reminders: [], total: 0, nextOffset: null } }}
          status="live"
          requestEvents={{ subscribe: () => () => {} }}
          sidebarCollapsed={false}
          sidebarSlot={null}
          onLoad={() => true}
          onLoadCompleted={onLoadCompleted}
          onWrite={() => true}
        />,
      )
    })
    expect(onLoadCompleted).toHaveBeenCalledTimes(1)
    act(() => listeners.get('focus')!())
    act(() => { vi.advanceTimersByTime(30_000) })
    expect(onLoadCompleted).toHaveBeenCalledTimes(3)
    act(() => view!.unmount())
  })

  it('keeps a selected new reminder open when its answer and its real row land together', () => {
    vi.stubGlobal('window', {
      addEventListener: () => {},
      removeEventListener: () => {},
      setInterval, clearInterval, setTimeout, clearTimeout,
      localStorage: { getItem: (key: string) => (key === 'manor:reminders-scope' ? JSON.stringify({ kind: 'tile', tile: 'all' }) : null), setItem: () => {} },
    })
    vi.stubGlobal('document', { visibilityState: 'visible' })
    const chores: ReminderList = { id: 'chores', title: 'Chores', shared: false, open: 0, sections: [], sharees: [] }
    const state = snapshot({ lists: [chores], reminders: [] })
    const onWrite = vi.fn((_requestId: string) => true)
    let answer: (response: RequestResponse) => void = () => {}
    let view: ReactTestRenderer | undefined
    const door = (current: RemindersSnapshot) => (
      <RemindersView
        reminders={{ available: true, snapshot: current, completed: null }}
        status="live"
        requestEvents={{ subscribe: (listener) => { answer = listener; return () => {} } }}
        sidebarCollapsed={false}
        sidebarSlot={null}
        onLoad={() => true}
        onLoadCompleted={() => true}
        onWrite={onWrite}
      />
    )
    act(() => { view = create(door(state)) })
    act(() => view!.root.findAllByType('button').find((button) => button.children.includes('New reminder'))!.props.onClick())
    const input = () => view!.root.findAllByType('input').find((node) => node.props['aria-label'] === 'New reminder')!
    act(() => input().props.onChange({ target: { value: 'Created' } }))
    act(() => input().props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: false }, preventDefault() {} }))
    const requestId = onWrite.mock.calls[0]![0]
    act(() => view!.root.findByProps({ 'data-reminder-row': `pending:${requestId}` }).props.onClick())
    expect(view!.root.findAllByProps({ 'aria-label': 'Title' })).toHaveLength(1)

    const real: Reminder = { id: 'real', title: 'Created', listId: 'chores', completed: false, flagged: false, priority: 'none', tags: [] }
    act(() => {
      view!.update(door({ ...state, revision: 'r2', reminders: [real] }))
      answer({ type: 'ack', requestId })
    })
    expect(view!.root.findAllByProps({ 'aria-label': 'Title' })).toHaveLength(1)
    expect(view!.root.findAllByProps({ 'data-reminder-row': 'real' }).length).toBeGreaterThan(0)
    act(() => view!.unmount())
  })

  it('adds from the foot of a section column into that section, and shows no saving state', () => {
    vi.stubGlobal('window', {
      addEventListener: () => {},
      removeEventListener: () => {},
      setInterval, clearInterval, setTimeout, clearTimeout,
      localStorage: {
        getItem: (key: string) => key === 'manor:reminders-scope' ? JSON.stringify({ kind: 'list', listId: 'todo' })
          : key === 'manor:reminders-layouts' ? JSON.stringify({ 'list:todo': 'columns' }) : null,
        setItem: () => {},
      },
    })
    vi.stubGlobal('document', { visibilityState: 'visible' })
    const onWrite = vi.fn((_requestId: string, _action: unknown) => true)
    let view: ReactTestRenderer | undefined
    act(() => {
      view = create(
        <RemindersView
          reminders={{ available: true, snapshot: snapshot(), completed: null }}
          status="live"
          requestEvents={{ subscribe: () => () => {} }}
          sidebarCollapsed={false}
          sidebarSlot={null}
          onLoad={() => true}
          onLoadCompleted={() => true}
          onWrite={onWrite}
        />,
      )
    })
    const wishlist = view!.root.findByProps({ 'aria-label': 'Wishlist' })
    act(() => wishlist.findAllByType('button').find((button) => button.children.includes('Add reminder'))!.props.onClick())
    const input = () => view!.root.findByProps({ 'aria-label': 'Wishlist' }).findByProps({ 'aria-label': 'New reminder' })
    act(() => input().props.onChange({ target: { value: 'Tent' } }))
    act(() => input().props.onKeyDown({ key: 'Enter', nativeEvent: { isComposing: false }, preventDefault() {} }))
    expect(onWrite.mock.calls[0]![1]).toEqual({ kind: 'create', listId: 'todo', title: 'Tent', changes: { sectionId: 'wish' } })
    // The new card shows in the column at once, before Reminders answers.
    expect(view!.root.findByProps({ 'aria-label': 'Wishlist' }).findAll((node) => node.children.includes('Tent')).length).toBeGreaterThan(0)
    expect(JSON.stringify(view!.toJSON())).not.toContain('Saving')
    act(() => view!.unmount())
  })

  it('moves a dragged card between columns without touching the saved column order', () => {
    const set = vi.fn()
    vi.stubGlobal('window', {
      addEventListener: () => {},
      removeEventListener: () => {},
      setInterval, clearInterval, setTimeout, clearTimeout,
      localStorage: {
        getItem: (key: string) => key === 'manor:reminders-scope' ? JSON.stringify({ kind: 'list', listId: 'todo' })
          : key === 'manor:reminders-layouts' ? JSON.stringify({ 'list:todo': 'columns' })
          : key === 'manor:reminders-section-orders' ? JSON.stringify({ todo: ['wish', 'week'] }) : null,
        setItem: set,
      },
    })
    vi.stubGlobal('document', { visibilityState: 'visible' })
    const onWrite = vi.fn((_requestId: string, _action: unknown) => true)
    let view: ReactTestRenderer | undefined
    act(() => {
      view = create(
        <RemindersView
          reminders={{ available: true, snapshot: snapshot(), completed: null }}
          status="live"
          requestEvents={{ subscribe: () => () => {} }}
          sidebarCollapsed={false}
          sidebarSlot={null}
          onLoad={() => true}
          onLoadCompleted={() => true}
          onWrite={onWrite}
        />,
      )
    })
    const titles = () => view!.root.findAllByType('section').flatMap((section) => section.props['aria-label'] ?? [])
    expect(titles()).toEqual(['Wishlist', 'Prioriteit deze week'])

    const column = (title: string) => view!.root.findByProps({ 'aria-label': title })
    const dataTransfer = { setData: vi.fn(), effectAllowed: '', dropEffect: '' }
    const card = column('Prioriteit deze week').findAllByType('li').find((item) => item.props.draggable === true)!
    act(() => card.props.onDragStart({ dataTransfer }))
    const over = { preventDefault: vi.fn(), dataTransfer }
    act(() => column('Wishlist').findByType('section').props.onDragOver(over))
    expect(over.preventDefault).toHaveBeenCalled()
    act(() => column('Wishlist').findByType('section').props.onDrop({ preventDefault() {} }))

    expect(onWrite.mock.calls[0]![1]).toEqual({ kind: 'update', id: 'a', changes: { sectionId: 'wish' } })
    expect(titles()).toEqual(['Wishlist', 'Prioriteit deze week'])
    expect(set.mock.calls.filter(([key]) => key === 'manor:reminders-section-orders')).toEqual([])
    act(() => view!.unmount())
  })

  const withOrders = (extra: Record<string, unknown>, set: (key: string, value: string) => void) => {
    vi.stubGlobal('window', {
      addEventListener: () => {},
      removeEventListener: () => {},
      setInterval, clearInterval, setTimeout, clearTimeout,
      localStorage: {
        getItem: (key: string) => key in extra ? JSON.stringify(extra[key]) : null,
        setItem: set,
      },
    })
    vi.stubGlobal('document', { visibilityState: 'visible' })
  }
  const door = (state: RemindersSnapshot) => (
    <RemindersView
      reminders={{ available: true, snapshot: state, completed: null }}
      status="live"
      requestEvents={{ subscribe: () => () => {} }}
      sidebarCollapsed={false}
      sidebarSlot={null}
      onLoad={() => true}
      onLoadCompleted={() => true}
      onWrite={() => true}
    />
  )
  const sectioned = (...ids: string[]) => snapshot({ lists: [{ ...todo, sections: ids.map((id) => ({ id, title: id })) }] })

  it('brings a saved column order up to date on each read, but never against one without sections', () => {
    const set = vi.fn()
    withOrders({ 'manor:reminders-section-orders': { todo: ['wish', 'gone', 'week'] } }, set)
    const orders = () => set.mock.calls.flatMap(([key, value]) => key === 'manor:reminders-section-orders' ? [JSON.parse(value).todo] : [])
    let view: ReactTestRenderer | undefined
    act(() => { view = create(door(snapshot({ source: 'eventkit', lists: [{ ...todo, sections: [] }] }))) })
    expect(orders()).toEqual([])

    act(() => view!.update(door(sectioned('week', 'wish'))))
    act(() => view!.update(door(sectioned('week', 'wish', 'c'))))
    act(() => view!.update(door(sectioned('d', 'week', 'wish', 'c'))))
    expect(orders()).toEqual([['wish', 'week'], ['wish', 'week', 'c'], ['wish', 'week', 'c', 'd']])

    act(() => view!.update(door(sectioned('d', 'week', 'wish', 'c'))))
    expect(orders()).toHaveLength(3)
    act(() => view!.unmount())
  })

  it('keeps a section that arrives during a column drag in its saved place', () => {
    withOrders({
      'manor:reminders-scope': { kind: 'list', listId: 'todo' },
      'manor:reminders-layouts': { 'list:todo': 'columns' },
      'manor:reminders-section-orders': { todo: ['wish', 'week'] },
    }, () => {})
    let view: ReactTestRenderer | undefined
    act(() => { view = create(door(sectioned('week', 'wish'))) })
    const titles = () => view!.root.findAllByType('section').flatMap((section) => section.props['aria-label'] ?? [])
    act(() => view!.root.findAll((node) => node.type === 'section' && node.props['aria-label'] === 'wish')[0]!.props.onDragStart())
    act(() => view!.update(door(sectioned('week', 'wish', 'c'))))
    act(() => view!.update(door(sectioned('d', 'week', 'wish', 'c'))))
    expect(titles()).toEqual(['wish', 'week', 'c', 'd'])
    act(() => view!.unmount())
  })
})
