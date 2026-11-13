import { useState, type KeyboardEvent, type ReactNode } from 'react'
import type { Reminder, ReminderList } from '@manor/contracts'
import { Fold, FoldChevron } from '../ui/Fold'
import { ReminderRow } from './ReminderRow'
import { listColor } from './RemindersSidebar'
import type { ReminderGroup } from './reminderViews'

/**
 * Folded sections and folded subtasks, per scope, for the tab's lifetime. The door
 * unmounts when another destination opens, and coming back to a list with its long
 * section folded open again would undo the one thing the user did to it.
 */
const foldedGroups = new Map<string, ReadonlySet<string>>()
let foldedParents: ReadonlySet<string> = new Set()

/** Up and down walk the rows in reading order, opening each in the details like a click. */
export function walkReminderRows(event: KeyboardEvent<HTMLElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.nativeEvent.isComposing) return
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
  if (!(event.target instanceof HTMLElement) || event.target.dataset.reminderRow === undefined) return
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button[data-reminder-row]')]
    .filter((row) => !row.closest('.fold[data-open="false"]'))
  const index = rows.indexOf(event.target as HTMLButtonElement)
  if (index === -1) return
  event.preventDefault()
  const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)]
  if (next === undefined) return
  next.focus({ preventScroll: true })
  next.scrollIntoView({ block: 'nearest' })
  next.click()
}

interface ReminderListViewProps {
  groups: readonly ReminderGroup[]
  lists: readonly ReminderList[]
  now: { day: string; time: string }
  selectedId: string | null
  /** Tiles mix lists, so each row names its own. */
  showList: boolean
  canWrite: boolean
  /** The scope, so folds are remembered per list and tile. Key the view by it too. */
  memoryKey: string
  /** The new-reminder row, above everything else while it is open. */
  composer?: ReactNode
  /** Shown instead of the groups when there is nothing in them. */
  empty: ReactNode
  /** Below the last group: Completed's next page. */
  footer?: ReactNode
  onSelect: (id: string) => void
  onToggle: (reminder: Reminder) => void
}

/** The list layout: sections that fold, and subtasks that fold under their parent. */
export function ReminderListView({
  groups,
  lists,
  now,
  selectedId,
  showList,
  canWrite,
  memoryKey,
  composer,
  empty,
  footer,
  onSelect,
  onToggle,
}: ReminderListViewProps) {
  const [folded, setFolded] = useState(() => foldedGroups.get(memoryKey) ?? new Set<string>())
  const [parents, setParents] = useState(foldedParents)
  const listOf = (reminder: Reminder) => lists.find((list) => list.id === reminder.listId)
  const hasRows = groups.some((group) => group.nodes.length > 0)
  // A list with sections still shows them empty, so its shape reads; nothing at all is the empty state.
  const showGroups = hasRows || groups.some((group) => group.title !== null)

  const toggleGroup = (key: string) => {
    const next = new Set(folded)
    if (!next.delete(key)) next.add(key)
    foldedGroups.set(memoryKey, next)
    setFolded(next)
  }

  const toggleParent = (id: string) => {
    const next = new Set(parents)
    if (!next.delete(id)) next.add(id)
    foldedParents = next
    setParents(next)
  }

  return (
    <div className="mx-auto flex min-h-full w-full max-w-[860px] flex-col gap-1 px-4 pt-8 pb-10 lg:px-6" onKeyDown={walkReminderRows}>
      {composer}
      {!showGroups ? <div className="grid flex-1 place-items-center">{empty}</div> : groups.map((group) => {
        const open = !folded.has(group.key)
        const rows = (
          <ul className="m-0 flex list-none flex-col gap-px p-0">
            {group.nodes.length === 0 ? (
              <li className="py-1.5 pl-[58px] text-label text-dim">No reminders</li>
            ) : group.nodes.map(({ reminder, subtasks }) => {
              const subtasksOpen = !parents.has(reminder.id)
              return (
                <li key={reminder.id} className="flex flex-col gap-px">
                  <ReminderRow
                    reminder={reminder}
                    list={listOf(reminder)}
                    now={now}
                    selected={reminder.id === selectedId}
                    showList={showList}
                    subtaskCount={subtasks.length}
                    canWrite={canWrite}
                    onSelect={onSelect}
                    onToggle={onToggle}
                    leading={subtasks.length === 0 ? null : (
                      <button
                        type="button"
                        className="grid h-6 w-5 cursor-pointer place-items-center rounded-md border-0 bg-transparent p-0 text-dim hover:text-text"
                        aria-label={subtasksOpen ? `Hide subtasks of “${reminder.title}”` : `Show subtasks of “${reminder.title}”`}
                        aria-expanded={subtasksOpen}
                        onClick={() => toggleParent(reminder.id)}
                      >
                        <FoldChevron open={subtasksOpen} />
                      </button>
                    )}
                  />
                  {subtasks.length === 0 ? null : (
                    <Fold open={subtasksOpen}>
                      <ul className="m-0 flex list-none flex-col gap-px p-0">
                        {subtasks.map((subtask) => (
                          <li key={subtask.id}>
                            <ReminderRow
                              reminder={subtask}
                              list={listOf(subtask)}
                              now={now}
                              selected={subtask.id === selectedId}
                              showList={false}
                              nested
                              canWrite={canWrite}
                              onSelect={onSelect}
                              onToggle={onToggle}
                            />
                          </li>
                        ))}
                      </ul>
                    </Fold>
                  )}
                </li>
              )
            })}
          </ul>
        )
        if (group.title === null) return <section key={group.key} aria-label="Reminders">{rows}</section>
        const count = group.nodes.reduce((sum, node) => sum + 1 + node.subtasks.length, 0)
        return (
          <section key={group.key} className="flex flex-col pt-3" aria-label={group.title}>
            <h3 className="m-0">
              <button
                type="button"
                className={`flex h-8 w-full cursor-pointer items-center gap-2 rounded-lg border-0 bg-transparent px-1.5 text-left text-[14px] font-medium hover:bg-surface-2 ${
                  group.overdue ? 'text-danger' : 'text-text'
                }`}
                aria-expanded={open}
                onClick={() => toggleGroup(group.key)}
              >
                <span className="grid w-5 flex-none place-items-center text-dim"><FoldChevron open={open} /></span>
                {group.color === undefined ? null : (
                  <span aria-hidden="true" className="h-2 w-2 flex-none rounded-full" style={{ background: listColor(group) }} />
                )}
                <span className="min-w-0 flex-1 truncate">{group.title}</span>
                <span className="flex-none pr-1.5 text-[12px] font-normal tabular-nums text-dim">{count}</span>
              </button>
            </h3>
            <Fold open={open}>
              <div className="pt-0.5">{rows}</div>
            </Fold>
          </section>
        )
      })}
      {footer}
    </div>
  )
}
