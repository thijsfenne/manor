import { mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Reminder } from '@manor/contracts'
import { clock, dateKey, wallTime } from './mcp/calendarCreate.js'
import {
  closeItem,
  editLedger,
  noteId,
  parseLedger,
  reminderTitle,
  reopenItem,
  type Closure,
  type Ledger,
  type LedgerItem,
  type LineEdit,
} from './openLoops.js'
import type { RemindersSource } from './reminders.js'

/**
 * Keeps the user's Apple Reminders list "Open loops" a view of the memory folder's
 * `memory/open-loops.md`, both ways, without a model.
 *
 * File to list: every active line (Status open or needs-check outside Suppressed) has
 * one reminder whose notes carry its ledger id; a changed Next retitles it, a changed
 * confirmed Deadline moves its due date, and a line that leaves the active sections
 * gets its reminder completed, never deleted. List to file: a reminder the user completes
 * or deletes moves its line to Suppressed, and un-ticking it brings the line back.
 *
 * The small state file is what tells "deleted" apart from "never created", and "Next
 * changed" apart from "the user renamed the reminder": it holds which reminder shows which
 * line and the ledger values last written to it. Without it (the first run) the sync
 * adopts whatever the list already holds by the ids in the notes.
 */

export const OPEN_LOOPS_LIST = 'Open loops'
/** How often the server looks for ticks made outside Manor, on the phone or in Reminders.app. */
export const OPEN_LOOPS_POLL_MS = 2 * 60_000

/** How long a line the sync closed can still come back by un-ticking its reminder. */
const REOPEN_DAYS = 30
/** A lock older than this belongs to a run that died. */
const LOCK_STALE_MS = 10 * 60_000

interface Tracked {
  reminderId: string
  /** The Next and Deadline last written to the reminder, or found on it. */
  next: string
  deadline: string | null
  /** The line's Checked when a run last saw this reminder open; see `completionStands`. */
  checked: string
}

interface Closed {
  reminderId: string
  /** The Suppressed line as the sync wrote it, and the active line it replaced. */
  line: string
  previous: string
  at: string
}

export interface SyncState {
  tracked: Record<string, Tracked>
  closed: Record<string, Closed>
}

export type Step =
  | { kind: 'create'; id: string; title: string; next: string; deadline: string | null; checked: string }
  | { kind: 'retitle'; id: string; reminderId: string; title: string; next: string }
  | { kind: 'redue'; id: string; reminderId: string; deadline: string | null }
  /** The line left the active sections, or this is a second open reminder for it. */
  | { kind: 'complete'; id: string; reminderId: string; title: string; why: 'left' | 'duplicate' }
  /** The user completed or deleted the reminder. */
  | {
    kind: 'close'
    id: string
    reminderId: string
    closure: Closure
    /** The line's Checked when this was planned and the real completion time, so the edit can judge it again. */
    checked: string
    completedAt: string | undefined
  }
  /** Not in the list any more; confirmed deleted before its line closes. */
  | { kind: 'missing'; id: string; reminderId: string }
  /** A reminder whose line the sync closed is open again. */
  | { kind: 'reopen'; id: string; reminderId: string }

export interface Plan {
  steps: Step[]
  /** Reminders and lines left alone, said once. */
  notes: string[]
  /** The bookkeeping that needs no write: adoptions, and reminders no longer there. */
  state: SyncState
}

/** Amsterdam wall time as `YYYY-MM-DDTHH:MM`, the shape reminders carry. */
export function wallStamp(instant: number): string {
  return `${dateKey(wallTime(instant))}T${clock(instant)}`
}

const oldestFirst = (a: Reminder, b: Reminder) => (a.createdAt ?? '').localeCompare(b.createdAt ?? '')
const newestCompletedFirst = (a: Reminder, b: Reminder) => (b.completedAt ?? '').localeCompare(a.completedAt ?? '')

/**
 * Whether a completed reminder still speaks for its line. Ticked after a run saw it open
 * with the line checked as it is now, it does: nothing in the ledger is newer. Once the
 * line was checked again since, or nobody saw the reminder open (the first run), only a
 * completion on a later day than the last check stands; an older or same-day tick may
 * predate a reopen, so the line keeps going with a fresh reminder.
 */
export function completionStands(item: LedgerItem, seenChecked: string | undefined, completedAt: string | undefined): boolean {
  if (seenChecked !== undefined && seenChecked === item.checked) return true
  const day = completedAt?.slice(0, 10)
  return day !== undefined && item.checkedDay !== undefined && day > item.checkedDay
}

const supersededNote = (item: LedgerItem, reminder: Reminder) =>
  `"${reminder.title}" was completed ${reminder.completedAt?.replace('T', ' ') ?? 'at an unknown time'}, ` +
  `not after [${item.id}] was last checked (${item.checked || 'no date'}); left alone, the line gets a fresh reminder`

/**
 * What one run should do, from the ledger, every reminder in the list and the last
 * state. Pure. `previous` undefined is the first run, which also adopts completed
 * reminders, because the list predates the sync.
 */
export function planSync(ledger: Ledger, reminders: readonly Reminder[], previous: SyncState | undefined, now: number): Plan {
  const bootstrap = previous === undefined
  const state: SyncState = { tracked: { ...previous?.tracked }, closed: { ...previous?.closed } }
  const steps: Step[] = []
  const notes = ledger.skipped.map((entry) => `[${entry.id}] left alone: ${entry.reason} (line ${entry.index + 1})`)
  const byId = new Map(reminders.map((reminder) => [reminder.id, reminder]))
  const active = new Map(ledger.items.filter((item) => item.active).map((item) => [item.id, item]))
  const skipped = new Set(ledger.skipped.map((entry) => entry.id))
  const known = new Set([...ledger.items.map((item) => item.id), ...ledger.suppressed, ...skipped])

  // The id in the notes is the match. A stored reminder id only remembers which reminder
  // that was, and stops counting the moment the reminder no longer carries the line's id.
  const carries = (reminder: Reminder, id: string) => noteId(reminder.notes) === id
  const dropped = new Set<string>()
  for (const [id, tracked] of Object.entries(state.tracked)) {
    const reminder = byId.get(tracked.reminderId)
    if (reminder === undefined || carries(reminder, id)) continue
    delete state.tracked[id]
    dropped.add(reminder.id)
    notes.push(`"${reminder.title}" no longer has [${id}] in its notes, so it no longer shows that line; left alone`)
  }
  for (const [id, closed] of Object.entries(state.closed)) {
    const reminder = byId.get(closed.reminderId)
    if (reminder !== undefined && !carries(reminder, id)) delete state.closed[id]
  }

  const claimed = new Set(Object.values(state.tracked).map((tracked) => tracked.reminderId))
  const untracked = (id: string) => reminders.filter((reminder) => !claimed.has(reminder.id) && carries(reminder, id))
  const adopt = (item: Pick<LedgerItem, 'id' | 'next' | 'deadline' | 'checked'>, reminder: Reminder) => {
    claimed.add(reminder.id)
    // A due date the user set themselves stays until the ledger names a confirmed deadline.
    const deadline = item.deadline === undefined ? null : reminder.due?.day ?? null
    state.tracked[item.id] = { reminderId: reminder.id, next: item.next, deadline, checked: item.checked }
  }
  /** Every open reminder of a line beyond the one that shows it gets completed, never deleted. */
  const completeExtras = (id: string, extras: readonly Reminder[]) => {
    for (const extra of extras) {
      claimed.add(extra.id)
      steps.push({ kind: 'complete', id, reminderId: extra.id, title: extra.title, why: 'duplicate' })
    }
  }
  /** The newest completed reminder of a line, on the first run, when its tick still stands. */
  const completedBeforeTheSync = (item: LedgerItem, candidates: readonly Reminder[]) => {
    const done = candidates.filter((reminder) => reminder.completed).sort(newestCompletedFirst)[0]
    if (done === undefined || completionStands(item, undefined, done.completedAt)) return done
    notes.push(supersededNote(item, done))
    return undefined
  }

  const cutoff = wallStamp(now - REOPEN_DAYS * 86_400_000)
  for (const [id, closed] of Object.entries(state.closed)) {
    if (active.has(id) || closed.at < cutoff) {
      delete state.closed[id]
      continue
    }
    const reminder = byId.get(closed.reminderId)
    if (reminder !== undefined && !reminder.completed) {
      claimed.add(reminder.id)
      steps.push({ kind: 'reopen', id, reminderId: reminder.id })
    }
  }

  for (const item of active.values()) {
    const candidates = untracked(item.id)
    const open = candidates.filter((reminder) => !reminder.completed).sort(oldestFirst)
    const remembered = state.tracked[item.id]
    let tracked = remembered
    let reminder = tracked === undefined ? undefined : byId.get(tracked.reminderId)
    // The stored reminder gives way when its completion is superseded by a newer check,
    // or when it is gone from the list while another there carries the line's id (RemCTL
    // clones a reminder moved between lists). Whatever takes over inherits what was last
    // written, so a Next changed meanwhile still retitles it.
    const superseded = tracked !== undefined && reminder?.completed === true && !completionStands(item, tracked.checked, reminder.completedAt)
    if (superseded) notes.push(supersededNote(item, reminder!))
    if (superseded || (tracked !== undefined && reminder === undefined && open.length > 0)) {
      delete state.tracked[item.id]
      tracked = undefined
      reminder = undefined
    }
    if (tracked === undefined) {
      const pick = open.shift() ?? (bootstrap ? completedBeforeTheSync(item, candidates) : undefined)
      if (pick === undefined) {
        steps.push({
          kind: 'create', id: item.id, title: reminderTitle(item.next), next: item.next, deadline: item.deadline ?? null, checked: item.checked,
        })
        continue
      }
      if (remembered === undefined) {
        adopt(item, pick)
      } else {
        claimed.add(pick.id)
        state.tracked[item.id] = { ...remembered, reminderId: pick.id }
      }
      tracked = state.tracked[item.id]!
      reminder = pick
    }
    completeExtras(item.id, open)
    if (reminder === undefined) {
      steps.push({ kind: 'missing', id: item.id, reminderId: tracked.reminderId })
    } else if (reminder.completed) {
      steps.push({
        kind: 'close', id: item.id, reminderId: reminder.id, closure: { how: 'completed', at: reminder.completedAt ?? wallStamp(now) },
        checked: item.checked, completedAt: reminder.completedAt,
      })
    } else {
      // Seen open: the ledger evidence a later tick is judged against.
      if (tracked.checked !== item.checked) state.tracked[item.id] = { ...tracked, checked: item.checked }
      if (item.next !== tracked.next) {
        steps.push({ kind: 'retitle', id: item.id, reminderId: reminder.id, title: reminderTitle(item.next), next: item.next })
      }
      if ((item.deadline ?? null) !== tracked.deadline) {
        steps.push({ kind: 'redue', id: item.id, reminderId: reminder.id, deadline: item.deadline ?? null })
      }
    }
  }

  // The first run also takes on open reminders of lines that are already closed, so
  // they get completed like any line that leaves.
  if (bootstrap) {
    for (const id of known) {
      if (active.has(id) || skipped.has(id)) continue
      const open = untracked(id).filter((reminder) => !reminder.completed).sort(oldestFirst)
      const first = open.shift()
      if (first !== undefined) adopt({ id, next: '', deadline: undefined, checked: '' }, first)
      completeExtras(id, open)
    }
  }

  for (const [id, tracked] of Object.entries(state.tracked)) {
    if (active.has(id) || skipped.has(id)) continue
    const reminder = byId.get(tracked.reminderId)
    if (reminder !== undefined && !reminder.completed) {
      steps.push({ kind: 'complete', id, reminderId: reminder.id, title: reminder.title, why: 'left' })
    } else {
      delete state.tracked[id]
    }
  }

  for (const reminder of reminders) {
    if (reminder.completed || claimed.has(reminder.id) || dropped.has(reminder.id)) continue
    const id = noteId(reminder.notes)
    if (id !== undefined && skipped.has(id)) continue
    notes.push(id === undefined || !known.has(id)
      ? `"${reminder.title}" has no ledger id in its notes; left alone`
      : `"${reminder.title}" is open but [${id}] is not an active line; left alone`)
  }
  return { steps, notes, state }
}

/** One step as a line for the log and the dry run. */
export function describeStep(step: Step): string {
  switch (step.kind) {
    case 'create':
      return `create "${step.title}" for [${step.id}]${step.deadline === null ? '' : `, due ${step.deadline}`}`
    case 'retitle':
      return `retitle [${step.id}] to "${step.title}"`
    case 'redue':
      return step.deadline === null ? `clear the due date of [${step.id}]` : `set the due date of [${step.id}] to ${step.deadline}`
    case 'complete':
      return step.why === 'left'
        ? `complete "${step.title}": [${step.id}] is no longer an active line`
        : `complete "${step.title}": a second open reminder for [${step.id}]`
    case 'close':
      return step.closure.how === 'completed'
        ? `move [${step.id}] to Suppressed: its reminder was completed ${step.closure.at.replace('T', ' ')}`
        : `move [${step.id}] to Suppressed: its reminder was deleted`
    case 'missing':
      return `check whether the reminder of [${step.id}] was deleted`
    case 'reopen':
      return `move [${step.id}] back to the active lines: its reminder is open again`
  }
}

export interface SyncReport {
  /** What was done, or with `dryRun` what would be. */
  steps: string[]
  notes: string[]
  failures: string[]
  wroteReminders: boolean
}

export interface OpenLoopsSyncOptions {
  source: Pick<RemindersSource, 'listContents' | 'find' | 'write'>
  ledgerPath: string
  statePath: string
  now?: () => number
  log?: (line: string) => void
}

function isState(value: unknown): value is SyncState {
  const record = (item: unknown) => typeof item === 'object' && item !== null && !Array.isArray(item)
  return record(value) && record((value as SyncState).tracked) && record((value as SyncState).closed)
}

async function writeAtomically(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, content)
  await rename(temporary, file)
}

/** Runs `work` under a lock file, so two Manor servers on this Mac never sync at once. */
async function withLock<T>(lockPath: string, work: () => Promise<T>): Promise<T | 'busy'> {
  await mkdir(path.dirname(lockPath), { recursive: true })
  const take = async () => {
    const handle = await open(lockPath, 'wx')
    await handle.writeFile(String(process.pid))
    await handle.close()
  }
  try {
    await take()
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const holder = Number(await readFile(lockPath, 'utf8').catch(() => ''))
    const taken = (await stat(lockPath).catch(() => undefined))?.mtimeMs ?? 0
    const alive = (() => {
      if (!Number.isInteger(holder) || holder <= 0) return false
      try {
        process.kill(holder, 0)
        return true
      } catch (signal: unknown) {
        return (signal as NodeJS.ErrnoException).code === 'EPERM'
      }
    })()
    if (alive && Date.now() - taken < LOCK_STALE_MS) return 'busy'
    await rm(lockPath, { force: true })
    try {
      await take()
    } catch {
      return 'busy'
    }
  }
  try {
    return await work()
  } finally {
    await rm(lockPath, { force: true })
  }
}

export class OpenLoopsSync {
  private readonly now: () => number
  private readonly log: (line: string) => void
  private lastNotes = ''

  constructor(private readonly options: OpenLoopsSyncOptions) {
    this.now = options.now ?? Date.now
    this.log = options.log ?? ((line) => console.log(`[manor] open loops: ${line}`))
  }

  private async readState(): Promise<SyncState | undefined> {
    let raw: string
    try {
      raw = await readFile(this.options.statePath, 'utf8')
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    const parsed: unknown = JSON.parse(raw)
    // A damaged state must not fall back to a first run: that adopts old completed
    // reminders and could close lines reopened since.
    if (!isState(parsed)) throw new Error(`${this.options.statePath} is not a sync state; fix or remove it by hand`)
    return parsed
  }

  /**
   * The close, on the file as it is at this edit attempt. Reading Reminders takes seconds,
   * so the line may have been checked again since the plan; then the tick is judged anew.
   */
  private closeIfStillStands(content: string, step: Extract<Step, { kind: 'close' }>): LineEdit {
    const fresh = parseLedger(content).items.find((entry) => entry.id === step.id)
    if (fresh !== undefined && !completionStands(fresh, step.checked, step.completedAt)) {
      return { outcome: 'skipped', reason: `the line was checked again meanwhile (${fresh.checked}); judged anew on the next run` }
    }
    return closeItem(content, step.id, step.closure)
  }

  /** One sync. `dryRun` reads both sides and reports what it would do, writing nothing. */
  async run({ dryRun = false }: { dryRun?: boolean } = {}): Promise<SyncReport | 'busy'> {
    return withLock(`${this.options.statePath}.lock`, () => this.runLocked(dryRun))
  }

  private async runLocked(dryRun: boolean): Promise<SyncReport> {
    const { source, ledgerPath, statePath } = this.options
    const ledger = parseLedger(await readFile(ledgerPath, 'utf8'))
    const list = await source.listContents(OPEN_LOOPS_LIST)
    if (list === undefined) throw new Error(`there is no Reminders list called ${OPEN_LOOPS_LIST}`)
    const plan = planSync(ledger, list.reminders, await this.readState(), this.now())
    const { state, notes } = plan
    const report: SyncReport = { steps: [], notes, failures: [], wroteReminders: false }
    const done = (step: Step) => {
      report.steps.push(describeStep(step))
      this.log(describeStep(step))
    }
    const fail = (step: Step, reason: string) => {
      const line = `could not ${describeStep(step)}: ${reason}`
      report.failures.push(line)
      this.log(line)
    }

    const steps: Exclude<Step, { kind: 'missing' }>[] = []
    for (const step of plan.steps) {
      if (step.kind !== 'missing') {
        steps.push(step)
        continue
      }
      // Gone from the list is not proof of a delete: it may have moved to another list.
      let found: Reminder | undefined
      try {
        found = await source.find(step.reminderId)
      } catch (error: unknown) {
        fail(step, error instanceof Error ? error.message : 'unknown error')
        continue
      }
      const item = ledger.items.find((entry) => entry.id === step.id)!
      const seen = state.tracked[step.id]?.checked
      if (found !== undefined && noteId(found.notes) !== step.id) {
        delete state.tracked[step.id]
        notes.push(`"${found.title}" no longer has [${step.id}] in its notes, so it no longer shows that line; left alone`)
      } else if (found !== undefined && !found.completed) {
        notes.push(`the reminder of [${step.id}], "${found.title}", moved out of ${OPEN_LOOPS_LIST}; left alone`)
      } else if (!completionStands(item, seen, found?.completedAt)) {
        // When a delete happened is unknown, so it stands only while the line is unchanged.
        notes.push(found === undefined
          ? `the reminder of [${step.id}] was deleted, but the line was checked again since (${item.checked}); left alone, the line gets a fresh reminder`
          : supersededNote(item, found))
        delete state.tracked[step.id]
        steps.push({
          kind: 'create', id: item.id, title: reminderTitle(item.next), next: item.next, deadline: item.deadline ?? null, checked: item.checked,
        })
      } else {
        const closure: Closure = found === undefined
          ? { how: 'deleted', at: wallStamp(this.now()) }
          : { how: 'completed', at: found.completedAt ?? wallStamp(this.now()) }
        steps.push({ kind: 'close', id: step.id, reminderId: step.reminderId, closure, checked: item.checked, completedAt: found?.completedAt })
      }
    }
    if (dryRun) return { ...report, steps: steps.map(describeStep) }

    // The ledger first, in one guarded edit, so a line closes in the same run as the user's tick.
    const ledgerSteps = steps.filter((step) => step.kind === 'close' || step.kind === 'reopen')
    if (ledgerSteps.length > 0) {
      let outcomes = new Map<string, LineEdit>()
      let final = ''
      const written = await editLedger(ledgerPath, (fresh) => {
        outcomes = new Map()
        let content = fresh
        for (const step of ledgerSteps) {
          const closed = state.closed[step.id]
          const edit = step.kind === 'close'
            ? this.closeIfStillStands(content, step)
            : reopenItem(content, step.id, closed!.line, closed!.previous)
          outcomes.set(step.id, edit)
          if (edit.outcome === 'edited') content = edit.content
        }
        final = content
        return content
      })
      if (written === 'conflict') {
        for (const step of ledgerSteps) fail(step, 'open-loops.md kept changing; trying again on the next run')
      } else {
        for (const step of ledgerSteps) {
          const edit = outcomes.get(step.id)!
          if (edit.outcome === 'skipped') {
            fail(step, edit.reason)
          } else if (step.kind === 'close') {
            delete state.tracked[step.id]
            if (edit.outcome === 'edited') {
              state.closed[step.id] = { reminderId: step.reminderId, line: edit.line, previous: edit.previous, at: step.closure.at }
              done(step)
            }
          } else {
            delete state.closed[step.id]
            const item = parseLedger(final).items.find((entry) => entry.id === step.id)
            if (edit.outcome === 'edited' && item !== undefined) {
              state.tracked[step.id] = { reminderId: step.reminderId, next: item.next, deadline: item.deadline ?? null, checked: item.checked }
              done(step)
            }
          }
        }
      }
    }

    for (const step of steps) {
      try {
        switch (step.kind) {
          case 'create': {
            const { createdId } = await source.write({
              kind: 'create',
              listId: list.listId,
              title: step.title,
              changes: { notes: step.id, ...(step.deadline === null ? {} : { due: { day: step.deadline } }) },
            })
            report.wroteReminders = true
            // Without an id back, the next run adopts it by its notes.
            if (createdId !== undefined) {
              state.tracked[step.id] = { reminderId: createdId, next: step.next, deadline: step.deadline, checked: step.checked }
            }
            break
          }
          case 'retitle':
            await source.write({ kind: 'update', id: step.reminderId, changes: { title: step.title } })
            report.wroteReminders = true
            state.tracked[step.id]!.next = step.next
            break
          case 'redue':
            await source.write({
              kind: 'update',
              id: step.reminderId,
              changes: { due: step.deadline === null ? null : { day: step.deadline } },
            })
            report.wroteReminders = true
            state.tracked[step.id]!.deadline = step.deadline
            break
          case 'complete':
            await source.write({ kind: 'complete', id: step.reminderId })
            report.wroteReminders = true
            // A completed duplicate leaves the line's own reminder tracked.
            if (state.tracked[step.id]?.reminderId === step.reminderId) delete state.tracked[step.id]
            break
          default:
            continue
        }
        done(step)
      } catch (error: unknown) {
        fail(step, error instanceof Error ? error.message : 'unknown error')
      }
    }

    await writeAtomically(statePath, `${JSON.stringify(state, null, 2)}\n`)
    const noted = notes.join('\n')
    if (noted !== this.lastNotes) for (const note of notes) this.log(note)
    this.lastNotes = noted
    return report
  }
}
