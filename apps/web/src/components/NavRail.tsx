import { memo, useEffect, type ComponentProps } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import {
  Clock01Icon,
  Archive02Icon,
  BookOpen01Icon,
  CellsIcon,
  CheckListIcon,
  Globe02Icon,
  PuzzleIcon,
} from '@hugeicons/core-free-icons'
import {
  Clock01Icon as Clock01SolidIcon,
  Archive02Icon as Archive02SolidIcon,
  BookOpen01Icon as BookOpen01SolidIcon,
  CellsIcon as CellsSolidIcon,
  CheckListIcon as CheckListSolidIcon,
  Globe02Icon as Globe02SolidIcon,
  PuzzleIcon as PuzzleSolidIcon,
} from '@manor/client-runtime/solid-icons'
import type { AgentConfig, ProviderUpdate, ProviderUsage } from '@manor/contracts'
import type { NavDestination } from '../navDestination'
import type { ThemeChoice } from '../useTheme'
import { INSTANT, SEGMENTED_SLIDE } from '../motion'
import { AccountPopover } from './AccountPopover'
import { Avatar } from './Avatar'
import { AiBotHeadLookingIcon, AiBotHeadLookingSolidIcon } from './customIcons'
import { Icon } from './Icon'
import { ProviderUpdateRailButton, type UpdateProviders } from './ProviderUpdates'
import { UsagePanel } from './UsagePanel'
import { SIDEBAR_NAV_MARKER, SelectionMarker } from './ui/SelectionMarker'
import { useSplitDragGrab } from './SplitDrag'

/** The rail's own width, the L-frame's vertical leg. Everything to its right measures from here. */
export const NAV_RAIL_WIDTH = 46

interface RailDoor {
  id: NavDestination
  label: string
  icon: ComponentProps<typeof Icon>['icon']
  /** The solid variant, worn only while this door is the current one. */
  activeIcon: ComponentProps<typeof Icon>['icon']
}

const DOORS: RailDoor[] = [
  { id: 'chats', label: 'Agents', icon: AiBotHeadLookingIcon, activeIcon: AiBotHeadLookingSolidIcon },
  { id: 'work', label: 'Sessions', icon: CellsIcon, activeIcon: CellsSolidIcon },
  { id: 'browser', label: 'Browser', icon: Globe02Icon, activeIcon: Globe02SolidIcon },
  { id: 'knowledge', label: 'Knowledge', icon: BookOpen01Icon, activeIcon: BookOpen01SolidIcon },
  { id: 'reminders', label: 'Reminders', icon: CheckListIcon, activeIcon: CheckListSolidIcon },
  { id: 'artifacts', label: 'Artifacts', icon: Archive02Icon, activeIcon: Archive02SolidIcon },
  { id: 'routines', label: 'Scheduled tasks', icon: Clock01Icon, activeIcon: Clock01SolidIcon },
  { id: 'plugins', label: 'Plugins', icon: PuzzleIcon, activeIcon: PuzzleSolidIcon },
]

/**
 * ⌘1 to ⌘9 as a door position, counted over the doors on screen, so the number is
 * always the one you can count down the rail. Ctrl answers the same for the web client.
 */
export function doorShortcut(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat'>,
): number | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.repeat) return null
  return event.key >= '1' && event.key <= '9' && event.key.length === 1 ? Number(event.key) - 1 : null
}

/** What a door's dot says. Waiting asks for the user, so it outranks the other two. */
export type DoorAttention = 'waiting' | 'unread' | 'done' | null

const DOOR_DOT: Record<Exclude<DoorAttention, null>, string> = {
  waiting: 'bg-warn-fill',
  unread: 'bg-primary',
  done: 'bg-ok',
}

/** A persona the user pinned, under the doors with her DM's standing. */
export interface RailPin {
  agent: AgentConfig
  unread: boolean
  running: boolean
  waiting: boolean
}

interface NavRailProps {
  /** The one door the stage is behind; null while Usage is open, which has no door. */
  destination: NavDestination | null
  /** Knowledge, Reminders, Artifacts and Browser exist only where their host does. */
  hasVault: boolean
  hasReminders: boolean
  hasArtifacts: boolean
  hasBrowser: boolean
  /** A chat asking for the user outranks one that is merely unread. Shown while another door is open. */
  agentsAttention: DoorAttention
  /** A finished run nobody has opened, shown on the Routines door wherever the stage is. */
  routineAttention: boolean
  /** Same reading for sessions, where a finished unread one is `done`. */
  sessionsAttention: DoorAttention
  /** The house has no Composio key, so no agent reaches an app; shown until the key is saved. */
  pluginsAttention?: boolean
  /** Pinned personas, chief first: a door each to their DM below the destinations. */
  pins: RailPin[]
  /** The persona whose DM is on the stage; her face wears the edge pill, Agents keeps the fill. */
  stageAgentId: string | null
  providerUsage: ProviderUsage[]
  usageActive: boolean
  /** Provider CLI updates the toast is not showing; the door hides while there are none. */
  providerUpdates?: ProviderUpdate[]
  onUpdateProviders?: UpdateProviders
  /** The user as the face at the foot shows them. */
  profile: { name: string; photo: string }
  theme: { choice: ThemeChoice; set: (choice: ThemeChoice) => void }
  /** Inside the phone drawer, where the doors need touch-sized targets. */
  mobile?: boolean
  onSelect: (destination: NavDestination) => void
  onOpenUsage: () => void
  /** The account popover's two ways in: Settings, and its Usage page. */
  onOpenSettings: () => void
  onOpenUsageSettings: () => void
  onOpenPin: (agentId: string) => void
}

/**
 * The house's primary navigation: one door per destination, the household's
 * settings at the foot. It never folds away, so the way to every other place is on
 * screen whatever the sidebar beside it is doing.
 */
function NavRailDoors({
  destination,
  hasVault,
  hasReminders,
  hasArtifacts,
  hasBrowser,
  agentsAttention,
  routineAttention,
  sessionsAttention,
  pluginsAttention = false,
  pins,
  stageAgentId,
  providerUsage,
  usageActive,
  providerUpdates = [],
  onUpdateProviders,
  profile,
  theme,
  mobile = false,
  onSelect,
  onOpenUsage,
  onOpenSettings,
  onOpenUsageSettings,
  onOpenPin,
}: NavRailProps) {
  const doors = DOORS.filter(
    (door) =>
      (door.id !== 'knowledge' || hasVault) &&
      (door.id !== 'reminders' || hasReminders) &&
      (door.id !== 'artifacts' || hasArtifacts) &&
      (door.id !== 'browser' || hasBrowser),
  )
  const size = mobile ? 44 : 36
  const reduceMotion = useReducedMotion() ?? false
  // A pinned face drags onto the stage like a Sessions row, opening her DM beside it.
  const grab = useSplitDragGrab()

  useEffect(() => {
    // The phone has no keyboard to speak of, and its drawer rail is not always mounted.
    if (mobile) return
    const onKeyDown = (event: KeyboardEvent) => {
      const index = doorShortcut(event)
      // Dialogs claim their own digits first; the search palette uses them for rows.
      if (index === null || event.defaultPrevented) return
      const door = doors[index]
      if (door === undefined) return
      event.preventDefault()
      onSelect(door.id)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [mobile, doors, onSelect])

  return (
    <nav
      aria-label="Destinations"
      // On the desktop the rail is bare frame under the top bar: pt-2.5 puts the first
      // door's centre on the sidebar title's. The phone drawer keeps its own surface.
      className={`flex h-full flex-none flex-col items-center ${
        mobile
          ? 'border-r border-line bg-surface pt-[max(8px,env(safe-area-inset-top))] pb-[max(8px,env(safe-area-inset-bottom))]'
          : 'pt-2.5 pb-2'
      }`}
      style={{ width: NAV_RAIL_WIDTH }}
    >

      <div className="flex flex-col items-center gap-1">
        {doors.map((door, index) => {
          const current = door.id === destination
          const attention: DoorAttention =
            door.id === 'routines'
              ? routineAttention ? 'done' : null
              : current
                ? null
                : door.id === 'chats' ? agentsAttention
                  : door.id === 'work' ? sessionsAttention
                    : door.id === 'plugins' && pluginsAttention ? 'waiting' : null
          const dot = attention === null ? null : DOOR_DOT[attention]
          const label = attention === null
            ? door.label
            : door.id === 'plugins'
              ? `${door.label}, Composio needs a key`
              : `${door.label}, ${attention === 'waiting' ? 'waiting for you' : door.id === 'chats' ? 'unread messages' : door.id === 'work' ? 'a session is done' : 'a run is done'}`
          return (
            <button
              key={door.id}
              type="button"
              className={`relative grid cursor-pointer place-items-center rounded-xl border-0 bg-transparent [font:inherit] ${
                current ? 'text-text' : 'text-muted hover:bg-surface-2 hover:text-text'
              }`}
              style={{ width: size, height: size }}
              title={index < 9 ? `${door.label} (⌘${index + 1})` : door.label}
              aria-label={label}
              aria-current={current ? 'page' : undefined}
              onClick={() => onSelect(door.id)}
            >
              {current ? <SelectionMarker layoutId={SIDEBAR_NAV_MARKER} className="rounded-xl" /> : null}
              {/* A solid glyph takes no stroke: Icon's default one would fill its cutouts. */}
              <Icon icon={current ? door.activeIcon : door.icon} size={20} className="relative" {...(current ? { strokeWidth: 0 } : {})} />
              {dot === null ? null : (
                <span aria-hidden="true" className={`absolute top-2 right-2 h-1.5 w-1.5 rounded-full ${dot}`} />
              )}
            </button>
          )
        })}
      </div>

      {pins.length === 0 ? null : (
        <>
          <div aria-hidden="true" className="my-2 h-px w-6 flex-none bg-line" />
          <div className="flex flex-col items-center gap-1">
            {pins.map(({ agent, unread, running, waiting }) => {
              const current = agent.id === stageAgentId
              const standing = waiting ? ', waiting for you' : unread ? ', unread messages' : ''
              return (
                <button
                  key={agent.id}
                  type="button"
                  className="relative grid cursor-pointer place-items-center rounded-xl border-0 bg-transparent [font:inherit] hover:bg-surface-2"
                  style={{ width: size, height: size }}
                  title={agent.name}
                  onPointerDown={grab === null ? undefined : (event) => grab({ kind: 'agent', agentId: agent.id }, event)}
                  aria-label={`${agent.name}${standing}`}
                  aria-current={current ? 'true' : undefined}
                  onClick={() => onOpenPin(agent.id)}
                >
                  {/* The fill says where you are, and that stays Agents; this pill against
                      the rail's edge says who. It travels between faces like the fill does. */}
                  {current ? (
                    <motion.span
                      aria-hidden
                      layoutId="rail-pin-pill"
                      className="pointer-events-none absolute top-1/2 h-5 w-1 -translate-y-1/2 rounded-r-full bg-text"
                      style={{ left: -(NAV_RAIL_WIDTH - size) / 2 }}
                      transition={reduceMotion ? INSTANT : SEGMENTED_SLIDE}
                    />
                  ) : null}
                  <span className="relative">
                    <Avatar
                      name={agent.name}
                      color={agent.color}
                      src={agent.avatar}
                      shape={agent.avatarShape}
                      tone={agent.avatarTone}
                      size={size - 12}
                      center
                      sidebarWorking={running && !waiting}
                    />
                  </span>
                  {waiting || unread ? (
                    <span
                      aria-hidden="true"
                      className={`absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full ${waiting ? 'bg-warn-fill' : 'bg-primary'}`}
                    />
                  ) : null}
                </button>
              )
            })}
          </div>
        </>
      )}

      <div className="mt-auto flex flex-col items-center gap-1">
        {/* The update runs on the Mac, so the phone drawer is told nothing it could act on. */}
        {mobile || providerUpdates.length === 0 || onUpdateProviders === undefined ? null : (
          <ProviderUpdateRailButton entries={providerUpdates} onUpdate={onUpdateProviders} />
        )}
        <UsagePanel perProvider={providerUsage} onOpenDetails={onOpenUsage} active={usageActive} />
        <AccountPopover
          name={profile.name}
          photo={profile.photo}
          providerUsage={providerUsage}
          theme={theme.choice}
          size={size}
          onTheme={theme.set}
          onOpenUsage={onOpenUsageSettings}
          onOpenSettings={onOpenSettings}
        />
      </div>
    </nav>
  )
}

/** Memoised for the same reason the sidebar is: nothing here moves while a persona streams. */
export const NavRail = memo(NavRailDoors)
