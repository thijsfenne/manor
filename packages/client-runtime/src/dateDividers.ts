import { isModelOnlyMessage } from '@manor/contracts'
import { dmLiveCard, type Row, type TurnStanding } from './transcriptState'

/**
 * Which centred time line a transcript draws above its rows: none, each new day (a
 * standing pair thread), or in a DM the time whenever a new day or a pause starts a new
 * exchange.
 */
export type DateDividerMode = 'off' | 'days' | 'gaps'

/** A DM restamps after a pause this long, the way a chat app marks a new exchange. */
const STAMP_GAP_MS = 60 * 60 * 1000

const DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })
const STAMP_TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
const STAMP_WEEKDAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short' })
const STAMP_DATE = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' })
const STAMP_DATE_YEAR = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })

const dayKey = (at: Date) => `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`

/** "Today 16:31", "Yesterday 09:12", "Mon 14:02", then the date. */
function stampLabel(at: Date, now: Date): string {
  const time = STAMP_TIME.format(at)
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    - new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()) / 86_400_000)
  if (days === 0) return `Today ${time}`
  if (days === 1) return `Yesterday ${time}`
  if (days > 1 && days < 7) return `${STAMP_WEEKDAY.format(at)} ${time}`
  return `${(at.getFullYear() === now.getFullYear() ? STAMP_DATE : STAMP_DATE_YEAR).format(at)} ${time}`
}

/** A standing piece a DM draws: a whole reply, a task list with lines, or another card. */
const standsInDm = (segment: TurnStanding): boolean =>
  segment.kind === 'reply' ? segment.interrupted !== true
    : segment.kind === 'todo' ? segment.todos.length > 0
      : true

/**
 * When a row that reads as a message, a bubble from the user or an agent, was written;
 * undefined for every other row. Relay lines, system lines, routine and wake lines and a
 * DM turn with nothing whole to show carry no time line and do not start one. A pair
 * chat draws every turn under its speaker. A pending message is being sent now.
 */
function messageTime(row: Row, mode: DateDividerMode, now: number): number | undefined {
  if (row.kind === 'pending') return now
  if (row.kind === 'turn') {
    const shows = mode === 'days'
      || row.tail.some(standsInDm)
      || (row.live?.state === 'running' && row.segments.some(dmLiveCard))
      || (row.files?.length ?? 0) > 0 || (row.connects?.length ?? 0) > 0 || row.fileWrites !== undefined || row.sessionLinks !== undefined
    return shows ? row.startedAt : undefined
  }
  if (row.kind !== 'event' || row.event.type !== 'user_message') return undefined
  const event = row.event
  const bubble = event.source === 'agent_relay'
    || (event.source === undefined && row.confirmTasks === undefined && !isModelOnlyMessage(event))
  return bubble ? event.ts : undefined
}

/**
 * The time line above each row, by index. It stands only directly above a message, and
 * whether it is due is measured from the message before, so the rows in between never
 * stack lines of their own.
 */
export function dateDividers(rows: readonly Row[], mode: DateDividerMode, now = Date.now()): Array<string | undefined> {
  if (mode === 'off') return rows.map(() => undefined)
  const today = new Date(now)
  let previous: Date | undefined
  const labels = rows.map((row) => {
    const timestamp = messageTime(row, mode, now)
    if (timestamp === undefined) return undefined
    const at = new Date(timestamp)
    const newDay = previous === undefined || dayKey(previous) !== dayKey(at)
    const due = newDay || at.getTime() - previous!.getTime() >= STAMP_GAP_MS
    previous = at
    if (mode === 'days') return newDay ? DAY.format(at) : undefined
    return due ? stampLabel(at, today) : undefined
  })
  // An incoming relay line introduces the message under it, so the time stands above both.
  for (let index = 1; index < labels.length; index += 1) {
    if (labels[index] === undefined) continue
    let top = index
    while (top > 0 && labels[top - 1] === undefined && isIncomingRelay(rows[top - 1]!)) top -= 1
    if (top !== index) [labels[top], labels[index]] = [labels[index], undefined]
  }
  return labels
}

const isIncomingRelay = (row: Row): boolean => row.kind === 'event' && row.event.type === 'agent_relay' && row.event.phase === 'received'
