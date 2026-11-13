import { useState } from 'react'

/**
 * The panels that dock beside the chat: agents, runs, files, knowledge, browser, side chat.
 *
 * A card in its own gutter rather than a column welded to the rail, because the rail
 * already draws the edge of the stage and a panel that reached it read as part of the
 * window rather than as a thing put next to the conversation. Agents and runs floated
 * first; files and browser followed once the two treatments were on screen together.
 */
const PANEL_CARD = 'overflow-hidden rounded-dock border border-line'
/**
 * The right sidebar's surface: the left sidebar's step with the panel's hairline. Cards
 * in the chat that wait on the user (a question, a proposal, a draft, a plan) wear it too,
 * so on the stage they read as the same kind of thing as the panel beside them. Inside,
 * fills drawn for the stage go one step deeper; a field that has to stay on white asks
 * for `stage`. Each caller adds its own corner.
 */
export const SIDE_SURFACE = 'sidebar-surface border border-line bg-sidebar'
/** On the left sidebar's step, so a side of the stage reads as a side in either room. */
export const DOCK_PANEL_SHELL = `${SIDE_SURFACE} overflow-hidden rounded-dock`
/** The same card standing as a page's main view (the Browser place): the stage's own white. */
export const STAGE_PANEL_SHELL = `${PANEL_CARD} bg-surface`

/**
 * Where a panel floats over a chat too narrow to dock it: never over the chat header,
 * because the header carries the panel doors. On the desktop that header is the
 * window's top bar above the pane, so the card starts at the pane's top edge with the
 * same 8px margin a docked panel keeps. The phone's header still sits in the pane:
 * 46 is its 54 less that margin. Expanded is different: it takes the whole stage, and
 * its own collapse is the way back.
 */
export const DOCK_FLOAT = 'absolute top-0 bottom-0 right-0 z-[8] [@media(max-width:600px)]:top-[46px]'

/**
 * A row inside a docked panel that opens something: the hover it wears and the arrow
 * at its end, quiet until the row is pointed at. The Session panel's Changes row set
 * them and the roster rows beside it follow, so one panel has one kind of row.
 * The row itself carries `group`.
 */
export const PANEL_ROW_HOVER = 'hover:bg-surface-2'
export const PANEL_ROW_ARROW = 'flex-none text-dim group-hover:text-muted'

/** `DOCK_FLOAT`'s desktop top, for anything that has to reason about where a floating row sits. */
export const DOCK_FLOAT_TOP = 0

/** The gutter, for anything that has to reason about the width rather than write it. */
export { DOCK_PANEL_GAP } from '../../useRightPanel'

/**
 * Where a resizable panel sits at its current size.
 *
 * Docked it participates in the right-hand grid; expanded it covers the whole stage.
 * The change between the two is instant (2026-09-27): a full-screen toggle is
 * a mode switch, not a movement, so neither the card nor the chat beside it animates.
 *
 * `dockedWidth` arrives as a finished class because Tailwind generates only the
 * arbitrary values it can read literally in the source; a width composed here from a
 * variable name would name a class nobody ever built.
 */
export function dockPanelLayoutClass(
  dockedWidth: string,
  expanded: boolean,
  overlay = false,
  overlayMaxWidth = 'max-w-[calc(100%-16px)]',
): string {
  const position = expanded ? 'absolute inset-y-0 right-0 z-[8]' : overlay ? DOCK_FLOAT : 'relative'
  return `${position} my-2 mr-2 ${expanded ? 'w-[calc(100%-16px)]' : dockedWidth} ${
    overlay ? `${overlayMaxWidth} dock-panel-reveal` : ''
  }`
}

/**
 * True once a panel's list/detail key has changed since it mounted. The slide between
 * list and detail explains a move inside the panel; on the panel's own arrival there
 * is nothing to explain, so switching to it from the rail lands without motion.
 */
export function useMovedWithin(key: string) {
  const [first] = useState(key)
  const [moved, setMoved] = useState(false)
  if (!moved && key !== first) setMoved(true)
  return moved
}
