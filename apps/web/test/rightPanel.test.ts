import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENTS_PANEL_WIDTH,
  LIST_PANEL_WIDTH,
  clampedSplit,
  columnSizingPanel,
  layoutFromKey,
  offeredLayout,
  rightPanelShortcut,
  rightRegionWidth,
  storedPanels,
  tiledColumnWidths,
  toggledPanels,
  useRightPanel,
  withPanel,
  withoutPanel,
  type PanelLayout,
  type RightPanelId,
} from '../src/useRightPanel'

describe('independent thread panels', () => {
  let view: ReactTestRenderer
  let panel: ReturnType<typeof useRightPanel>
  function Probe({ focused, compact = false }: { focused: string; compact?: boolean }) {
    panel = useRightPanel(focused, compact)
    return null
  }
  beforeEach(() => {
    vi.stubGlobal('window', {
      localStorage: { getItem: () => null, setItem: vi.fn() },
      addEventListener: vi.fn(), removeEventListener: vi.fn(),
    })
  })
  afterEach(() => {
    act(() => view?.unmount())
    vi.unstubAllGlobals()
  })

  it.each([false, true])('keeps both chats\' panels across focus and closes only its target (compact=%s)', (compact) => {
    act(() => { view = create(createElement(Probe, { focused: 'left', compact })) })
    act(() => {
      panel.showFor('left', 'memory')
      panel.showFor('right', 'files')
    })
    // Wide, a shown panel stacks under the roster a first visit opens on; compact, it replaces it.
    expect(panel.layoutFor('left')).toEqual(compact ? [['memory']] : [['agents', 'memory']])
    expect(panel.layoutFor('right')).toEqual(compact ? [['files']] : [['agents', 'files']])
    act(() => view.update(createElement(Probe, { focused: 'right', compact })))
    expect(panel.layout).toEqual(panel.layoutFor('right'))
    act(() => panel.closeFor('left', 'memory'))
    expect(panel.layoutFor('left')).toEqual(compact ? [] : [['agents']])
    expect(panel.layoutFor('right')).toEqual(compact ? [['files']] : [['agents', 'files']])
    act(() => panel.toggle())
    expect(panel.layoutFor('right')).toEqual([])
    act(() => panel.toggle())
    expect(panel.layoutFor('right')).toEqual(compact ? [['files']] : [['agents', 'files']])
  })

  it.each([false, true])('keeps a panel closed in A after a visit to B and back (compact=%s)', (compact) => {
    act(() => { view = create(createElement(Probe, { focused: 'a', compact })) })
    act(() => { panel.showFor('a', 'knowledge'); panel.showFor('b', 'knowledge') })
    act(() => panel.closeFor('a', 'knowledge'))
    act(() => view.update(createElement(Probe, { focused: 'b', compact })))
    expect(panel.layout.flat()).toContain('knowledge')
    act(() => view.update(createElement(Probe, { focused: 'a', compact })))
    expect(panel.layout.flat()).not.toContain('knowledge')
    expect(panel.layoutFor('b').flat()).toContain('knowledge')
  })

  it('opens a door on a hidden region as that panel alone, and closes the last one back to hidden', () => {
    act(() => { view = create(createElement(Probe, { focused: 'chat' })) })
    act(() => panel.toggle())
    expect(panel.layout).toEqual([])
    act(() => panel.toggleFor('chat', 'files'))
    expect(panel.layout).toEqual([['files']])
    act(() => panel.toggleFor('chat', 'browser'))
    expect(panel.layout).toEqual([['files', 'browser']])
    act(() => panel.toggleFor('chat', 'files'))
    act(() => panel.toggleFor('chat', 'browser'))
    expect(panel.layout).toEqual([])
    // ⌘B brings back the last panel out rather than the default roster.
    act(() => panel.toggle())
    expect(panel.layout).toEqual([['browser']])
  })
})

/** Opens each panel in turn, the way a person pressing doors would. */
const opened = (...ids: RightPanelId[]) => ids.reduce<PanelLayout>((layout, id) => withPanel(layout, id), [])

describe('the panel layout', () => {
  // The five Claude Code screenshots this was built against, in order.
  it('stacks the second panel, starts a column with the third, stacks the fourth', () => {
    expect(opened('side')).toEqual([['side']])
    expect(opened('side', 'browser')).toEqual([['side', 'browser']])
    expect(opened('side', 'browser', 'files')).toEqual([['side', 'browser'], ['files']])
    expect(opened('side', 'browser', 'files', 'knowledge')).toEqual([['side', 'browser'], ['files', 'knowledge']])
  })

  it('leaves the survivors where they were when the lower panels close', () => {
    const four = opened('side', 'browser', 'files', 'knowledge')
    expect(withoutPanel(withoutPanel(four, 'browser'), 'knowledge')).toEqual([['side'], ['files']])
    // The next panel fills the first free slot, under the first column.
    expect(withPanel([['side'], ['files']], 'memory')).toEqual([['side', 'memory'], ['files']])
    // A column that empties goes, and the other keeps its panels in order.
    expect(withoutPanel([['side'], ['files', 'memory']], 'side')).toEqual([['files', 'memory']])
    expect(withoutPanel([['side', 'browser'], ['files']], 'side')).toEqual([['browser'], ['files']])
  })

  it('places Agents like any panel, with room for one under it', () => {
    expect(opened('agents')).toEqual([['agents']])
    expect(opened('side', 'agents')).toEqual([['side', 'agents']])
    expect(opened('agents', 'side')).toEqual([['agents', 'side']])
    expect(opened('side', 'files', 'agents', 'browser')).toEqual([['side', 'files'], ['agents', 'browser']])
  })

  it('opens the diff in a column of its own on the chat side of the Session panel', () => {
    expect(withPanel([['agents']], 'diff')).toEqual([['diff'], ['agents']])
    expect(withPanel([['agents', 'files']], 'diff')).toEqual([['diff'], ['agents', 'files']])
    expect(withPanel([], 'diff')).toEqual([['diff']])
    // Two columns already: the others share one, so the diff still has its own.
    expect(withPanel([['agents'], ['files']], 'diff')).toEqual([['diff'], ['agents', 'files']])
    // Three panels: never under Session; a full neighbour moves its second panel under Session.
    expect(withPanel([['agents'], ['files', 'browser']], 'diff')).toEqual([['agents', 'browser'], ['files', 'diff']])
    expect(withPanel([['agents', 'files'], ['browser']], 'diff')).toEqual([['agents', 'files'], ['browser', 'diff']])
    // Closing it gives the Session panel its column back as it was.
    expect(withoutPanel([['diff'], ['agents']], 'diff')).toEqual([['agents']])
  })

  it('stops at four without replacing anything', () => {
    const four = opened('side', 'browser', 'files', 'knowledge')
    expect(withPanel(four, 'memory')).toBe(four)
    expect(withPanel(four, 'agents')).toBe(four)
    expect(withPanel(four, 'side')).toBe(four)
  })

  it('toggles against what is on screen, not what is stored', () => {
    const stored = { open: true, layout: [['files']] as PanelLayout }
    // A chat that cannot browse shows the roster in Files' place; its door closes the roster.
    expect(toggledPanels(stored, [['agents']], 'agents')).toEqual({ open: false, layout: [['agents']] })
    expect(toggledPanels(stored, [['agents']], 'side')).toEqual({ open: true, layout: [['agents', 'side']] })
    expect(toggledPanels({ open: false, layout: [['files', 'side']] }, [], 'browser')).toEqual({ open: true, layout: [['browser']] })
  })

  it('shows what a chat offers in place, and the roster when nothing remembered is offered', () => {
    const layout: PanelLayout = [['files', 'side'], ['browser']]
    expect(offeredLayout(layout, ['side', 'browser', 'agents'])).toEqual([['side'], ['browser']])
    expect(offeredLayout([['files']], ['side', 'agents'])).toEqual([['agents']])
    expect(offeredLayout([['files']], ['side'])).toEqual([])
    expect(offeredLayout(layout, ['files', 'side', 'browser'])).toBe(layout)
  })

  it('drops a remembered side chat from a DM, whose rail no longer has the door', () => {
    const dmDoors = ['knowledge', 'browser', 'agent'] as const
    expect(offeredLayout([['side'], ['agent']], dmDoors)).toEqual([['agent']])
    expect(offeredLayout([['side']], dmDoors)).toEqual([])
    // Agent memory moved into Agent settings (2026-11-14), so its remembered panel goes too.
    expect(offeredLayout([['memory'], ['agent']], dmDoors)).toEqual([['agent']])
  })
})

describe('the stored layout', () => {
  it('opens on the roster for a first visit or a value it does not recognise', () => {
    expect(storedPanels(null)).toEqual({ open: true, layout: [['agents']] })
    expect(storedPanels('nonsense')).toEqual({ open: true, layout: [['agents']] })
    expect(storedPanels('')).toEqual({ open: true, layout: [['agents']] })
  })

  it('reads a value from the one-panel rail as that panel alone', () => {
    expect(storedPanels('files')).toEqual({ open: true, layout: [['files']] })
    expect(storedPanels('none:browser')).toEqual({ open: false, layout: [['browser']] })
    expect(storedPanels('none')).toEqual({ open: false, layout: [['agents']] })
  })

  it('drops the removed Subagents panel and its stand-in suffix from an older value, keeping the rest', () => {
    expect(storedPanels('files+subagents~subagents>agents')).toEqual({ open: true, layout: [['files']] })
    expect(storedPanels('none:subagents|browser~subagents>agents')).toEqual({ open: false, layout: [['browser']] })
    // Nothing left of it opens on the roster, with no empty column.
    expect(storedPanels('subagents~subagents>agents')).toEqual({ open: true, layout: [['agents']] })
    expect(layoutFromKey('agents|subagents')).toEqual([['agents']])
  })

  it('round-trips a layout, hidden or shown, and repairs one it could not have written', () => {
    expect(storedPanels('side+browser|files')).toEqual({ open: true, layout: [['side', 'browser'], ['files']] })
    expect(storedPanels('none:side|agents')).toEqual({ open: false, layout: [['side'], ['agents']] })
    expect(layoutFromKey('agents+side|side|files+browser+memory')).toEqual([['agents', 'side'], ['files', 'browser']])
    // The roster's old column of its own, poured back into the free slot.
    expect(layoutFromKey('side+files|browser|agents')).toEqual([['side', 'files'], ['browser', 'agents']])
  })
})

describe('tiledColumnWidths', () => {
  it('starts a column from what it holds', () => {
    expect(columnSizingPanel(['side'])).toBe('side')
    expect(columnSizingPanel(['agents', 'files'])).toBe('files')
    expect(columnSizingPanel(['agents'])).toBe('agents')
    expect(columnSizingPanel(['runs', 'agents'])).toBe('runs')
  })

  it('gives each column what it asks for when that fits', () => {
    expect(tiledColumnWidths([500, 412], 3_000)).toEqual({ widths: [500, 412], overlay: false })
  })

  it('squeezes the columns in proportion to keep the chat, then floats them at their floor', () => {
    expect(tiledColumnWidths([574, 574], 1_200)).toEqual({ widths: [412, 412], overlay: false })
    // A column dragged wider stays the wider one; the narrow one stops at the floor.
    expect(tiledColumnWidths([700, 300], 1_000)).toEqual({ widths: [325, 300], overlay: false })
    expect(tiledColumnWidths([574, 574], 900)).toEqual({ widths: [446, 446], overlay: true })
    // Too narrow to float them whole: the floor holds and the row scrolls instead.
    expect(tiledColumnWidths([574, 574], 600)).toEqual({ widths: [300, 300], overlay: true })
  })

  it('keeps both stacked panels above their floor', () => {
    expect(clampedSplit(0.05, 800)).toBe(0.2)
    expect(clampedSplit(0.95, 800)).toBe(0.8)
    expect(clampedSplit(0.3, 800)).toBe(0.3)
    // No room for two floors: an even split.
    expect(clampedSplit(0.9, 300)).toBe(0.5)
  })
})

const press = (
  key: string,
  extra: Partial<Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat'>> = {},
) => ({
  key,
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  ...extra,
})

describe('shortcuts on a chat whose panels are out of sight', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('leaves the panels alone on Cmd+B while blocked and toggles them again once not', () => {
    let keydown: ((event: unknown) => void) | undefined
    vi.stubGlobal('window', {
      localStorage: { getItem: () => null, setItem: vi.fn() },
      addEventListener: (type: string, handler: (event: unknown) => void) => { if (type === 'keydown') keydown = handler },
      removeEventListener: vi.fn(),
    })
    let panel!: ReturnType<typeof useRightPanel>
    let blocked = true
    const Probe = () => {
      panel = useRightPanel('chat', false, true, () => false, () => true, { current: () => blocked })
      return null
    }
    let view!: ReactTestRenderer
    act(() => { view = create(createElement(Probe)) })
    const before = panel.layout
    const preventDefault = vi.fn()
    const press = () => act(() => keydown!({ key: 'b', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false, repeat: false, preventDefault }))
    press()
    expect(panel.layout).toEqual(before)
    expect(preventDefault).not.toHaveBeenCalled()
    blocked = false
    act(() => view.update(createElement(Probe)))
    press()
    expect(panel.layout).toEqual([])
    act(() => view.unmount())
  })
})

describe('rightPanelShortcut', () => {
  it('claims Cmd/Ctrl+; for side chat and keeps Cmd/Ctrl+B as the rail toggle', () => {
    expect(rightPanelShortcut(press(';'))).toBe('side')
    expect(rightPanelShortcut(press(';', { metaKey: false, ctrlKey: true }))).toBe('side')
    expect(rightPanelShortcut(press('b'))).toBe('toggle')
  })

  it('leaves modified, bare and repeated keys alone', () => {
    expect(rightPanelShortcut(press(';', { metaKey: false }))).toBe(null)
    expect(rightPanelShortcut(press(';', { altKey: true }))).toBe(null)
    expect(rightPanelShortcut(press(';', { shiftKey: true }))).toBe(null)
    expect(rightPanelShortcut(press(';', { repeat: true }))).toBe(null)
  })
})

const none = { files: false, knowledge: false, browser: false }

describe('rightRegionWidth', () => {
  it('asks for nothing while the region is away, which is what the slide animates to', () => {
    expect(rightRegionWidth(null, 460, none)).toBe(0)
    expect(rightRegionWidth(null, 460, { ...none, files: true })).toBe(0)
  })

  it('gives every reading panel the one shared width, so switching keeps the edge', () => {
    for (const panel of ['files', 'knowledge', 'browser', 'side', 'memory'] as const) {
      expect(rightRegionWidth(panel, 512, none)).toBe(512)
    }
  })

  it('keeps the roster and the list panels on their own fixed widths', () => {
    expect(rightRegionWidth('agents', 512, none)).toBe(AGENTS_PANEL_WIDTH)
    expect(rightRegionWidth('runs', 512, none)).toBe(LIST_PANEL_WIDTH)
  })

  it('gives an expanded panel no room at all: it is over the stage, not beside it', () => {
    expect(rightRegionWidth('files', 512, { ...none, files: true })).toBe(0)
    expect(rightRegionWidth('browser', 512, { ...none, browser: true })).toBe(0)
    // Expanding Files does not expand its neighbours.
    expect(rightRegionWidth('side', 512, { ...none, files: true })).toBe(512)
  })
})
