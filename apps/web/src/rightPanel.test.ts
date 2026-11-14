import { describe, expect, test } from 'vitest'
import {
  LIST_PANEL_WIDTH,
  dropAt,
  layoutFromKey,
  layoutKey,
  movedPanel,
  rightRegionWidth,
  storedPanels,
  tileCardBox,
  tileRowSpan,
  toggledPanels,
  type PanelLayout,
} from './useRightPanel'

const none = { files: false, knowledge: false, browser: false }

describe('the right panel slot', () => {
  test('reads a stored runs choice back as itself', () => {
    expect(storedPanels('runs')).toEqual({ open: true, layout: [['runs']] })
    expect(storedPanels('none:runs')).toEqual({ open: false, layout: [['runs']] })
  })

  test('forgets a stored door that no longer exists', () => {
    // A DM's Scheduled tasks moved into Agent settings (2026-11-14).
    expect(storedPanels('routines')).toEqual({ open: true, layout: [['agents']] })
  })

  test('a first visit opens on the roster, or on nothing where the chat starts closed', () => {
    expect(storedPanels(null)).toEqual({ open: true, layout: [['agents']] })
    expect(storedPanels(null, false)).toEqual({ open: false, layout: [['agents']] })
    // The door still opens the panel from there, and closing it again leaves it closed.
    const opened = toggledPanels(storedPanels(null, false), [], 'agents')
    expect(opened).toEqual({ open: true, layout: [['agents']] })
    expect(toggledPanels(opened, opened.layout, 'agents')).toEqual({ open: false, layout: [['agents']] })
    // A remembered choice outranks the default either way.
    expect(storedPanels('agents', false)).toEqual({ open: true, layout: [['agents']] })
  })

  test('the diff from Changes takes the Session panel\'s place, and closing it leaves the region closed', () => {
    const session = { open: true, layout: [['agents']] as PanelLayout }
    const diff = toggledPanels(session, session.layout, 'diff', 'agents')
    expect(diff).toEqual({ open: true, layout: [['diff']] })
    expect(toggledPanels(diff, diff.layout, 'diff')).toEqual({ open: false, layout: [['diff']] })
    // In a full region it takes the slot the Session panel leaves, the others staying put.
    const four = { open: true, layout: [['agents', 'files'], ['side', 'browser']] as PanelLayout }
    expect(toggledPanels(four, four.layout, 'diff', 'agents').layout).toEqual([['files', 'diff'], ['side', 'browser']])
  })

  test('keeps runs on its fixed room and gives memory the shared one', () => {
    expect(rightRegionWidth('runs', 500, none)).toBe(LIST_PANEL_WIDTH)
    expect(rightRegionWidth('memory', 500, none)).toBe(500)
  })
})

describe('moving a panel by dragging its tile', () => {
  const two: PanelLayout = [['files', 'side'], ['agents']]

  test('swaps two panels in place, across columns and within one', () => {
    expect(movedPanel(two, 'files', 'agents', 'swap')).toEqual([['agents', 'side'], ['files']])
    expect(movedPanel([['files', 'side']], 'side', 'files', 'swap')).toEqual([['side', 'files']])
  })

  test('stacks a panel above or below one that has its column to itself', () => {
    expect(movedPanel(two, 'side', 'agents', 'above')).toEqual([['files'], ['side', 'agents']])
    expect(movedPanel(two, 'side', 'agents', 'below')).toEqual([['files'], ['agents', 'side']])
  })

  test('opens a new column beside a single one, and lets an emptied column go', () => {
    expect(movedPanel([['files', 'side']], 'side', 'files', 'right')).toEqual([['files'], ['side']])
    expect(movedPanel([['files'], ['side']], 'files', 'side', 'above')).toEqual([['files', 'side']])
    expect(movedPanel(two, 'agents', 'files', 'left')).toEqual([['agents'], ['files', 'side']])
  })

  test('refuses what would break two columns of two, or change nothing', () => {
    const full: PanelLayout = [['files', 'side'], ['agents', 'browser']]
    expect(movedPanel(full, 'files', 'agents', 'above')).toBe(full)
    expect(movedPanel(full, 'files', 'agents', 'left')).toBe(full)
    expect(movedPanel(two, 'files', 'side', 'above')).toBe(two)
    expect(movedPanel(two, 'files', 'files', 'swap')).toBe(two)
    expect(dropAt(full, 'files', 'agents', 0.1, 0.1)).toBe('swap')
  })

  test('survives the round trip through storage', () => {
    const moved = movedPanel(two, 'side', 'agents', 'below')
    expect(layoutFromKey(layoutKey(moved))).toEqual(moved)
    expect(storedPanels(layoutKey(moved))).toEqual({ open: true, layout: moved })
  })
})

describe('where a moved panel will be drawn', () => {
  // The cards a 1000px-tall region drew in the browser: two 504px columns, each card
  // 12px in from the top, right and bottom, 12px between two stacked cards.
  test('matches the cards the region draws', () => {
    const layout: PanelLayout = [['side', 'agents'], ['knowledge']]
    const at = (id: 'side' | 'agents' | 'knowledge') => tileCardBox(layout, id, [504, 504], [0.5, 0.5], 1000, 12)
    expect(at('side')).toEqual({ left: 0, top: 12, width: 492, height: 482 })
    expect(at('agents')).toEqual({ left: 0, top: 506, width: 492, height: 482 })
    expect(at('knowledge')).toEqual({ left: 504, top: 12, width: 492, height: 976 })
  })

  test('follows a dragged split and unequal columns rather than halves', () => {
    const layout: PanelLayout = [['files'], ['side', 'agents']]
    expect(tileCardBox(layout, 'agents', [600, 360], [0.5, 0.3], 1000, 12)).toEqual({ left: 600, top: 306, width: 348, height: 682 })
  })

  // The row's box and its first column's start, back from the grid's right edge, which does not move.
  test('places the columns where a floating, scrolled row draws them', () => {
    expect(tileRowSpan([400, 300], false, 1400, 0, 12)).toEqual({ box: 700, start: 700 })
    // Floating with room: the gutter sits left of the columns, nothing scrolls.
    expect(tileRowSpan([400, 300], true, 900, 0, 12)).toEqual({ box: 712, start: 700 })
    // Too wide for 500px: the box is 500 wide and scrolled 112 of its 212 spare pixels.
    expect(tileRowSpan([350, 350], true, 500, 112, 12)).toEqual({ box: 500, start: 600 })
    // A move to one column leaves less to scroll, and the browser clamps what was scrolled.
    expect(tileRowSpan([350], true, 500, 112, 12)).toEqual({ box: 362, start: 350 })
  })
})
