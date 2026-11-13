import type { ComponentProps, KeyboardEvent } from 'react'
import {
  Calendar01Icon,
  Calendar03Icon,
  CheckmarkCircle02Icon,
  Flag02Icon,
  InboxIcon,
  InformationCircleIcon,
  UserCheck01Icon,
  UserGroupIcon,
} from '@hugeicons/core-free-icons'
import type { ReminderList } from '@manor/contracts'
import type { ReminderCounts } from '@manor/client-runtime/reminders'
import { safeHex } from '../../persona'
import { Icon } from '../Icon'
import { SelectionMarker } from '../ui/SelectionMarker'
import { PRIVATE_TILES, sameScope, TILE_LABEL, type ReminderScope, type ReminderTile } from './reminderViews'

/** One travelling fill for tiles, lists and sections: the door has exactly one current scope. */
const SCOPE_MARKER = 'reminders-scope'

const TILE_ICON: Record<ReminderTile, ComponentProps<typeof Icon>['icon']> = {
  today: Calendar01Icon,
  scheduled: Calendar03Icon,
  flagged: Flag02Icon,
  assigned: UserCheck01Icon,
  all: InboxIcon,
  completed: CheckmarkCircle02Icon,
}

const TILE_ORDER: readonly ReminderTile[] = ['today', 'scheduled', 'flagged', 'assigned', 'all', 'completed']

/** A list's own Reminders colour. Runtime data like a persona accent, so no token. */
export const listColor = (list: Pick<ReminderList, 'color'> | undefined): string =>
  list?.color === undefined ? 'var(--color-muted)' : safeHex(list.color)

interface RemindersSidebarProps {
  scope: ReminderScope
  counts: ReminderCounts
  /** Null where the source cannot count them cheaply; the tile then shows no number. */
  completedCount: number | null
  groups: readonly { id: string; title: string }[]
  lists: readonly ReminderList[]
  /** Open reminders per section id, for the section rows. */
  sectionCounts: ReadonlyMap<string, number>
  /** RemCTL could not read the private store; `notice` says why. */
  plain: boolean
  notice: string | undefined
  onScope: (scope: ReminderScope) => void
}

/** Arrow keys walk the tiles and rows in reading order, the way the chat lists do. */
function walkRows(event: KeyboardEvent<HTMLElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
  if (!(event.target instanceof HTMLElement)) return
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-scope-row]')]
  const index = rows.indexOf(event.target as HTMLButtonElement)
  if (index === -1) return
  event.preventDefault()
  // Tiles sit two abreast, so down from the left tile is the one below it, not beside it.
  const tiles = rows.filter((row) => row.dataset.scopeRow === 'tile').length
  const step = index < tiles && (event.key === 'ArrowDown' ? index + 2 < tiles : index - 2 >= 0) ? 2 : 1
  const next = rows[index + (event.key === 'ArrowDown' ? step : -step)]
  if (next === undefined) return
  next.focus({ preventScroll: true })
  next.scrollIntoView({ block: 'nearest' })
  next.click()
}

/**
 * The door's navigation, in the workspace sidebar where Knowledge keeps its tree: the
 * smart tiles on top, My Lists below with each list's sections. RemCTL's layout in the
 * house's own surfaces, so tiles are quiet plates rather than coloured badges.
 */
export function RemindersSidebar({
  scope,
  counts,
  completedCount,
  groups,
  lists,
  sectionCounts,
  plain,
  notice,
  onScope,
}: RemindersSidebarProps) {
  const tiles = TILE_ORDER.filter((tile) => !(plain && PRIVATE_TILES.has(tile)))
  const count = (tile: ReminderTile): number | null => (tile === 'completed' ? completedCount : counts[tile])
  const ungrouped = lists.filter((list) => list.groupId === undefined || !groups.some((group) => group.id === list.groupId))

  const listRows = (members: readonly ReminderList[]) =>
    members.map((list) => {
      const listScope: ReminderScope = { kind: 'list', listId: list.id }
      const current = sameScope(scope, listScope)
      return (
        <li key={list.id} className="flex flex-col">
          <button
            type="button"
            data-scope-row="list"
            aria-current={current ? 'page' : undefined}
            className={`relative flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-lg border-0 bg-transparent px-3 text-left text-[14px] ${
              current ? 'text-text' : 'text-muted hover:bg-surface-2 hover:text-text'
            }`}
            onClick={() => onScope(listScope)}
          >
            {current ? <SelectionMarker layoutId={SCOPE_MARKER} className="rounded-lg" /> : null}
            <span aria-hidden="true" className="relative h-2.5 w-2.5 flex-none rounded-full" style={{ background: listColor(list) }} />
            <span className="relative min-w-0 flex-1 truncate">{list.title}</span>
            {list.shared ? (
              <span className="relative flex-none text-dim" title="Shared list">
                <Icon icon={UserGroupIcon} size={13} aria-label="Shared" />
              </span>
            ) : null}
            <span className="relative flex-none text-[12px] tabular-nums text-dim">{list.open}</span>
          </button>
          {plain || list.sections.length === 0 ? null : (
            <ul className="m-0 flex list-none flex-col p-0">
              {list.sections.map((section) => {
                const sectionScope: ReminderScope = { kind: 'list', listId: list.id, sectionId: section.id }
                const sectionCurrent = sameScope(scope, sectionScope)
                return (
                  <li key={section.id}>
                    <button
                      type="button"
                      data-scope-row="section"
                      aria-current={sectionCurrent ? 'page' : undefined}
                      className={`relative flex h-7 w-full cursor-pointer items-center gap-2 rounded-lg border-0 bg-transparent pr-3 pl-[34px] text-left text-[13px] ${
                        sectionCurrent ? 'text-text' : 'text-muted hover:bg-surface-2 hover:text-text'
                      }`}
                      onClick={() => onScope(sectionScope)}
                    >
                      {sectionCurrent ? <SelectionMarker layoutId={SCOPE_MARKER} className="rounded-lg" /> : null}
                      <span className="relative min-w-0 flex-1 truncate">{section.title}</span>
                      <span className="relative flex-none text-[12px] tabular-nums text-dim">{sectionCounts.get(section.id) ?? 0}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </li>
      )
    })

  return (
    <div className="flex flex-col gap-5 pt-1" onKeyDown={walkRows}>
      <ul aria-label="Smart lists" className="m-0 grid list-none grid-cols-2 gap-1.5 p-0">
        {tiles.map((tile) => {
          const tileScope: ReminderScope = { kind: 'tile', tile }
          const current = sameScope(scope, tileScope)
          const value = count(tile)
          return (
            <li key={tile} className="min-w-0">
              <button
                type="button"
                data-scope-row="tile"
                aria-current={current ? 'page' : undefined}
                aria-label={value === null ? TILE_LABEL[tile] : `${TILE_LABEL[tile]}, ${value}`}
                className={`relative flex h-[58px] w-full cursor-pointer flex-col justify-between rounded-xl border-0 px-3 py-2 text-left ${
                  current ? 'bg-transparent text-text' : 'bg-surface-2 text-muted hover:text-text'
                }`}
                onClick={() => onScope(tileScope)}
              >
                {current ? <SelectionMarker layoutId={SCOPE_MARKER} className="rounded-xl" /> : null}
                <span className="relative flex items-center justify-between gap-2">
                  <Icon icon={TILE_ICON[tile]} size={16} className="flex-none" />
                  {value === null ? null : (
                    <span className="text-[16px] font-medium tabular-nums text-text">{value}</span>
                  )}
                </span>
                <span className="relative truncate text-label">{TILE_LABEL[tile]}</span>
              </button>
            </li>
          )
        })}
      </ul>

      <section aria-labelledby="reminders-my-lists" className="flex flex-col gap-0.5">
        <h3 id="reminders-my-lists" className="m-0 px-3 pb-1 text-meta font-medium text-dim">My Lists</h3>
        {lists.length === 0 ? (
          <p className="m-0 px-3 py-1 text-label text-dim">No lists in Reminders yet.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
            {listRows(ungrouped)}
            {groups.map((group) => {
              const members = lists.filter((list) => list.groupId === group.id)
              if (members.length === 0) return null
              return (
                <li key={group.id} className="flex flex-col gap-0.5 pt-2">
                  <span className="px-3 pb-0.5 text-meta text-dim">{group.title}</span>
                  <ul className="m-0 flex list-none flex-col gap-0.5 p-0">{listRows(members)}</ul>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {!plain ? null : (
        <p className="m-0 flex gap-2 px-3 text-label leading-relaxed text-dim" role="status">
          <Icon icon={InformationCircleIcon} size={14} className="mt-0.5 flex-none" />
          <span className="min-w-0">
            Sections, assignees, flags, tags and subtasks are unavailable right now.
            {notice === undefined ? null : <span className="block pt-1">{notice}</span>}
          </span>
        </p>
      )}
    </div>
  )
}
