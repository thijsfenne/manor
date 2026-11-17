import { createContext, useContext, useEffect, useState, type CSSProperties } from 'react'
import { ArrowLeft01Icon, ArrowRight01Icon, Search01Icon, SidebarLeftIcon } from '@hugeicons/core-free-icons'
import { desktopTitleBarIsInset } from '../desktopBrowser'
import type { ConnectionStatus } from '../useWorkspace'
import { IconButton } from './ui/IconButton'

/**
 * The window's top bar, the horizontal leg of the L-frame. The shell centres the
 * traffic lights on this height (`apps/desktop/src/windowChrome.ts`), so the two change
 * together.
 */
export const TOP_BAR_HEIGHT = 38

/** The frame showing between the inset and the window's right and bottom edges. */
export const FRAME_GUTTER = 4

/**
 * Where the first lead control starts while the traffic lights are drawn: 84 window
 * points from the edge, clear of the third light, held in window points as the
 * page zooms so the controls never slide under the lights.
 */
const LIGHTS_SLOT = 'calc(84px / var(--desktop-zoom, 1))'

/** The lead controls' box, and their room once the lights are gone: over the rail. */
const LEAD_BUTTON = 32
/** Sidebar, Back, Forward and Search. */
const LEAD_CONTROLS = 4 * LEAD_BUTTON

/** Air between the last lead control and a breadcrumb that has to clear it. */
const LEAD_GAP = 12

/** Where the hairline before that breadcrumb stands past the last lead control. */
const LINE_GAP = 2

/** The first group's own inset from the stage edge, as wide as the pane's text column inset. */
const GROUP_INSET = 16

/**
 * Where a pane's header lands. A pane reads it from context and portals its breadcrumb
 * and controls into `element`. Null outside the desktop frame: the phone keeps its
 * in-place header.
 */
export interface TopBarSlot {
  element: HTMLElement | null
  /** An unfocused split pane's title goes muted, as its transcript is dimmed. */
  focused: boolean
}

export const TopBarSlotContext = createContext<TopBarSlot | null>(null)

export function useTopBarSlot() {
  return useContext(TopBarSlotContext)
}

/**
 * A surface's grid rows around its `WorkspaceHeader`: a row for the header where it is
 * drawn in place (the phone), none where the top bar holds it, so the body still lands
 * in the stretching row.
 */
export function useHeaderRows() {
  return useTopBarSlot() === null ? HEADED_ROWS : BARE_ROWS
}

export const HEADED_ROWS = 'grid-rows-[auto_minmax(0,1fr)]'
export const BARE_ROWS = 'grid-rows-[minmax(0,1fr)]'

/**
 * True while macOS draws the traffic lights in the bar: the desktop shell on a Mac,
 * outside native full screen. A plain browser tab has no lights and gets the full-screen
 * arrangement, with the lead controls over the rail.
 */
export function useTrafficLights(): boolean {
  const [inset] = useState(desktopTitleBarIsInset)
  const [fullscreen, setFullscreen] = useState(false)
  useEffect(() => {
    if (!inset) return
    return window.manorDesktop?.onFullscreen?.((value) => setFullscreen(value === true))
  }, [inset])
  return inset && !fullscreen
}

interface TopBarProps {
  /** The rail plus a pinned sidebar: where the stage, and so the first group, starts. */
  leadWidth: number
  /** The rail's width; without lights the first lead control is centred over it. */
  railWidth: number
  /** Follows the sidebar's own slide; off while its edge is dragged or a switch is instant. */
  animate: boolean
  /** A split's left share, or null for one group across the whole stage. */
  split: { ratio: number; animate: boolean } | null
  status: ConnectionStatus
  /** Settings covers the workspace: the bar keeps its frame and drops what acts on the stage. */
  covered: boolean
  sidebar: { collapsed: boolean; onToggle?: () => void }
  history: { canBack: boolean; canForward: boolean; onBack: () => void; onForward: () => void }
  /** Opens the ⌘K palette. With the lead controls, so it stands after Forward in every window state. */
  onSearch: () => void
  /** Each group's portal target, handed up so the panes below can render into it. */
  slotRefs: { left: (element: HTMLElement | null) => void; right: (element: HTMLElement | null) => void }
}

/**
 * The bar is laid out on the same columns as the content under it: the lead area over
 * the rail and sidebar, then one group per pane, starting at that pane's left edge. A
 * split's line sits on the pane border because both rows share the split's own basis
 * and its own transition, never a measurement of the other.
 */
export function TopBar({ leadWidth, railWidth, animate, split, status, covered, sidebar, history, onSearch, slotRefs: { left: leftSlot, right: rightSlot } }: TopBarProps) {
  const lights = useTrafficLights()
  const bareStart = (railWidth - LEAD_BUTTON) / 2
  const controlsEnd = lights ? `calc(${LIGHTS_SLOT} + ${LEAD_CONTROLS}px)` : `${bareStart + LEAD_CONTROLS}px`
  // A folded sidebar (or a page without one) leaves the lead narrower than its controls;
  // the first breadcrumb then sits close after them, a hairline between, and follows them
  // over the rail in full screen. A pinned sidebar puts that hairline over its seam.
  const firstInset = `max(${GROUP_INSET}px, calc(${controlsEnd} + ${LEAD_GAP}px - ${leadWidth}px))`
  const lineLeft = `max(0px, calc(${controlsEnd} + ${LINE_GAP}px - ${leadWidth}px))`
  // The groups' basis eases only between two ratios (a focus change, a released drag).
  // The panes below mount at their final basis, so a split opening or closing must not
  // grow the group the doors sit in: they would fly in from the left while the panel is
  // already there.
  const [hadSplit, setHadSplit] = useState(false)
  useEffect(() => setHadSplit(split !== null), [split !== null])
  const splitAnimates = split?.animate === true && hadSplit
  // The sidebar's slide and the split's own, each on the curve of the content it mirrors.
  const leadMotion = animate ? 'motion-safe:[transition:width_200ms_var(--ease-arrive)]' : ''
  const firstMotion = animate
    ? splitAnimates
      ? 'motion-safe:[transition:padding-left_200ms_var(--ease-arrive),flex-basis_280ms_var(--ease-arrive)]'
      : 'motion-safe:[transition:padding-left_200ms_var(--ease-arrive)]'
    : splitAnimates ? 'motion-safe:[transition:flex-basis_280ms_var(--ease-arrive)]' : ''
  const secondMotion = splitAnimates ? 'motion-safe:[transition:flex-basis_280ms_var(--ease-arrive)]' : ''
  const lineMotion = animate ? 'motion-safe:[transition:left_200ms_var(--ease-arrive)]' : ''
  const coveredProps = covered ? { inert: '' } : {}
  const connection = status === 'live' ? null : (
    <span data-top-bar-status="" className="order-2 ml-auto flex-none pl-1 text-meta font-medium text-dim">
      {status === 'connecting' ? 'Connecting…' : 'Offline'}
    </span>
  )

  return (
    <header
      aria-label="Top bar"
      className="frame-chrome drag-region relative col-span-full row-start-1 flex min-w-0 select-none"
      style={{ height: TOP_BAR_HEIGHT } as CSSProperties}
    >
      <div aria-hidden="true" className={`flex-none ${leadMotion}`} style={{ width: leadWidth }} />

      <div
        data-lead-controls={lights ? 'lights' : 'bare'}
        className={`absolute inset-y-0 left-0 z-[1] flex items-center ${covered ? 'invisible' : ''}`}
        style={{ paddingLeft: lights ? 0 : bareStart }}
        {...coveredProps}
      >
        {lights ? <span data-traffic-lights="" aria-hidden="true" className="flex-none" style={{ width: LIGHTS_SLOT }} /> : null}
        <IconButton
          icon={SidebarLeftIcon}
          iconSize={17}
          label={sidebar.collapsed ? 'Show sidebar' : 'Hide sidebar'}
          title={sidebar.onToggle === undefined
            ? 'This page has no sidebar'
            : sidebar.collapsed ? 'Show sidebar (⌘S)' : 'Hide sidebar (⌘S)'}
          aria-expanded={sidebar.onToggle === undefined ? undefined : !sidebar.collapsed}
          disabled={sidebar.onToggle === undefined}
          onClick={sidebar.onToggle}
        />
        <IconButton
          icon={ArrowLeft01Icon}
          iconSize={16}
          label="Back"
          title="Back (⌘[)"
          disabled={!history.canBack}
          onClick={history.onBack}
        />
        <IconButton
          icon={ArrowRight01Icon}
          iconSize={16}
          label="Forward"
          title="Forward (⌘])"
          disabled={!history.canForward}
          onClick={history.onForward}
        />
        <IconButton
          icon={Search01Icon}
          iconSize={16}
          label="Search"
          title="Search (⌘K)"
          onClick={onSearch}
        />
      </div>

      <div
        className={`flex min-w-0 flex-1 ${covered ? 'invisible' : ''}`}
        style={{ marginRight: FRAME_GUTTER }}
        {...coveredProps}
      >
        <div
          data-top-bar-slot="left"
          className={`relative flex min-w-0 items-center gap-3 pr-2 ${firstMotion}`}
          style={{ flex: split === null ? '1 1 0%' : `0 1 ${split.ratio * 100}%`, paddingLeft: firstInset }}
        >
          <div ref={leftSlot} className="peer contents" />
          {/* Gone with nothing to stand before: a page that puts no header in the bar. */}
          <span
            aria-hidden="true"
            data-lead-line=""
            className={`pointer-events-none absolute top-1/2 h-5 w-px -translate-y-1/2 bg-line peer-empty:hidden ${lineMotion}`}
            style={{ left: lineLeft }}
          />
          {split === null ? connection : null}
        </div>
        {split === null ? null : (
          <div
            data-top-bar-slot="right"
            // The line stands exactly over the pane border: both start at this edge.
            className={`relative flex min-w-0 items-center gap-3 pr-2 pl-4 before:absolute before:top-1/2 before:left-0 before:h-5 before:w-px before:-translate-y-1/2 before:bg-line before:content-[''] ${secondMotion}`}
            style={{ flex: `0 1 ${(1 - split.ratio) * 100}%` }}
          >
            <div ref={rightSlot} className="contents" />
            {connection}
          </div>
        )}
      </div>
    </header>
  )
}
