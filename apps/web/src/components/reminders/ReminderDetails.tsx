import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Cancel01Icon, Delete02Icon, Link01Icon } from '@hugeicons/core-free-icons'
import type { Reminder, ReminderChanges, ReminderList, ReminderPriority, ReminderRepeat } from '@manor/contracts'
import { ExternalLink } from '../ExternalLink'
import { Icon } from '../Icon'
import { Button } from '../ui/Button'
import { DOCK_PANEL_SHELL } from '../ui/dockPanel'
import { formInputClass } from '../ui/FormField'
import { IconButton } from '../ui/IconButton'
import { Select, type SelectOption } from '../ui/Select'
import { Switch } from '../ui/Switch'
import { ReminderDatePicker } from './ReminderDatePicker'
import { CompleteRing } from './ReminderRow'
import { dateShortcuts, dayLabel, isPendingId } from './reminderViews'

const PRIORITIES: readonly SelectOption<ReminderPriority>[] = [
  { value: 'none', label: 'None' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
]

type RepeatChoice = 'never' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'current'

const UNIT: Record<ReminderRepeat['frequency'], [string, string]> = {
  daily: ['Daily', 'days'],
  weekly: ['Weekly', 'weeks'],
  monthly: ['Monthly', 'months'],
  yearly: ['Yearly', 'years'],
}

/** How a repeat reads in Reminders.app's own words, custom rules as the label they came with. */
export function describeRepeat(repeat: ReminderRepeat): string {
  if (repeat.custom !== undefined) return repeat.custom
  const [single, plural] = UNIT[repeat.frequency]
  return repeat.interval === 1 ? single : `Every ${repeat.interval} ${plural}`
}

/** A rule the panel can only show, not rewrite, keeps its own option so the field never lies. */
const isPlainRepeat = (repeat: ReminderRepeat | undefined) => repeat === undefined || (repeat.custom === undefined && repeat.interval === 1)

const validTime = (value: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
const validUrl = (value: string) => {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:'
  } catch {
    return false
  }
}

/**
 * A text field that writes when you leave it, not on every key: each write is a trip
 * through RemCTL that takes a few seconds. Enter commits, Escape puts back what the
 * reminder says. While it is not being edited it follows the snapshot, so a change
 * made on the phone shows up here.
 */
function CommitField({
  value,
  label,
  placeholder,
  multiline = false,
  disabled,
  className,
  onCommit,
}: {
  value: string
  label: string
  placeholder?: string
  multiline?: boolean
  disabled: boolean
  className: string
  onCommit: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  // Set by Escape: the blur it causes still holds the edited draft and must not save it.
  const cancelled = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(value)
  }, [value])

  const commit = () => {
    if (draft !== value) onCommit(draft)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setDraft(value)
      cancelled.current = true
      event.currentTarget.blur()
      return
    }
    if (event.key === 'Enter' && (!multiline || event.metaKey) && !event.nativeEvent.isComposing) {
      event.preventDefault()
      event.currentTarget.blur()
    }
  }
  return (
    <textarea
      rows={1}
      value={draft}
      aria-label={label}
      placeholder={placeholder}
      disabled={disabled}
      className={`resize-none [field-sizing:content] ${className}`}
      onFocus={() => {
        focused.current = true
        cancelled.current = false
      }}
      onBlur={() => {
        focused.current = false
        if (cancelled.current) cancelled.current = false
        else commit()
      }}
      onChange={(event) => setDraft(multiline ? event.target.value : event.target.value.replace(/\n/g, ' '))}
      onKeyDown={onKeyDown}
    />
  )
}

/** The same, for a native time, link or text field: it writes on leaving, or at once on Enter. */
function CommitInput({
  type,
  value,
  label,
  disabled,
  valid,
  className = '',
  onCommit,
}: {
  type: 'time' | 'url' | 'text'
  value: string
  label: string
  disabled: boolean
  valid: (value: string) => boolean
  className?: string
  onCommit: (value: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  const cancelled = useRef(false)
  useEffect(() => {
    if (!focused.current) setDraft(value)
  }, [value])
  const commit = () => {
    if (draft !== value && valid(draft)) onCommit(draft)
    else setDraft(value)
  }
  return (
    <input
      type={type}
      value={draft}
      aria-label={label}
      disabled={disabled}
      placeholder={type === 'url' ? 'https://' : undefined}
      className={`${formInputClass} disabled:opacity-45 ${className}`}
      onFocus={() => {
        focused.current = true
        cancelled.current = false
      }}
      onBlur={() => {
        focused.current = false
        if (cancelled.current) cancelled.current = false
        else commit()
      }}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          event.currentTarget.blur()
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          setDraft(value)
          cancelled.current = true
          event.currentTarget.blur()
        }
      }}
    />
  )
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="grid grid-cols-[80px_minmax(0,1fr)] items-start gap-x-3">
      <span className="pt-[7px] text-label text-muted">{label}</span>
      <div className="flex min-w-0 flex-col gap-1.5">
        {children}
        {hint === undefined ? null : <span className="text-meta text-dim">{hint}</span>}
      </div>
    </div>
  )
}

interface ReminderDetailsProps {
  reminder: Reminder
  lists: readonly ReminderList[]
  /** Its subtasks with the client's pending writes laid over them. */
  subtasks: readonly Reminder[]
  now: { day: string; time: string }
  plain: boolean
  canWrite: boolean
  onUpdate: (changes: ReminderChanges) => void
  onToggle: (reminder: Reminder) => void
  onDelete: () => void
  onAddSubtask: (title: string) => void
  onSelect: (id: string) => void
  onClose: () => void
}

/**
 * Every field of one reminder, in the right-hand card beside the list so the list stays
 * in view. Each field writes on its own; the fields the private API owns are left out
 * in plain mode rather than shown and refused.
 */
export function ReminderDetails({
  reminder,
  lists,
  subtasks,
  now,
  plain,
  canWrite,
  onUpdate,
  onToggle,
  onDelete,
  onAddSubtask,
  onSelect,
  onClose,
}: ReminderDetailsProps) {
  const headingId = useId()
  const [confirming, setConfirming] = useState(false)
  const [tag, setTag] = useState('')
  const [subtask, setSubtask] = useState('')
  const list = lists.find((candidate) => candidate.id === reminder.listId)
  const pending = isPendingId(reminder.id)
  // A completed reminder is only read here: its row lives in Completed's own pages,
  // which no write lays anything over, so an edit would show nothing until a reload.
  const editable = canWrite && !pending && !reminder.completed
  const sections = list?.sections ?? []
  const dueDay = reminder.due?.day ?? now.day
  const shared = list !== undefined && list.shared && list.sharees.length > 0
  const repeatValue: RepeatChoice = reminder.repeat === undefined
    ? 'never'
    : isPlainRepeat(reminder.repeat) ? reminder.repeat.frequency : 'current'
  const repeatOptions: SelectOption<RepeatChoice>[] = [
    { value: 'never', label: 'Never' },
    ...(repeatValue === 'current' && reminder.repeat !== undefined ? [{ value: 'current' as const, label: describeRepeat(reminder.repeat) }] : []),
    { value: 'daily', label: 'Daily' },
    { value: 'weekly', label: 'Weekly' },
    { value: 'monthly', label: 'Monthly' },
    { value: 'yearly', label: 'Yearly' },
  ]

  useEffect(() => setConfirming(false), [reminder.id])

  const addTag = () => {
    const next = tag.trim().replace(/^#+/, '')
    setTag('')
    if (next === '' || reminder.tags.includes(next)) return
    onUpdate({ tags: [...reminder.tags, next] })
  }

  const addSubtask = () => {
    const title = subtask.trim()
    if (title === '') return
    setSubtask('')
    onAddSubtask(title)
  }

  return (
    <aside
      aria-labelledby={headingId}
      className={`grid min-h-0 w-[344px] grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)_auto] ${DOCK_PANEL_SHELL}`}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || event.defaultPrevented) return
        event.preventDefault()
        onClose()
      }}
    >
      <div className="flex h-12 items-center gap-1 border-b border-line pr-2 pl-2">
        <CompleteRing reminder={reminder} list={list} disabled={!canWrite || pending} onToggle={onToggle} />
        <h2 id={headingId} className="m-0 min-w-0 flex-1 truncate text-label font-medium text-muted">
          {reminder.completed ? 'Completed' : 'Details'}
        </h2>
        <IconButton icon={Cancel01Icon} label="Close details" title="Close details (Esc)" onClick={onClose} />
      </div>

      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-4 py-4">
        <div className="flex flex-col gap-1">
          <CommitField
            key={`title:${reminder.id}`}
            value={reminder.title}
            label="Title"
            disabled={!editable}
            className="w-full border-0 bg-transparent p-0 text-[17px] leading-snug font-medium text-text outline-none placeholder:text-dim disabled:opacity-100"
            onCommit={(title) => {
              if (title.trim() !== '') onUpdate({ title: title.trim() })
            }}
          />
          <CommitField
            key={`notes:${reminder.id}`}
            value={reminder.notes ?? ''}
            label="Notes"
            placeholder={editable ? 'Notes' : undefined}
            multiline
            disabled={!editable}
            className="min-h-[44px] w-full border-0 bg-transparent p-0 text-[14px] leading-relaxed text-muted outline-none placeholder:text-dim disabled:opacity-100"
            onCommit={(notes) => onUpdate({ notes: notes.trim() === '' ? null : notes })}
          />
        </div>

        <div className="flex flex-col gap-3">
          <Field label="List">
            <Select
              label="List"
              value={reminder.listId}
              options={lists.map((candidate) => ({ value: candidate.id, label: candidate.title }))}
              disabled={!editable}
              onChange={(listId) => {
                if (listId !== reminder.listId) onUpdate({ listId })
              }}
            />
          </Field>

          {plain || sections.length === 0 ? null : (
            <Field label="Section">
              <Select
                label="Section"
                value={reminder.sectionId ?? ''}
                placeholder="No section"
                options={sections.map((section) => ({ value: section.id, label: section.title }))}
                disabled={!editable}
                onChange={(sectionId) => {
                  if (sectionId !== reminder.sectionId) onUpdate({ sectionId })
                }}
              />
            </Field>
          )}

          <Field label="Date">
            <div className="flex items-center gap-1.5">
              <ReminderDatePicker
                key={`day:${reminder.id}`}
                value={reminder.due?.day}
                today={now.day}
                disabled={!editable}
                className="min-w-0 flex-1"
                onPick={(day) => onUpdate({ due: { day, ...(reminder.due?.time === undefined ? {} : { time: reminder.due.time }) } })}
              />
              {reminder.due === undefined ? null : (
                <IconButton icon={Cancel01Icon} label="Remove date" disabled={!editable} onClick={() => onUpdate({ due: null })} />
              )}
            </div>
            <div className="flex flex-wrap gap-1">
              {dateShortcuts(now.day).map((shortcut) => (
                <Button
                  key={shortcut.label}
                  variant="secondary"
                  size="compact"
                  disabled={!editable || reminder.due?.day === shortcut.day}
                  title={dayLabel(shortcut.day, now.day)}
                  onClick={() => onUpdate({ due: { day: shortcut.day, ...(reminder.due?.time === undefined ? {} : { time: reminder.due.time }) } })}
                >
                  {shortcut.label}
                </Button>
              ))}
            </div>
          </Field>

          <Field label="Time" hint={reminder.due === undefined ? 'Needs a date.' : undefined}>
            <div className="flex items-center gap-1.5">
              <CommitInput
                key={`time:${reminder.id}`}
                type="time"
                value={reminder.due?.time ?? ''}
                label="Time"
                disabled={!editable || reminder.due === undefined}
                valid={validTime}
                className="min-w-0 flex-1"
                onCommit={(time) => {
                  if (reminder.due !== undefined) onUpdate({ due: { day: reminder.due.day, time } })
                }}
              />
              {reminder.due?.time === undefined ? null : (
                <IconButton icon={Cancel01Icon} label="Remove time" disabled={!editable} onClick={() => onUpdate({ due: { day: dueDay } })} />
              )}
            </div>
          </Field>

          {plain ? null : (
            <Field label="Repeat" hint={reminder.due === undefined ? 'Needs a date.' : undefined}>
              <Select
                label="Repeat"
                value={repeatValue}
                options={repeatOptions}
                disabled={!editable || reminder.due === undefined}
                onChange={(choice) => {
                  if (choice === repeatValue || choice === 'current') return
                  onUpdate({ repeat: choice === 'never' ? null : { frequency: choice, interval: 1 } })
                }}
              />
            </Field>
          )}

          <Field label="Priority">
            <Select
              label="Priority"
              value={reminder.priority}
              options={PRIORITIES}
              disabled={!editable}
              onChange={(priority) => {
                if (priority !== reminder.priority) onUpdate({ priority })
              }}
            />
          </Field>

          {plain ? null : (
            <div className="grid grid-cols-[80px_minmax(0,1fr)] items-center gap-x-3">
              <span className="text-label text-muted">Flagged</span>
              <Switch label="Flagged" checked={reminder.flagged} disabled={!editable} onChange={(flagged) => onUpdate({ flagged })} />
            </div>
          )}

          {plain || !shared || list === undefined ? null : (
            <Field label="Assigned">
              <Select
                label="Assigned to"
                value={reminder.assignee?.id ?? ''}
                options={[
                  { value: '', label: 'Nobody' },
                  ...list.sharees.map((person) => ({ value: person.id, label: person.me ? `${person.name} (you)` : person.name })),
                ]}
                disabled={!editable}
                onChange={(assigneeId) => {
                  if (assigneeId !== (reminder.assignee?.id ?? '')) onUpdate({ assigneeId: assigneeId === '' ? null : assigneeId })
                }}
              />
            </Field>
          )}

          {plain ? null : (
            <Field label="Link">
              {reminder.url === undefined ? (
                <CommitInput
                  key={`url:${reminder.id}`}
                  type="url"
                  value=""
                  label="Link"
                  disabled={!editable}
                  valid={validUrl}
                  onCommit={(url) => onUpdate({ url })}
                />
              ) : (
                <ExternalLink
                  href={reminder.url}
                  target="_blank"
                  rel="noreferrer"
                  title="A link is removed in Reminders.app"
                  className="flex min-w-0 items-center gap-1.5 py-[7px] text-[13px] text-text underline decoration-line underline-offset-2 hover:decoration-dim"
                >
                  <Icon icon={Link01Icon} size={13} className="flex-none text-muted" />
                  <span className="min-w-0 truncate">{reminder.url}</span>
                </ExternalLink>
              )}
            </Field>
          )}

          {plain ? null : (
            <Field label="Tags">
              {reminder.tags.length === 0 ? null : (
                <ul className="m-0 flex list-none flex-wrap gap-1 p-0">
                  {reminder.tags.map((name) => (
                    <li key={name} className="flex h-6 items-center gap-0.5 rounded-chip bg-surface-2 pr-0.5 pl-2 text-label text-text">
                      #{name}
                      <IconButton
                        icon={Cancel01Icon}
                        iconSize={11}
                        size={20}
                        label={`Remove tag ${name}`}
                        disabled={!editable}
                        onClick={() => onUpdate({ tags: reminder.tags.filter((candidate) => candidate !== name) })}
                      />
                    </li>
                  ))}
                </ul>
              )}
              <input
                value={tag}
                aria-label="Add a tag"
                placeholder="Add a tag"
                disabled={!editable}
                className={`${formInputClass} disabled:opacity-45`}
                onChange={(event) => setTag(event.target.value.replace(/\s/g, ''))}
                onBlur={addTag}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ',') {
                    event.preventDefault()
                    addTag()
                  }
                }}
              />
            </Field>
          )}

          {plain || reminder.parentId !== undefined ? null : (
            <Field label="Subtasks">
              {subtasks.length === 0 ? null : (
                <ul className="m-0 flex list-none flex-col p-0">
                  {subtasks.map((child) => (
                    <li key={child.id} className="flex items-center gap-0.5">
                      <CompleteRing reminder={child} list={list} size={15} disabled={!canWrite || isPendingId(child.id)} onToggle={onToggle} />
                      <button
                        type="button"
                        className="min-w-0 flex-1 cursor-pointer truncate rounded-md border-0 bg-transparent px-1 py-1 text-left text-[13px] text-text hover:bg-surface-2"
                        onClick={() => onSelect(child.id)}
                      >
                        {child.title}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <input
                value={subtask}
                aria-label="Add a subtask"
                placeholder="Add a subtask"
                disabled={!editable}
                className={`${formInputClass} disabled:opacity-45`}
                onChange={(event) => setSubtask(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                    event.preventDefault()
                    addSubtask()
                  }
                }}
              />
            </Field>
          )}
        </div>
      </div>

      <div className="flex min-h-11 items-center border-t border-line px-2">
        {confirming ? (
          <DeleteConfirm
            onConfirm={() => {
              setConfirming(false)
              onDelete()
            }}
            onCancel={() => setConfirming(false)}
          />
        ) : (
          <>
            <span className="min-w-0 flex-1 truncate px-2 text-meta text-dim">
              {reminder.createdAt === undefined ? '' : `Created ${dayLabel(reminder.createdAt.slice(0, 10), now.day)}`}
            </span>
            <Button
              variant="ghost"
              size="compact"
              disabled={!canWrite || pending}
              className="flex items-center gap-1.5 hover:text-danger"
              onClick={() => setConfirming(true)}
            >
              <Icon icon={Delete02Icon} size={14} />
              Delete
            </Button>
          </>
        )}
      </div>
    </aside>
  )
}

/**
 * The details footer's delete confirm. Short on purpose: the panel is 344px, and a
 * question that named the list pushed Cancel out of it. Focus starts on Cancel so a
 * stray Enter is harmless; Escape backs out of the confirm, not the panel.
 */
function DeleteConfirm({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  return (
    <div
      role="group"
      aria-label="Delete this reminder?"
      className="flex min-w-0 flex-1 items-center gap-1.5 pl-2"
      onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        onCancel()
      }}
    >
      <span className="min-w-0 flex-1 truncate text-meta text-muted">Are you sure?</span>
      <Button autoFocus variant="ghost" size="compact" onClick={onCancel}>Cancel</Button>
      <Button variant="danger" size="compact" onClick={onConfirm}>Delete</Button>
    </div>
  )
}
