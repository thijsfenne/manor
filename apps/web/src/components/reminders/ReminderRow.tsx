import type { MouseEvent, ReactNode } from 'react'
import { Flag02Icon, Note01Icon, RepeatIcon, Tick02Icon, UserIcon } from '@hugeicons/core-free-icons'
import type { Reminder, ReminderList } from '@manor/contracts'
import { Icon } from '../Icon'
import { listColor } from './RemindersSidebar'
import { dayLabel, dueLabel, isPendingId } from './reminderViews'

interface CompleteRingProps {
  reminder: Reminder
  list: ReminderList | undefined
  size?: number
  disabled?: boolean
  onToggle: (reminder: Reminder) => void
}

/**
 * Reminders.app's round tick, in the list's own colour. Its own button beside the row,
 * so completing never also opens the details, and Space on it does the one thing.
 */
export function CompleteRing({ reminder, list, size = 18, disabled = false, onToggle }: CompleteRingProps) {
  const color = listColor(list)
  const done = reminder.completed
  return (
    <button
      type="button"
      className="group/ring relative grid flex-none cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 disabled:cursor-default disabled:opacity-45"
      style={{ width: size + 8, height: size + 8 }}
      aria-label={done ? `Mark “${reminder.title}” as not completed` : `Complete “${reminder.title}”`}
      title={done ? 'Mark as not completed' : 'Complete'}
      disabled={disabled}
      onClick={(event: MouseEvent) => {
        event.stopPropagation()
        onToggle(reminder)
      }}
    >
      <span
        aria-hidden="true"
        className="grid place-items-center rounded-full border-[1.5px] duration-150 ease-out motion-safe:transition-[background-color,border-color]"
        style={{
          width: size,
          height: size,
          borderColor: done ? color : 'color-mix(in srgb, var(--color-muted) 70%, transparent)',
          background: done ? color : 'transparent',
        }}
      >
        {done ? (
          <Icon icon={Tick02Icon} size={size - 6} strokeWidth={2.4} className="text-on-primary" />
        ) : (
          // The fill a hover promises, in the list's colour, so the act reads before the click.
          <span
            className="h-[calc(100%-6px)] w-[calc(100%-6px)] rounded-full opacity-0 duration-150 ease-out group-hover/ring:opacity-40 group-focus-visible/ring:opacity-40 motion-safe:transition-opacity"
            style={{ background: color }}
          />
        )}
      </span>
    </button>
  )
}

interface ReminderMetaProps {
  reminder: Reminder
  now: { day: string; time: string }
  /** Named in tile scopes, where rows from several lists sit together. */
  list?: ReminderList
  subtaskCount?: number
  className?: string
}

/** The row's second line: when, where, who, and what hangs off it. Absent parts take no room. */
export function ReminderMeta({ reminder, now, list, subtaskCount = 0, className = '' }: ReminderMetaProps) {
  const parts: ReactNode[] = []
  if (reminder.completed && reminder.completedAt !== undefined) {
    const label = dayLabel(reminder.completedAt.slice(0, 10), now.day)
    parts.push(<span key="done">Completed {label === 'Today' || label === 'Yesterday' ? label.toLowerCase() : label}</span>)
  } else if (reminder.due !== undefined) {
    const due = dueLabel(reminder.due, now)
    parts.push(
      <span key="due" className={`flex items-center gap-1 ${due.overdue ? 'text-danger' : ''}`}>
        {due.text}
        {reminder.repeat === undefined ? null : <Icon icon={RepeatIcon} size={12} aria-label="Repeats" />}
      </span>,
    )
  }
  if (list !== undefined) {
    parts.push(
      <span key="list" className="flex min-w-0 items-center gap-1.5">
        <span aria-hidden="true" className="h-1.5 w-1.5 flex-none rounded-full" style={{ background: listColor(list) }} />
        <span className="truncate">{list.title}</span>
      </span>,
    )
  }
  if (reminder.assignee !== undefined) {
    parts.push(
      <span key="assignee" className="flex items-center gap-1">
        <Icon icon={UserIcon} size={12} />
        {reminder.assignee.me ? 'You' : reminder.assignee.name}
      </span>,
    )
  }
  if (subtaskCount > 0) parts.push(<span key="subtasks">{subtaskCount === 1 ? '1 subtask' : `${subtaskCount} subtasks`}</span>)
  for (const tag of reminder.tags) parts.push(<span key={`tag:${tag}`}>#{tag}</span>)
  if (reminder.notes !== undefined && reminder.notes.trim() !== '') {
    parts.push(<Icon key="notes" icon={Note01Icon} size={12} aria-label="Has notes" />)
  }
  if (parts.length === 0) return null
  return <span className={`flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[13px] text-dim ${className}`}>{parts}</span>
}

interface ReminderRowProps {
  reminder: Reminder
  list: ReminderList | undefined
  now: { day: string; time: string }
  selected: boolean
  /** Shows which list the row is from, for tiles that mix lists. */
  showList: boolean
  subtaskCount?: number
  nested?: boolean
  canWrite: boolean
  onSelect: (id: string) => void
  onToggle: (reminder: Reminder) => void
  /** The subtask disclosure, drawn left of the ring on a parent. */
  leading?: ReactNode
}

/** One reminder in the list view. The title opens the details; the ring beside it completes. */
export function ReminderRow({
  reminder,
  list,
  now,
  selected,
  showList,
  subtaskCount = 0,
  nested = false,
  canWrite,
  onSelect,
  onToggle,
  leading,
}: ReminderRowProps) {
  const pending = isPendingId(reminder.id)
  return (
    <div
      className={`group/reminder relative flex items-start gap-1.5 rounded-lg py-1 pr-2 ${nested ? 'pl-9' : 'pl-1'} ${
        selected ? 'bg-user-bg' : 'hover:bg-surface-2'
      }`}
    >
      <span className="grid w-5 flex-none place-items-center self-stretch">{leading}</span>
      <CompleteRing reminder={reminder} list={list} size={nested ? 16 : 18} disabled={!canWrite || pending} onToggle={onToggle} />
      <button
        type="button"
        data-reminder-row={reminder.id}
        aria-current={selected ? 'true' : undefined}
        className={`flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 rounded-md border-0 bg-transparent py-[5px] pr-1 text-left ${
          reminder.completed ? 'text-muted' : 'text-text'
        }`}
        onClick={() => onSelect(reminder.id)}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className={`min-w-0 flex-1 truncate ${nested ? 'text-[14px]' : 'text-[15px]'}`}>{reminder.title}</span>
          {reminder.flagged ? <Icon icon={Flag02Icon} size={14} className="flex-none text-warn" aria-label="Flagged" /> : null}
          {reminder.priority === 'none' ? null : (
            <span className="flex-none text-[13px] font-medium text-warn" aria-label={`${reminder.priority} priority`} title={`${reminder.priority} priority`}>
              {reminder.priority === 'high' ? '!!!' : reminder.priority === 'medium' ? '!!' : '!'}
            </span>
          )}
        </span>
        <ReminderMeta reminder={reminder} now={now} {...(showList && list !== undefined ? { list } : {})} subtaskCount={subtaskCount} />
      </button>
    </div>
  )
}
