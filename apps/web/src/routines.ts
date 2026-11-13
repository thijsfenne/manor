import {
  ROUTINE_LATE_AFTER_MS,
  ROUTINE_LEASE_MS,
  type AgentConfig,
  type Chat,
  type Routine,
  type RoutineDraft,
  type RoutineRun,
  routineDmTarget,
} from '@manor/contracts'
import { chatRoster } from './chatRoster'

import { calendarDaysUntil } from '@manor/client-runtime/scheduled'

export { SCHEDULED_ATTENTION_MS, DEFAULT_KIND, scheduledSections, shownKind, type ScheduleKind } from '@manor/client-runtime/scheduled'

/**
 * The one zone routines are written in. There is no picker in V1: a second zone in
 * a one-person house is a field to answer rather than a question anybody has, and
 * the draft carries this so the server never has to guess.
 */
export const DEFAULT_ROUTINE_TIMEZONE = 'Europe/Amsterdam'
export const MAX_ROUTINE_DESCRIPTION_LENGTH = 500

/** The client-side twin of the contract and database constraint. */
export function routineDescriptionProblem(description: string | undefined): string | null {
  return (description ?? '').length > MAX_ROUTINE_DESCRIPTION_LENGTH
    ? `A routine description can be at most ${MAX_ROUTINE_DESCRIPTION_LENGTH} characters.`
    : null
}

/**
 * The schedules the presets can say, which is the whole of what the form offers
 * before the cron field. Held as a shape rather than stored: the row keeps one cron
 * string, and this is a reader and a writer of it.
 */
export type SchedulePreset =
  | { kind: 'daily'; time: string }
  | { kind: 'weekdays'; time: string }
  | { kind: 'weekly'; day: number; time: string }
  | { kind: 'hourly'; hours: number }

export type PresetKind = SchedulePreset['kind']

/** Sunday first, the way cron numbers the days. */
export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

const CLOCK = /^(\d{1,2}):(\d{2})$/
/**
 * What a cron field may be made of. Deliberately coarser than the parser the server
 * runs: `cron-parser` is the authority and refuses a save with a sentence, and
 * shipping a second full parser to the browser would be a second thing to keep in
 * agreement with it. This only catches the typo before the round trip.
 */
const CRON_FIELD = /^[\d*,\-/]+$/

/** The cron a preset means. The presets exist so nobody has to think in this. */
export function writeCron(preset: SchedulePreset): string {
  if (preset.kind === 'hourly') return `0 */${preset.hours} * * *`
  const at = clockFields(preset.time)
  if (at === null) return ''
  const when = `${at.minute} ${at.hour}`
  if (preset.kind === 'daily') return `${when} * * *`
  if (preset.kind === 'weekdays') return `${when} * * 1-5`
  return `${when} * * ${preset.day}`
}

/**
 * The preset a cron came from, or null when it came from the escape hatch. Null is
 * the honest answer for a hand-typed schedule: the form then shows the raw field
 * rather than rounding it to the nearest preset it could pretend it was.
 */
export function readPreset(cron: string): SchedulePreset | null {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string]
  if (dayOfMonth !== '*' || month !== '*') return null

  const everyHours = /^\*\/(\d{1,2})$/.exec(hour)
  if (everyHours !== null) {
    const hours = Number(everyHours[1])
    if (minute !== '0' || dayOfWeek !== '*' || hours < 1 || hours > 23) return null
    return { kind: 'hourly', hours }
  }

  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return null
  const time = clockOf(Number(hour), Number(minute))
  if (time === null) return null
  if (dayOfWeek === '*') return { kind: 'daily', time }
  if (dayOfWeek === '1-5') return { kind: 'weekdays', time }
  if (/^[0-6]$/.test(dayOfWeek)) return { kind: 'weekly', day: Number(dayOfWeek), time }
  return null
}

/** The schedule in words. Raw cron belongs in the editor, never in a management row. */
export function describeCron(cron: string): string {
  const preset = readPreset(cron)
  if (preset !== null) {
    if (preset.kind === 'hourly') {
      return preset.hours === 1 ? 'Every hour' : `Every ${preset.hours} hours`
    }
    if (preset.kind === 'daily') return `Every day at ${preset.time}`
    if (preset.kind === 'weekdays') return `Weekdays at ${preset.time}`
    return `${DAY_NAMES[preset.day]}s at ${preset.time}`
  }

  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return 'Custom schedule'
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [string, string, string, string, string]
  if (!/^\d{1,2}$/.test(minute) || !/^\d{1,2}$/.test(hour)) return 'Custom schedule'
  const time = clockOf(Number(hour), Number(minute))
  if (time === null) return 'Custom schedule'

  const day = Number(dayOfMonth)
  if (/^\d{1,2}$/.test(dayOfMonth) && day >= 1 && day <= 31 && dayOfWeek === '*') {
    if (month === '*') return `Every month on day ${day} at ${time}`
    const monthNumber = Number(month)
    if (/^\d{1,2}$/.test(month) && monthNumber >= 1 && monthNumber <= 12) {
      const monthName = new Intl.DateTimeFormat('en-GB', { month: 'long', timeZone: 'UTC' }).format(
        new Date(Date.UTC(2026, monthNumber - 1, 1)),
      )
      return `Every year on ${monthName} ${day} at ${time}`
    }
  }

  // A fixed clock is still useful without pretending we understand how the custom
  // day fields combine. The exact expression remains one click away in Edit.
  return `Custom schedule at ${time}`
}

/**
 * The schedule in words, one-time or recurring. Components read this rather than
 * `describeCron`, because a one-time routine stores no cron at all.
 */
export function describeSchedule(routine: Pick<RoutineDraft, 'cron' | 'runAt' | 'timezone'>): string {
  if (routine.runAt === undefined || routine.runAt === null) return describeCron(routine.cron)
  return `Once, ${formatMoment(routine.runAt, routine.timezone)}`
}

/** `Mon 28 Sept, 10:00`, in the routine's own zone. */
export function formatMoment(ts: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZone: timezone,
  }).format(new Date(ts))
}

const END_TEXT = { done: 'Done', failed: 'Failed', expired: 'Expired, did not run', cancelled: 'Cancelled' } as const

/** What a switched-off row says instead of its schedule: Off, or how a one-time run ended. */
export function routineOffLabel(routine: Routine): string {
  return routine.endState === null ? 'Off' : END_TEXT[routine.endState].split(',')[0]!
}

/** `Today 10:00`, `Tomorrow 10:00`, otherwise the full moment, in the routine's zone. */
export function formatWhen(ts: number, timezone: string, now: number = Date.now()): string {
  const days = calendarDaysUntil(ts, now, timezone)
  if (days === 0) return `Today ${formatClock(ts, timezone)}`
  if (days === 1) return `Tomorrow ${formatClock(ts, timezone)}`
  return formatMoment(ts, timezone)
}

/**
 * The one line under a one-time task's name: what kind it is, then when it runs or
 * how it ended. The kind comes first because a Reminder and a Check are the
 * difference between a message and a turn that reads sources.
 */
export function onceLine(routine: Routine, now: number = Date.now()): RoutineStatus {
  const kind = routine.action === 'remind' ? 'Reminder' : 'Check'
  const status = routineStatus(routine, now)
  if (routine.endState !== null || status.tone === 'active') return { ...status, text: `${kind} · ${status.text}` }
  const when = routine.runAt === null ? describeSchedule(routine) : formatWhen(routine.runAt, routine.timezone, now)
  return { text: routine.enabled ? `${kind} · ${when}` : `${kind} · Off · ${when}`, tone: 'quiet' }
}

/** A shape check only, so a typo is answered here; the server's parser decides. */
export function looksLikeCron(cron: string): boolean {
  const fields = cron.trim().split(/\s+/)
  return fields.length === 5 && fields.every((field) => CRON_FIELD.test(field))
}

/**
 * The clock time this schedule was meant to fire at, or null when it has none.
 *
 * Only a schedule with a literal hour and minute has one: `every 6 hours` fires at
 * six different times and any single one of them would be a made-up answer. It is
 * what the row compares the actual run against, which is the whole of `ran 09:14 ·
 * scheduled 07:00`.
 */
export function slotClock(cron: string): string | null {
  const preset = readPreset(cron)
  if (preset === null || preset.kind === 'hourly') return null
  return preset.time
}

/** `HH:MM` in the routine's own zone, because that is the zone it was written in. */
export function formatClock(ts: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  }).format(new Date(ts))
}

/** `Tue 07:00`, for a fire that is not today and would otherwise read as one. */
function formatDayClock(ts: number, timezone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timezone,
  }).format(new Date(ts))
}

/** The next scheduled fire, kept separate from status so a completed run cannot hide it. */
export function routineNextRun(routine: Routine, now: number = Date.now()): string {
  if (routine.endState !== null) return 'Not again, it ran once'
  if (routine.nextRunAt === null) return routine.enabled ? 'Schedule unavailable' : 'Not scheduled while off'
  return sameDay(routine.nextRunAt, now, routine.timezone)
    ? `today at ${formatClock(routine.nextRunAt, routine.timezone)}`
    : formatDayClock(routine.nextRunAt, routine.timezone)
}

/** Status plus the next fire, for compact rows that have room for one timeline. */
export function routineTimeline(routine: Routine, now: number = Date.now()): RoutineStatus {
  const status = routineStatus(routine, now)
  if (!routine.enabled) return status
  const next = routineNextRun(routine, now)
  const nextText = next === 'Schedule unavailable' ? 'Next run unavailable' : `Next ${next}`
  const hasOutcome = isRunning(routine, now) || routine.lastRunAt !== null || routine.lastSkippedAt !== null
  return { ...status, text: hasOutcome ? `${status.text} · ${nextText}` : nextText }
}

/** Whether two moments fall on the same day in the routine's zone. */
function sameDay(a: number, b: number, timezone: string): boolean {
  const day = new Intl.DateTimeFormat('en-GB', { dateStyle: 'short', timeZone: timezone })
  return day.format(new Date(a)) === day.format(new Date(b))
}

export interface RoutineStatus {
  text: string
  /**
   * `error` is Manor having turned this off itself, which is the only alarming
   * state; `active` is a run in flight, which is the only state that is about right
   * now rather than about the timetable.
   */
  tone: 'error' | 'active' | 'quiet'
}

/**
 * Whether a run is in flight, read off the same lease the claim takes. Expiring it
 * here as well as in the store is what keeps a server killed mid-turn from leaving a
 * row that says Running for the rest of the week: the claim would take that row
 * again, so the view must not pretend it cannot.
 */
export function isRunning(routine: Routine, now: number = Date.now()): boolean {
  return routine.runningSince !== null && now - routine.runningSince < ROUTINE_LEASE_MS
}

/**
 * Whether a run carries something to read: a failure, a published result with or
 * without text (an image-only answer still counts), or text from a run older than the
 * outcome. Every run the server leaves unread passes this, so every dot can clear.
 */
export const runHasResult = (run: RoutineRun): boolean =>
  run.state === 'failed' ||
  (run.state === 'done' && (run.outcome === 'publish' || (run.outcome === undefined && run.result !== null)))

/**
 * The run the detail shows inline: the newest one with something to read. A quiet
 * check or a run still in flight is skipped, so the block never goes blank because
 * the latest fire had nothing to say.
 */
export const latestResultRun = (runs: readonly RoutineRun[]): RoutineRun | undefined => runs.find(runHasResult)

/** A routine with a run whose result has not been on screen yet. */
export const routineWaiting = (routine: Routine): boolean => routine.unreadRunIds.length > 0

/**
 * Whether any routine has a run nobody has seen, for the Scheduled door's green dot.
 * Switched-off routines count too: Manor turns a routine off after repeated failures,
 * and those failures are exactly what still wants reading.
 */
export const routinesNeedAttention = (routines: readonly Routine[]): boolean => routines.some(routineWaiting)

/** Run threads grouped by their owner, newest execution first. */
export function runsByRoutine(
  chats: readonly Chat[],
  routines: readonly Routine[] = [],
): Record<string, Chat[]> {
  // A routine hung on a DM keeps writing into that conversation. Leftover `run`
  // threads from before the move are not today's history, and their createdAt is
  // the day they were born, not the day the fire happened.
  const hungOnDm = new Set(
    routines.filter((routine) => routine.chatId !== null).map((routine) => routine.id),
  )
  const grouped: Record<string, Chat[]> = {}
  for (const chat of chats) {
    if (chat.routineId === null || hungOnDm.has(chat.routineId)) continue
    ;(grouped[chat.routineId] ??= []).push(chat)
  }
  for (const list of Object.values(grouped)) list.sort((a, b) => b.createdAt - a.createdAt)
  return grouped
}

/**
 * What the row says about time. A laptop that sleeps does not run cron, so the
 * difference between the slot and the run is the fact worth showing, and a skip the
 * grace window dropped is stated rather than left as a run that reads like it
 * happened. A routine that has not run yet says when it will, never a dash.
 */
export function routineStatus(routine: Routine, now: number = Date.now()): RoutineStatus {
  // First, because it is the only line about right now. A routine turned off while
  // its last run is still talking is still talking, and saying "Off" over a live
  // turn would be the row lying about the thing the user is watching for.
  if (isRunning(routine, now)) {
    return { text: `Running since ${formatClock(routine.runningSince ?? now, routine.timezone)}`, tone: 'active' }
  }
  // How a one-time routine ended is its whole remaining story, and a failure or an
  // expiry is the one thing on the row worth an alarming colour.
  if (routine.endState !== null) {
    const at = routine.endedAt === null ? '' : ` ${formatMoment(routine.endedAt, routine.timezone)}`
    const late = routine.endState === 'done' && routine.runAt !== null && routine.lastRunAt !== null &&
      routine.lastRunAt - routine.runAt > ROUTINE_LATE_AFTER_MS
    return {
      text: routine.endState === 'expired' ? END_TEXT.expired : `${END_TEXT[routine.endState]}${at}${late ? ', late' : ''}`,
      tone: routine.endState === 'failed' || routine.endState === 'expired' ? 'error' : 'quiet',
    }
  }
  if (!routine.enabled) {
    return routine.disabledReason === null
      ? { text: 'Off', tone: 'quiet' }
      : { text: `Off: ${routine.disabledReason}`, tone: 'error' }
  }

  const slot = slotClock(routine.cron)
  // The newer of the two stamps is what last happened to this routine, and a skip
  // is only the current state while no run has landed since.
  if (routine.lastSkippedAt !== null && (routine.lastRunAt === null || routine.lastSkippedAt > routine.lastRunAt)) {
    return { text: `Skipped ${slot ?? formatClock(routine.lastSkippedAt, routine.timezone)}`, tone: 'quiet' }
  }

  if (routine.lastRunAt !== null) {
    const ran = formatClock(routine.lastRunAt, routine.timezone)
    return {
      text: slot === null || slot === ran ? `Ran ${ran}` : `Ran ${ran} · scheduled ${slot}`,
      tone: 'quiet',
    }
  }

  // An enabled routine always carries a fire time, the store settles it on every
  // save. Without one the schedule itself is still a true answer to "when next",
  // which beats the dash this branch exists to avoid.
  if (routine.nextRunAt === null) return { text: `Next ${describeSchedule(routine).toLowerCase()}`, tone: 'quiet' }
  return {
    text: `Next ${
      sameDay(routine.nextRunAt, now, routine.timezone)
        ? formatClock(routine.nextRunAt, routine.timezone)
        : formatDayClock(routine.nextRunAt, routine.timezone)
    }`,
    tone: 'quiet',
  }
}

/** A draft for a routine that does not exist yet, seeded with the house's defaults. */
export function emptyRoutineDraft(projectId: string | null, agentId: string, chatId: string | null = null): RoutineDraft {
  return {
    projectId,
    chatId,
    agentId,
    name: '',
    description: '',
    prompt: '',
    cron: writeCron({ kind: 'daily', time: '07:00' }),
    timezone: DEFAULT_ROUTINE_TIMEZONE,
    enabled: true,
    // Off by default: a routine that has not said it wants attention gets none, and
    // its runs stay readable under it rather than in the inbox.
    notify: false,
    // No pin: a new routine runs on whatever its persona runs on. Pinning today's
    // model at creation would quietly outlive the next roster change.
    model: null,
    effort: null,
  }
}

/** The routine as it stands, as the form takes it. */
export function draftOfRoutine(routine: Routine): RoutineDraft {
  return {
    id: routine.id,
    projectId: routine.projectId,
    chatId: routine.chatId,
    agentId: routine.agentId,
    name: routine.name,
    description: routine.description,
    prompt: routine.prompt,
    cron: routine.cron,
    timezone: routine.timezone,
    runAt: routine.runAt,
    lateUntil: routine.lateUntil,
    action: routine.action,
    // Ended means off by ending, not by choice: giving it a new time in the form
    // schedules it again. Without one the store keeps it ended and off.
    enabled: routine.endState !== null || routine.enabled,
    notify: routine.notify,
    model: routine.model,
    effort: routine.effort,
  }
}

/**
 * The personas a routine in this chat could actually reach. The orchestrator drops a
 * target outside a dm's or a group's membership and writes an error note instead, so
 * a form that offered the whole household would build routines that never run.
 */
export function reachableAgents(agents: AgentConfig[], chat: Chat | undefined): AgentConfig[] {
  return chatRoster(agents, chat ?? null, [])
}

/** The real singleton DM when it exists, otherwise the wire request to make it. */
export function routineDmChatId(chats: readonly Chat[], agentId: string): string {
  return chats.find((chat) => chat.kind === 'dm' && chat.memberIds[0] === agentId)?.id ?? routineDmTarget(agentId)
}

function clockFields(time: string): { hour: number; minute: number } | null {
  const match = CLOCK.exec(time.trim())
  if (match === null) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  if (hour > 23 || minute > 59) return null
  return { hour, minute }
}

function clockOf(hour: number, minute: number): string | null {
  if (hour > 23 || minute > 59) return null
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}
