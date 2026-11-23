import { useLayoutEffect, useRef, useState, type ComponentProps, type RefObject } from 'react'
import type { Chat } from '@manor/contracts'
import { Clock01Icon, BookOpen01Icon, BubbleChatQuestionIcon, Files01Icon, Folder01Icon, Globe02Icon, MoreVerticalIcon, SmartPhone01Icon } from '@hugeicons/core-free-icons'
import {
  Clock01Icon as Clock01SolidIcon,
  BookOpen01Icon as BookOpen01SolidIcon,
  BubbleChatQuestionIcon as BubbleChatQuestionSolidIcon,
  Files01Icon as Files01SolidIcon,
  Folder01Icon as Folder01SolidIcon,
  GitCompareIcon as GitCompareSolidIcon,
  Globe02Icon as Globe02SolidIcon,
  SmartPhone01Icon as SmartPhone01SolidIcon,
} from '@manor/client-runtime/solid-icons'
import { MAX_RIGHT_PANELS, layoutFull, layoutHas, type PanelLayout, type RightPanelId } from '../useRightPanel'
import { AiBotHeadLookingIcon, AiBotHeadLookingSolidIcon, SessionListIcon, SessionListSolidIcon } from './customIcons'
import { Icon } from './Icon'
import { IconButton } from './ui/IconButton'
import { Menu, MenuItem, useMenu } from './ui/Menu'

export interface RailItem {
  id: RightPanelId
  label: string
  icon: ComponentProps<typeof Icon>['icon']
  /** The solid glyph while open, where the door's glyph is not its panel's usual one. */
  activeIcon?: ComponentProps<typeof Icon>['icon']
  /** A subagent is working behind this door, which the door says with a pulsing dot. */
  busy?: boolean
}

interface RightRailProps {
  /** Only the panels this chat can actually show. A room with no folders has no Files item. */
  items: RailItem[]
  /** What is open on screen, which is what each door's state has to match. */
  layout: PanelLayout
  onSelect: (id: RightPanelId) => void
}

/** The solid variant each panel door wears while its panel is open. */
const ACTIVE_ICON: Record<RightPanelId, RailItem['icon']> = {
  agent: AiBotHeadLookingSolidIcon,
  runs: Clock01SolidIcon,
  agents: SessionListSolidIcon,
  side: BubbleChatQuestionSolidIcon,
  files: Folder01SolidIcon,
  knowledge: BookOpen01SolidIcon,
  browser: Globe02SolidIcon,
  simulator: SmartPhone01SolidIcon,
  memory: Files01SolidIcon,
  diff: GitCompareSolidIcon,
}

/**
 * A DM has no side chat (decided 2026-11-13): the agent view stays one conversation.
 * Its rows stay in the database; only the door and its shortcut are gone.
 */
export const chatKindOffersSideChat = (kind: Chat['kind']) => kind !== 'dm'

/** What one thread's rail can open. Pair chats have none. */
export function chatRailItems(
  chat: Chat,
  options: {
    phone: boolean
    singleChat: boolean
    hasProject: boolean
    canBrowseFiles: boolean
    hasVault: boolean
    hasBrowser: boolean
    hasRoster: boolean
    /** A linked git folder: the roster's door opens the Session panel, with Changes and Branch. */
    hasRepo?: boolean
    /** A project's curated thread: Single, keeps only Files, Browser and Context (no Session, Side chat or Knowledge door). */
    projectThread?: boolean
    /**
     * A session its project thread started (decided 2026-10-11): slim, so only the
     * Session door with its Changes stays, and only where the Session has a repo.
     */
    roomSession?: boolean
    /** The chat has subagents: its panel then holds their Agents section, repo or not. */
    hasHelpers?: boolean
    /** Any of them is working now. */
    helpersRunning?: boolean
    /** The Settings toggle for the iOS Simulator is on (desktop and web, never the phone). */
    hasSimulator?: boolean
  },
): RailItem[] {
  if (chat.kind === 'pair') return []
  const hasHelpers = options.hasHelpers === true
  const busy = options.helpersRunning === true ? { busy: true } : {}
  // One device on the Mac, watched from any Session: never a DM's or a project thread's door.
  const simulator: RailItem[] = options.hasSimulator === true && !options.phone && chat.kind === 'project' && options.projectThread !== true
    ? [{ id: 'simulator', label: 'Simulator', icon: SmartPhone01Icon }]
    : []
  if (options.roomSession === true) {
    return [
      ...((options.hasRepo === true && !options.phone) || hasHelpers
        ? [{ id: 'agents' as const, label: options.hasRepo === true ? 'Session' : 'Agents', icon: SessionListIcon, ...busy }]
        : []),
      ...simulator,
    ]
  }
  const memory: RailItem[] =
    chat.kind === 'dm'
      // One door: the agent's memory and scheduled tasks are pages of its settings.
      ? [{ id: 'agent', label: 'Agent settings', icon: AiBotHeadLookingIcon }]
      : !options.hasProject || (options.singleChat && options.projectThread !== true)
        ? []
        : [{ id: 'memory', label: 'Context', icon: Files01Icon }]
  const projectThread = options.projectThread === true
  if (options.phone) {
    return (options.singleChat ? !hasHelpers : !options.hasRoster && !hasHelpers)
      ? memory
      : [{ id: 'agents', label: 'Agents', icon: AiBotHeadLookingIcon, activeIcon: AiBotHeadLookingSolidIcon, ...busy }, ...memory]
  }
  return [
    ...(chat.kind === 'run' ? [{ id: 'runs' as const, label: 'Runs', icon: Clock01Icon }] : []),
    ...(chat.kind === 'dm' || projectThread ? []
      : options.hasRepo === true
        // The whole Session (roster, branch, repository, editor).
        ? [{ id: 'agents' as const, label: 'Session', icon: SessionListIcon, ...busy }]
        : options.singleChat && !hasHelpers ? [] : [{ id: 'agents' as const, label: 'Agents', icon: SessionListIcon, ...busy }]),
    ...(projectThread || !chatKindOffersSideChat(chat.kind) ? [] : [{ id: 'side' as const, label: 'Side chat', icon: BubbleChatQuestionIcon }]),
    ...(options.canBrowseFiles ? [{ id: 'files' as const, label: 'Files', icon: Folder01Icon }] : []),
    ...(options.hasVault && !projectThread ? [{ id: 'knowledge' as const, label: 'Knowledge', icon: BookOpen01Icon }] : []),
    ...(options.hasBrowser ? [{ id: 'browser' as const, label: 'Browser', icon: Globe02Icon }] : []),
    ...simulator,
    ...memory,
  ]
}

/**
 * Whether a chat's rail opens a side chat. The selection menu's "Add to side chat" asks
 * this of the same doors, so the action and the panel cannot drift apart.
 */
export const offersSideChat = (items: readonly Pick<RailItem, 'id'>[]) => items.some((item) => item.id === 'side')

/**
 * The dot that says work is going on behind a door. Still: the busy tone carries it,
 * and an endless loop on the rail costs energy for as long as the work runs.
 */
function BusyDot({ className = '' }: { className?: string }) {
  return <span aria-hidden="true" className={`pointer-events-none size-[7px] rounded-full bg-busy ring-2 ring-bg ${className}`} />
}

/** A door and the gap after it. */
const DOOR = 34
/**
 * What the header keeps for the breadcrumb before a door gives way to the More menu.
 * Below it the doors go first, from the end of the row, and the title truncates
 * only once they are all in the menu.
 */
const TITLE_FLOOR = 160
/** The header's own gap between the breadcrumb and the controls. */
const HEADER_GAP = 12

/** How many of `count` doors stay in the row; when some must go, More takes one slot. */
export function doorsInRow(count: number, room: number | null) {
  if (room === null) return count
  const fits = Math.max(0, Math.floor((room + 2) / DOOR))
  return fits >= count ? count : Math.max(0, fits - 1)
}

/** How the doors read, in the row and in the menu alike. */
function doorLabel(item: RailItem, open: boolean, blocked: boolean) {
  if (open) return `Hide ${item.label.toLowerCase()}`
  return blocked ? `${item.label}, close a panel first (${MAX_RIGHT_PANELS} can be open)` : item.label
}

/**
 * The panel doors, a row at the top right of the chat. Each door opens or closes its
 * own panel and leaves the others alone, so several can be lit at once. Deliberately
 * not a tablist: these are disclosures, and a tablist with several selected tabs, or
 * none, lies to a screen reader.
 *
 * At the cap the closed doors are disabled rather than hidden, and say why: a click
 * that quietly replaced an open panel would lose whatever was in it.
 *
 * A narrow chat keeps what fits and moves the rest, from the end of the row, into a
 * More menu, in the same order and with the same states. By position rather than by
 * what is open, so a door never jumps across the row when its panel opens.
 */
export function RightRail({ items, layout, onSelect }: RightRailProps) {
  const nav = useRef<HTMLElement>(null)
  const room = useDoorRoom(nav)
  if (items.length === 0) return null
  const full = layoutFull(layout)
  const inline = items.slice(0, doorsInRow(items.length, room))
  const overflow = items.slice(inline.length)

  return (
    <nav ref={nav} aria-label="Panels" className="pointer-events-auto flex flex-none items-center gap-0.5">
      {inline.map((item) => {
        const open = layoutHas(layout, item.id)
        const blocked = !open && full
        const label = doorLabel(item, open, blocked)
        return (
          <button
            key={item.id}
            type="button"
            // IconButton's states, so the doors read like the header controls beside them.
            className={`relative grid h-8 w-8 flex-none place-items-center rounded-button border-0 [font:inherit] ${
              open
                ? 'cursor-pointer bg-icon-fill text-text'
                : blocked
                  ? 'cursor-default bg-transparent text-muted opacity-40'
                  : 'cursor-pointer bg-transparent text-muted hover:bg-icon-fill hover:text-text'
            }`}
            title={label}
            aria-label={label}
            // No `aria-controls`: several of the panels own their own markup, and a
            // dangling reference reads worse than none.
            aria-expanded={open}
            // `aria-disabled` rather than `disabled`, so the title still explains on hover.
            aria-disabled={blocked || undefined}
            onClick={() => {
              if (!blocked) onSelect(item.id)
            }}
          >
            {/* A solid glyph takes no stroke: Icon's default one would fill its cutouts. */}
            <Icon icon={open ? item.activeIcon ?? ACTIVE_ICON[item.id] : item.icon} size={17} {...(open ? { strokeWidth: 0 } : {})} />
            {item.busy === true ? <BusyDot className="absolute top-1 right-1" /> : null}
          </button>
        )
      })}
      {overflow.length === 0 ? null : <MoreDoors items={overflow} layout={layout} onSelect={onSelect} />}
    </nav>
  )
}

/**
 * The room the doors have: their top bar group's width (the phone header's, on the
 * phone) less its padding, the breadcrumb's floor and whatever sits beside the doors
 * (a split pane's close, the connection state). All of it is independent of how many
 * doors show, so collapsing them cannot feed back into the measurement. `null` until
 * measured, when every door shows.
 */
function useDoorRoom(nav: RefObject<HTMLElement>) {
  const [room, setRoom] = useState<number | null>(null)
  useLayoutEffect(() => {
    const element = nav.current
    const header = element?.closest('[data-top-bar-slot]') ?? element?.closest('header')
    const beside = element?.parentElement
    if (!element || !header || !beside || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      const style = getComputedStyle(header)
      let others = 0
      for (const child of Array.from(beside.children)) {
        if (child !== element) others += child.getBoundingClientRect().width + 2
      }
      const status = header.querySelector('[data-top-bar-status]')
      if (status !== null) others += status.getBoundingClientRect().width + HEADER_GAP
      const content = header.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
      setRoom(Math.floor(content - TITLE_FLOOR - HEADER_GAP - others))
    }
    const observer = new ResizeObserver(measure)
    observer.observe(header)
    observer.observe(beside)
    measure()
    return () => observer.disconnect()
  }, [nav])
  return room
}

function MoreDoors({ items, layout, onSelect }: { items: RailItem[]; layout: PanelLayout; onSelect: (id: RightPanelId) => void }) {
  const [menu, trigger] = useMenu({ maxHeight: 420, minHeight: 120, minWidth: 220 })
  const full = layoutFull(layout)

  return (
    <>
      <span className="relative block">
        <IconButton ref={trigger} icon={MoreVerticalIcon} iconSize={17} label="More panels" aria-haspopup="menu" aria-expanded={menu.open}
          selected={menu.open} onClick={menu.toggle} />
        {items.some((item) => item.busy === true) ? <BusyDot className="absolute top-1 right-1" /> : null}
      </span>
      <Menu menu={menu} label="More panels">
        {items.map((item) => {
          const shown = layoutHas(layout, item.id)
          const blocked = !shown && full
          return (
            <MenuItem key={item.id} role="menuitemcheckbox" icon={item.icon} checked={shown}
              blocked={blocked ? doorLabel(item, shown, blocked) : undefined}
              trailing={item.busy === true ? <BusyDot className="flex-none" /> : undefined}
              onClick={() => { menu.close(); onSelect(item.id) }}>
              {item.label}
            </MenuItem>
          )
        })}
      </Menu>
    </>
  )
}
