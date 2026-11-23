import { useCallback, useEffect, useRef, useState } from 'react'

/** The gutter a docked panel keeps from the stage's edges and from the panel beside it. */
export const DOCK_PANEL_GAP = 8

const KEY = 'manor:right-panel-by-chat'

/** The panels the rail can put in the region beside the chat. */
export type RightPanelId = 'agent' | 'memory' | 'agents' | 'files' | 'browser' | 'runs' | 'side' | 'knowledge' | 'diff' | 'simulator'

/** The rail shortcuts, kept pure so a key cannot quietly steal a native command. */
export function rightPanelShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat'>,
): 'toggle' | 'side' | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.repeat) return null
  if (event.key.toLowerCase() === 'b') return 'toggle'
  if (event.key === ';') return 'side'
  return null
}

/**
 * How long the region takes to open or close, and how long a closed panel keeps its
 * content. The two must match, or the last frames of the slide are an empty box. Same
 * 200ms the sidebar takes on the other side of the chat.
 */
export const RIGHT_PANEL_MOTION_MS = 200

/** The agents card and the padding around it. 372 so the card itself lands on 360. */
export const AGENTS_PANEL_WIDTH = 372
/**
 * Alone, the list panels keep a fixed width of their own and stay out of the shared
 * one: a run, a routine or a helper is one row of text, and dragging it wider only
 * adds air. A little wider than the roster so a preview and its state fit on one row.
 * Beside other panels it is only where their column starts; see `columnDefaultWidth`.
 */
export const LIST_PANEL_WIDTH = 412
/** Agent settings: a column of rows and short fields. 428 so the card itself lands on 420. */
export const AGENT_SETTINGS_WIDTH = 428
/** The transcript floor that decides when a dock becomes an overlay. */
export const CHAT_STAGE_MIN_WIDTH = 375

/**
 * Panels float over the stage only when docking them would make the chat unusable.
 * The decision uses the actual sidebar width, so a collapsed sidebar immediately
 * earns the room back instead of obeying a blunt viewport breakpoint.
 */
export function rightPanelOverlays(
  viewportWidth: number,
  reservedWidth: number,
  panelWidth: number,
) {
  return panelWidth > 0 && viewportWidth - reservedWidth - panelWidth < CHAT_STAGE_MIN_WIDTH
}
/**
 * The narrowest a column may get once several share the region, below the files
 * panel's own 360 floor on purpose: at that floor two columns and the roster no longer
 * dock beside a 375px chat in a 1728px window with the sidebar open, and floating
 * them would bury the whole chat. At 300 files and knowledge show their tree alone and
 * the side chat still reads as a conversation.
 */
export const TILE_MIN_WIDTH = 300

/** The shortest a panel may get when it shares its column with another. */
export const TILE_MIN_HEIGHT = 160

const isList = (id: RightPanelId) => id === 'runs'

/**
 * The panel whose width a column wears: the first one holding anything to read, else
 * the roster or the list it starts with. Only a start for a second column; once
 * several panels share the region every column is the user's to resize.
 */
export function columnSizingPanel(column: readonly RightPanelId[]) {
  return column.find((id) => id !== 'agents' && !isList(id)) ?? column[0]!
}

/**
 * How wide each column is when more than one panel is open, from the widths they ask
 * for. When that does not fit beside a 375px chat the columns give way in proportion,
 * so a column dragged wider stays the wider one, down to `TILE_MIN_WIDTH`; below that
 * they float over the chat (`overlay`) at that floor, and the row scrolls rather than
 * clip a panel.
 */
export function tiledColumnWidths(asked: readonly number[], availableWidth: number) {
  const fit = (room: number) => {
    const total = asked.reduce((sum, width) => sum + width, 0)
    if (total <= room) return [...asked]
    if (room < asked.length * TILE_MIN_WIDTH) return null
    const scaled = asked.map((width) => Math.floor((width * room) / total))
    const floored = scaled.map((width) => Math.max(TILE_MIN_WIDTH, width))
    const over = floored.reduce((sum, width) => sum + width, 0) - room
    if (over <= 0) return floored
    // A column lifted to the floor takes that room from the others, widest first.
    const widest = floored.indexOf(Math.max(...floored))
    return floored.map((width, index) => (index === widest ? width - over : width))
  }
  const docked = fit(availableWidth - CHAT_STAGE_MIN_WIDTH)
  if (docked !== null) return { widths: docked, overlay: false }
  return {
    // The gutter on the far side, so the floating row does not touch the window's edge.
    widths: fit(availableWidth - DOCK_PANEL_GAP) ?? asked.map(() => TILE_MIN_WIDTH),
    overlay: true,
  }
}

/** A column's split as the share its top panel takes, kept so neither panel drops below `TILE_MIN_HEIGHT`. */
export function clampedSplit(share: number, height: number) {
  if (height <= 2 * TILE_MIN_HEIGHT) return 0.5
  const floor = TILE_MIN_HEIGHT / height
  return Math.min(1 - floor, Math.max(floor, share))
}

/** The panels that can take over the whole stage, each remembering that on its own. */
export interface ExpandedPanels {
  files: boolean
  knowledge: boolean
  browser: boolean
}

/**
 * How much room the region takes beside the chat, which is the only thing that moves
 * when a panel opens or closes. An expanded panel is over the whole stage rather
 * than beside it, so it asks for no room at all and the chat slides back to full width
 * underneath it.
 */
export function rightRegionWidth(panel: RightPanelId | null, sharedWidth: number, expanded: ExpandedPanels) {
  if (panel === null) return 0
  if (panel === 'agents') return AGENTS_PANEL_WIDTH
  if (panel === 'runs') return LIST_PANEL_WIDTH
  if ((panel === 'files' || panel === 'knowledge' || panel === 'browser') && expanded[panel]) return 0
  return sharedWidth
}

/**
 * What the region should render right now. A closing region has no active panel but
 * still needs its content until the motion has run, so the last one stays mounted for
 * exactly that long and is then let go, because a panel left mounted behind the rail
 * would keep its file open and its shortcuts bound.
 */
export function useLingeringPanel<Panel extends string>(
  active: Panel | null,
  ms = RIGHT_PANEL_MOTION_MS,
  instant = false,
) {
  const [rendered, setRendered] = useState<Panel | null>(active)

  // During the render rather than in an effect: an opening panel that waited for one
  // would spend the first frame of its own slide empty. `instant` is for the region
  // that is not closing but simply gone, which is what opening another chat does to
  // it: there is no motion to keep content alive for, and a panel left standing in a
  // region of zero width paints outside it.
  if (active !== rendered && (active !== null || instant)) setRendered(active)

  useEffect(() => {
    if (active !== null) return
    const timer = window.setTimeout(() => setRendered(null), ms)
    return () => window.clearTimeout(timer)
  }, [active, ms])

  return rendered
}

/**
 * True while the region is opening, closing or rearranging panels (`panel` is the
 * layout's key). A `WebContentsView`
 * is a native layer painted over the whole window, so it cannot pass behind the rail
 * the way the panel's own chrome does; a page sliding in would cross in front of the
 * rail for the length of the animation. Nothing that cannot be stacked correctly is
 * allowed to move, so the view stands down while the chrome travels and lands when
 * it arrives.
 */
export function useRegionSettling(panel: string | null, ms = RIGHT_PANEL_MOTION_MS) {
  const [settling, setSettling] = useState(false)
  const previous = useRef(panel)
  const changed = previous.current !== panel
  if (changed) previous.current = panel

  // `changed` is deliberately not a dependency. The state update below re-renders
  // immediately; re-running this effect for that would cancel its own timer.
  useEffect(() => {
    if (!changed) return
    setSettling(true)
    const timer = window.setTimeout(() => setSettling(false), ms)
    return () => window.clearTimeout(timer)
  }, [panel, ms])

  // The first changed render happens before the effect above. Returning true on
  // that render keeps the native view from flashing once at its old rectangle.
  return settling || changed
}

/**
 * The panels open beside a chat, as at most two columns of at most two. A new panel
 * takes the first free slot in reading order: under the first panel, then a column of
 * its own, then under that one. Closing a panel only empties its slot, so the panels
 * that stay keep their place instead of the arrangement being worked out again from a
 * count.
 *
 * Agents follows the same order. Alone it is the compact roster card; beside anything
 * else it fills its slot like any panel, and a panel can stack under it.
 */
export type PanelLayout = RightPanelId[][]

/** How many panels may be open beside one chat at once. */
export const MAX_RIGHT_PANELS = 4

export const NO_PANELS: PanelLayout = []

const PANEL_IDS: readonly RightPanelId[] = ['agent', 'memory', 'agents', 'files', 'browser', 'runs', 'side', 'knowledge', 'diff', 'simulator']
const isPanelId = (value: string): value is RightPanelId => (PANEL_IDS as readonly string[]).includes(value)

export const layoutHas = (layout: PanelLayout, id: RightPanelId) => layout.some((column) => column.includes(id))
export const layoutCount = (layout: PanelLayout) => layout.reduce((count, column) => count + column.length, 0)
export const layoutFull = (layout: PanelLayout) => layoutCount(layout) >= MAX_RIGHT_PANELS

/**
 * Adds a panel in the first free slot. At the cap nothing is replaced: the layout is
 * returned as it was. The diff is the exception: it is read beside the other panels, never
 * under them (Changes and a turn's Review first close the Session panel to give it room). Up to two panels open, it takes a column of its own on the chat's
 * side and the others share the second column; with three, it shares the column
 * without the Session panel, and when that one is full its second panel moves under
 * Session to make room.
 */
export function withPanel(layout: PanelLayout, id: RightPanelId): PanelLayout {
  if (layoutHas(layout, id) || layoutFull(layout)) return layout
  if (id === 'diff') {
    const others = layout.flat()
    if (others.length <= 2) return [['diff'], ...(others.length > 0 ? [others] : [])]
    const session = layout.findIndex((column) => column.includes('agents'))
    const [kept, moved] = layout[1 - session] ?? []
    if (session !== -1 && kept !== undefined && moved !== undefined) {
      return layout.map((column, index) => (index === session ? [...column, moved] : [kept, 'diff']))
    }
  }
  const gap = layout.findIndex((column) => column.length < 2)
  if (gap !== -1) return layout.map((column, index) => (index === gap ? [...column, id] : column))
  return [...layout, [id]]
}

/** Empties one slot. A column left with nothing in it goes; the others stay where they are. */
export function withoutPanel(layout: PanelLayout, id: RightPanelId): PanelLayout {
  if (!layoutHas(layout, id)) return layout
  return layout.map((column) => column.filter((panel) => panel !== id)).filter((column) => column.length > 0)
}

/**
 * Where a dragged panel lands on the tile it is dropped on: in its place (`swap`),
 * stacked above or below it in that column, or in a new column on either side.
 */
export type PanelDrop = 'swap' | 'above' | 'below' | 'left' | 'right'

/**
 * Moves one panel onto another's tile. Refused, the layout returned as it was, when
 * the result would break the two-by-two limit or change nothing, so a drop that
 * returns the same layout is one the drag does not offer. A column the panel leaves
 * empty goes, as it does on a close.
 */
export function movedPanel(layout: PanelLayout, id: RightPanelId, target: RightPanelId, drop: PanelDrop): PanelLayout {
  if (id === target || !layoutHas(layout, id) || !layoutHas(layout, target)) return layout
  const next = (() => {
    if (drop === 'swap') {
      return layout.map((column) => column.map((panel) => (panel === id ? target : panel === target ? id : panel)))
    }
    const rest = withoutPanel(layout, id)
    if (drop === 'left' || drop === 'right') {
      if (rest.length > 1) return null
      return drop === 'left' ? [[id], ...rest] : [...rest, [id]]
    }
    const home = rest.findIndex((column) => column.includes(target))
    if (rest[home]!.length > 1) return null
    return rest.map((column, index) => (index !== home ? column : drop === 'above' ? [id, ...column] : [...column, id]))
  })()
  return next === null || layoutKey(next) === layoutKey(layout) ? layout : next
}

/**
 * Which drop a pointer means over a tile, from where it is as a share of the tile's
 * width (`x`) and height (`y`). The side edges make a column, the top and bottom
 * thirds stack, the middle swaps; a drop the layout refuses hands its band to the
 * next one, so a full layout still swaps anywhere on the tile.
 */
export function dropAt(layout: PanelLayout, id: RightPanelId, target: RightPanelId, x: number, y: number): PanelDrop | null {
  const offered = (drop: PanelDrop) => movedPanel(layout, id, target, drop) !== layout
  const side: PanelDrop | null = x < 0.25 ? 'left' : x > 0.75 ? 'right' : null
  if (side !== null && offered(side)) return side
  const stack: PanelDrop | null = y < 1 / 3 ? 'above' : y > 2 / 3 ? 'below' : null
  if (stack !== null && offered(stack)) return stack
  return offered('swap') ? 'swap' : null
}

/** A rectangle on screen or in the region, in CSS pixels. */
export interface TileBox {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Where a panel's card is drawn in a tiled layout, in the tile grid's own coordinates:
 * columns of `widths` side by side, a two-panel column divided at its share of
 * `height`, and each card keeping the `gap` on its top, right and bottom, with the
 * half gutter either side of a split (see `slotStyle`). What a drag previews and what
 * the region then draws come from the same numbers, so the two cannot disagree.
 */
export function tileCardBox(
  layout: PanelLayout,
  id: RightPanelId,
  widths: readonly number[],
  splits: readonly number[],
  height: number,
  gap: number,
): TileBox | null {
  const column = layout.findIndex((ids) => ids.includes(id))
  if (column === -1) return null
  const left = widths.slice(0, column).reduce((sum, width) => sum + width, 0)
  const at = (splits[column] ?? 0.5) * height
  const ids = layout[column]!
  const [top, bottom] = ids.length < 2 ? [0, height] : ids[0] === id ? [0, at + gap / 2] : [at - gap / 2, height]
  return { left, top: top + gap, width: (widths[column] ?? 0) - gap, height: bottom - top - 2 * gap }
}

/**
 * The tile row measured back from its right edge, the one edge that stays put when
 * panels move: how wide the row's box is, and how far left of that edge the first
 * column starts. A floating row carries a gutter on its left and scrolls once it is
 * wider than the room; the browser keeps its scroll as far as it still fits.
 */
export function tileRowSpan(widths: readonly number[], floating: boolean, availableWidth: number, scrollLeft: number, gutter: number) {
  const total = widths.reduce((sum, width) => sum + width, 0)
  if (!floating) return { box: total, start: total }
  const box = Math.min(total + gutter, availableWidth)
  return { box, start: box - gutter + Math.min(scrollLeft, total + gutter - box) }
}

/** Keeps only the panels this chat can show, in their own places. */
export function keepPanels(layout: PanelLayout, keep: (id: RightPanelId) => boolean): PanelLayout {
  const kept = layout.map((column) => column.filter(keep)).filter((column) => column.length > 0)
  return kept.length === layout.length && kept.every((column, index) => column.length === layout[index]!.length) ? layout : kept
}

/**
 * The panels a chat with these rail doors can show. The diff pane is not a door: it opens
 * from Changes and from Review, wherever a rail is.
 */
export const offeredPanels = (doors: readonly { id: RightPanelId }[], phone: boolean): RightPanelId[] =>
  doors.length === 0 || phone ? doors.map((door) => door.id) : [...new Set([...doors.map((door) => door.id), 'diff'] as const)]

/**
 * What a chat shows of what it remembers. Derived rather than corrected in an effect:
 * a remembered Files would otherwise have to be written back on every chat that cannot
 * browse, and be lost for the next one that can. When nothing remembered can be shown
 * here the roster stands in, or nothing at all, deliberately not whatever else the
 * chat offers: opening a DM would then start a browser session nobody asked for.
 */
export function offeredLayout(layout: PanelLayout, offered: readonly RightPanelId[]): PanelLayout {
  const kept = keepPanels(layout, (id) => offered.includes(id))
  if (kept.length > 0 || layout.length === 0) return kept
  return offered.includes('agents') ? [['agents']] : NO_PANELS
}

/** One string per layout, for storage and for telling two layouts apart in a render. */
export const layoutKey = (layout: PanelLayout) => layout.map((column) => column.join('+')).join('|')

/**
 * Reads a layout back, whatever wrote it. A value from before panels could share the
 * region is a single id and reads as that panel alone. Duplicates, unknown ids and
 * anything past the cap are dropped. A third column, which the roster's old column of
 * its own could make, is poured back into free slots in reading order.
 */
export function layoutFromKey(key: string): PanelLayout {
  const seen = new Set<RightPanelId>()
  const columns: PanelLayout = []
  for (const part of key.split('|')) {
    const column: RightPanelId[] = []
    for (const id of part.split('+')) {
      if (!isPanelId(id) || seen.has(id) || column.length === 2) continue
      seen.add(id)
      column.push(id)
    }
    if (column.length > 0) columns.push(column)
  }
  if (columns.length <= 2 && layoutCount(columns) <= MAX_RIGHT_PANELS) return columns
  return columns.flat().reduce<PanelLayout>((layout, id) => withPanel(layout, id), [])
}

const DEFAULT_LAYOUT: PanelLayout = [['agents']]

/**
 * What a stored value means. Anything unrecognised, including a first visit, opens
 * on the roster: the panel is the only place a chat's pins can be seen, so the
 * default is showing them rather than hiding them behind a click nobody knows about.
 * A value written by an older version may still carry the removed Subagents panel and
 * a `~subagents>agents` stand-in suffix: the panel is dropped like any unknown id and
 * the suffix ignored, the rest of the layout kept.
 *
 * A hidden region is stored rather than removed (`none:files+browser`), so a
 * deliberately closed region survives a reload, and ⌘B reopens it on what it was
 * closed on. Per chat by construction, because the map is per chat. A bare `none` is a
 * region closed before this was written down, and reopens on the default.
 *
 * `defaultOpen` false is a first visit that starts on the transcript alone, the roster
 * still what the door or ⌘B brings up: a Session in its project room (2026-10-11).
 */
export function storedPanels(stored: string | null, defaultOpen = true): { open: boolean; layout: PanelLayout } {
  if (stored === null) return { open: defaultOpen, layout: DEFAULT_LAYOUT }
  const open = !stored.startsWith('none')
  const [key = ''] = (open ? stored : stored.slice('none:'.length)).split('~')
  const parsed = layoutFromKey(key)
  return { open, layout: parsed.length === 0 ? DEFAULT_LAYOUT : parsed }
}

/** `files+browser|side`: the layout, hidden or not. */
export const storedValue = (open: boolean, layout: PanelLayout) => `${open ? '' : 'none:'}${layoutKey(layout)}`

/**
 * The next state after a panel door is pressed. `shown` is what is on screen, which is
 * not always what is stored: a chat with no folders shows the roster while Files is
 * still remembered, and a click on the visible roster has to close the roster.
 * A door on a hidden region opens that one panel, not everything that was open before.
 * `instead` is a panel the opening one takes the place of: the Session panel's Changes
 * row closes that panel, so the diff gets its room.
 */
export function toggledPanels(
  stored: { open: boolean; layout: PanelLayout },
  shown: PanelLayout,
  id: RightPanelId,
  instead?: RightPanelId,
): { open: boolean; layout: PanelLayout } {
  if (!stored.open || shown.length === 0) return { open: true, layout: [[id]] }
  if (layoutHas(shown, id)) {
    const next = withoutPanel(shown, id)
    // The last panel out closes the region and stays the thing ⌘B brings back.
    return next.length === 0 ? { open: false, layout: shown } : { open: true, layout: next }
  }
  return { open: true, layout: withPanel(instead === undefined ? shown : withoutPanel(shown, instead), id) }
}

const NEVER_BLOCKED = { current: () => false }

/**
 * Which panels the region has open, remembered per chat: a browser session opened in
 * one thread must not greet you in every other thread, and the same goes for the other
 * panels. Chrome, not workspace state, so it lives in localStorage and never reaches
 * the server, the same split `useFilesPanel` makes for the files width. Entries for
 * deleted chats linger in the map; a few strings in a single-user localStorage are not
 * worth a pruning pass.
 *
 * `compact` is a window too narrow to dock anything: one panel at a time floats over
 * the chat, and the wide layout is left as it was for when the window grows back.
 *
 * `shortcutsActive` is off while focus mode hides the panels, so ⌘B and ⌘; cannot change them unseen.
 *
 * `closedByDefault` names the chats whose first visit shows no panel, see `storedPanels`;
 * what the user then opens or closes is remembered for them like for any chat.
 *
 * `offersSide` names the chats whose rail has a side chat door; ⌘; does nothing in the others,
 * so it cannot store a panel the chat never shows.
 *
 * `shortcutsBlocked` is a ref to a predicate naming the chats whose panels are out of sight
 * for now, such as one a subagent view covers; ⌘B and ⌘; leave them alone, so they return as
 * they were. A ref, because what covers a chat is known further down than this hook is called.
 */
export function useRightPanel(
  chatId: string | null,
  compact = false,
  shortcutsActive = true,
  closedByDefault: (targetChatId: string) => boolean = () => false,
  offersSide: (targetChatId: string) => boolean = () => true,
  shortcutsBlocked: { readonly current: (targetChatId: string) => boolean } = NEVER_BLOCKED,
) {
  const [byChat, setByChat] = useState<Record<string, string>>(read)
  // Read through a ref so a predicate written fresh each render leaves the callbacks stable.
  const closedRef = useRef(closedByDefault)
  closedRef.current = closedByDefault
  const offersSideRef = useRef(offersSide)
  offersSideRef.current = offersSide
  const storedFor = (map: Record<string, string>, targetChatId: string) =>
    storedPanels(map[targetChatId] ?? null, !closedRef.current(targetChatId))
  // Compact holds one panel per chat, and whether it is showing, so ⌘B can bring it back.
  const [compactPanels, setCompactPanels] = useState<Record<string, { id: RightPanelId; open: boolean }>>({})

  useEffect(() => {
    try {
      window.localStorage.setItem(KEY, JSON.stringify(byChat))
    } catch {
      // The region still works without storage, it just forgets between reloads.
    }
  }, [byChat])

  useEffect(() => {
    if (!compact) setCompactPanels({})
  }, [compact])

  const layoutFor = useCallback((targetChatId: string): PanelLayout => {
    if (compact) {
      const entry = compactPanels[targetChatId]
      return entry?.open ? [[entry.id]] : NO_PANELS
    }
    const stored = storedFor(byChat, targetChatId)
    return stored.open ? stored.layout : NO_PANELS
  }, [byChat, compact, compactPanels])
  const layout = chatId === null ? NO_PANELS : layoutFor(chatId)

  const setCompact = useCallback((targetChatId: string, id: RightPanelId, open: boolean) => {
    setCompactPanels((map) => ({ ...map, [targetChatId]: { id, open } }))
  }, [])
  const compactOpen = (targetChatId: string, id: RightPanelId) =>
    compactPanels[targetChatId]?.open === true && compactPanels[targetChatId]?.id === id
  const closeCompact = (targetChatId: string) => setCompact(targetChatId, compactPanels[targetChatId]!.id, false)

  /** A door press. `shown` is the layout on screen and `instead` what opening replaces, see `toggledPanels`. */
  const toggleFor = useCallback((targetChatId: string, id: RightPanelId, shown?: PanelLayout, instead?: RightPanelId) => {
    if (compact) {
      if (compactOpen(targetChatId, id)) closeCompact(targetChatId)
      else setCompact(targetChatId, id, true)
      return
    }
    setByChat((map) => {
      const stored = storedFor(map, targetChatId)
      const next = toggledPanels(stored, shown ?? (stored.open ? stored.layout : NO_PANELS), id, instead)
      return { ...map, [targetChatId]: storedValue(next.open, next.layout) }
    })
  }, [compact, compactPanels, setCompact])

  /**
   * Makes sure a panel is open, for the places that open one on the user's behalf: a
   * file link, a browser that has something to show. Added beside what is open, never
   * in place of it; at the cap the layout stays as it is.
   */
  /** `instead` is a panel the opening one takes the place of, as in `toggledPanels`. */
  const showFor = useCallback((targetChatId: string, id: RightPanelId, instead?: RightPanelId) => {
    if (compact) {
      setCompact(targetChatId, id, true)
      return
    }
    setByChat((map) => {
      const stored = storedFor(map, targetChatId)
      const room = instead === undefined ? stored.layout : withoutPanel(stored.layout, instead)
      return { ...map, [targetChatId]: stored.open && room.length > 0 ? storedValue(true, withPanel(room, id)) : storedValue(true, [[id]]) }
    })
  }, [compact, setCompact])

  const show = useCallback((id: RightPanelId) => {
    if (chatId !== null) showFor(chatId, id)
  }, [chatId, showFor])

  /** A panel's own close button. */
  const closeFor = useCallback((targetChatId: string, id: RightPanelId, shown?: PanelLayout) => {
    if (compact) {
      if (compactOpen(targetChatId, id)) closeCompact(targetChatId)
      return
    }
    setByChat((map) => {
      const stored = storedFor(map, targetChatId)
      const base = shown ?? (stored.open ? stored.layout : NO_PANELS)
      if (!stored.open || !layoutHas(base, id)) return map
      const next = toggledPanels(stored, base, id)
      return { ...map, [targetChatId]: storedValue(next.open, next.layout) }
    })
  }, [compact, compactPanels, setCompact])

  /**
   * A tile dropped on another. From `shown`, like a close, because that is the
   * arrangement the drop was aimed at; compact holds one panel and has nothing to move.
   */
  const moveFor = useCallback((targetChatId: string, id: RightPanelId, target: RightPanelId, drop: PanelDrop, shown: PanelLayout) => {
    if (compact) return
    const next = movedPanel(shown, id, target, drop)
    if (next === shown) return
    setByChat((map) => ({ ...map, [targetChatId]: storedValue(true, next) }))
  }, [compact])

  /** ⌘B: hides the whole region, and brings back exactly what it hid. */
  const toggle = useCallback(() => {
    if (chatId === null) return
    if (compact) {
      const entry = compactPanels[chatId]
      if (entry === undefined) setCompact(chatId, storedFor(byChat, chatId).layout[0]![0]!, true)
      else setCompactPanels((map) => ({ ...map, [chatId]: { ...entry, open: !entry.open } }))
      return
    }
    setByChat((map) => {
      const stored = storedFor(map, chatId)
      return { ...map, [chatId]: storedValue(!stored.open, stored.layout) }
    })
  }, [byChat, chatId, compact, compactPanels, setCompact])

  // Cmd/Ctrl+B toggles the whole region; Cmd/Ctrl+; toggles side chat on its own.
  useEffect(() => {
    if (!shortcutsActive) return
    const onKeyDown = (event: KeyboardEvent) => {
      const shortcut = rightPanelShortcut(event)
      if (shortcut === null || chatId === null || shortcutsBlocked.current(chatId)) return
      event.preventDefault()
      if (shortcut === 'toggle') toggle()
      else if (offersSideRef.current(chatId)) toggleFor(chatId, 'side')
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [chatId, toggle, toggleFor, shortcutsActive])

  return { layout, layoutFor, show, showFor, toggleFor, closeFor, moveFor, toggle }
}

/**
 * How the columns share the region once several panels are open. The first column is
 * its sizing panel's own width in this chat (see `useRightPanelSize`), so this holds
 * only the second column's width, `null` until it is dragged, and each column's split
 * as the share its top panel takes. Per chat like the panel widths: a new session
 * starts from the defaults rather than from whatever the last one was dragged to.
 */
export interface TileSizes {
  second: number | null
  splits: [number, number]
}

const DEFAULT_TILES: TileSizes = { second: null, splits: [0.5, 0.5] }

export function useTileSizes(chatId: string) {
  const key = `manor:right-tiles:${chatId}`
  const [stored, setStored] = useState(() => ({ key, sizes: readTiles(key) }))
  let sizes = stored.sizes
  if (stored.key !== key) {
    sizes = readTiles(key)
    setStored({ key, sizes })
  }
  useEffect(() => {
    try {
      const untouched = stored.sizes.second === null && stored.sizes.splits.every((share) => share === 0.5)
      if (untouched) window.localStorage.removeItem(stored.key)
      else window.localStorage.setItem(stored.key, JSON.stringify(stored.sizes))
    } catch {
      // The sizes still hold for this session, they just do not survive a reload.
    }
  }, [stored])
  const setSecond = useCallback((second: number | null) => setStored((current) => ({
    ...current,
    sizes: { ...current.sizes, second },
  })), [])
  const setSplit = useCallback((column: number, share: number) => setStored((current) => ({
    ...current,
    sizes: {
      ...current.sizes,
      splits: column === 0 ? [share, current.sizes.splits[1]] : [current.sizes.splits[0], share],
    },
  })), [])
  return { sizes, setSecond, setSplit }
}

function readTiles(key: string): TileSizes {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? 'null')
    if (parsed === null || typeof parsed !== 'object') return DEFAULT_TILES
    const { second, splits } = parsed as Partial<Record<keyof TileSizes, unknown>>
    const share = (value: unknown) => (typeof value === 'number' && value > 0 && value < 1 ? value : 0.5)
    return {
      second: typeof second === 'number' && second > 0 ? second : null,
      splits: Array.isArray(splits) ? [share(splits[0]), share(splits[1])] : DEFAULT_TILES.splits,
    }
  } catch {
    return DEFAULT_TILES
  }
}

function read(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(KEY) ?? '{}')
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => typeof value === 'string'),
    ) as Record<string, string>
  } catch {
    return {}
  }
}
