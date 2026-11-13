import { useState } from 'react'
import type { AgentConfig, Chat, Effort, Project, RoutineDraft } from '@manor/contracts'
import { SINGLE_CHAT_VOICE, driverForModel, epochToWallClock, readWallClock } from '@manor/contracts'
import { SINGLE_DRIVERS, defaultSingleRuntime } from '../../runtimeChoices'
import {
  DAY_NAMES,
  describeSchedule,
  formatMoment,
  looksLikeCron,
  MAX_ROUTINE_DESCRIPTION_LENGTH,
  readPreset,
  reachableAgents,
  routineDmChatId,
  routineDescriptionProblem,
  writeCron,
  type PresetKind,
  type SchedulePreset,
} from '../../routines'
import { EFFORTS, MODELS, effortsFor } from '../../runtimes'
import { HOME_PROJECT_ID, type Notice } from '../../state'
import { Modal, ModalFooter } from '../Modal'
import { Button } from '../ui/Button'
import { Checkbox } from '../ui/Checkbox'
import {
  FormField,
  formFieldClass,
  formHintClass,
  formInputClass,
  formLabelClass,
} from '../ui/FormField'
import { Select, type SelectOption } from '../ui/Select'

/** A request that never left the browser. Nothing changed, and saying so is the point. */
const OFFLINE = 'Nothing was sent, the connection is down. Try again once it is back.'

type ShapeKind = PresetKind | 'once'

const PRESETS: SelectOption<ShapeKind>[] = [
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Once a week' },
  { value: 'hourly', label: 'Every few hours' },
  { value: 'once', label: 'Once' },
]

const DAYS: SelectOption<string>[] = DAY_NAMES.map((name, day) => ({ value: String(day), label: name }))

const HOURS: SelectOption<string>[] = [2, 3, 4, 6, 8, 12].map((hours) => ({
  value: String(hours),
  label: `${hours} hours`,
}))

/**
 * Everything the presets need at once, so switching between them keeps the time
 * that was already picked instead of resetting it. Only ever read back out through
 * `writeCron`: the cron string on the draft stays the single stored schedule.
 */
interface ScheduleShape {
  kind: ShapeKind
  time: string
  day: number
  hours: number
  /** One time only, as the `datetime-local` inputs hold them, in the routine's zone. */
  at: string
  lateUntil: string
}

const DEFAULT_SHAPE: ScheduleShape = { kind: 'daily', time: '07:00', day: 1, hours: 6, at: '', lateUntil: '' }

export interface FixedRoutineTarget {
  kind: 'dm'
  chatId: string
  agentId: string
}

/** A chat-scoped editor may change the routine, never which conversation owns it. */
export const bindFixedRoutineTarget = (
  draft: RoutineDraft,
  target: FixedRoutineTarget | undefined,
): RoutineDraft =>
  target === undefined
    ? draft
    : {
        ...draft,
        projectId: null,
        chatId: target.chatId,
        agentId: target.agentId,
        model: null,
        effort: null,
      }

interface RoutineDialogProps {
  /** The routine as it stands. Copied into the form once; this dialog is mounted per routine. */
  initial: RoutineDraft
  /** The rooms a routine's runs can land in; it outlives whichever chat is open. */
  projects: Project[]
  chats: Chat[]
  agents: AgentConfig[]
  /** Hides and pins destination fields when the editor belongs to one direct message. */
  fixedTarget?: FixedRoutineTarget
  /** The server's answer to this save. An error means nothing changed. */
  notice: Notice | null
  /** A save is out and unanswered; a second one would be a second act. */
  pending: 'save' | null
  /** False when the socket was down and nothing left the house. */
  onSave: (draft: RoutineDraft) => boolean
  /** Every edit makes the server's last answer stale; it was about the draft as it was. */
  onDismissNotice: () => void
  onClose: () => void
}

/**
 * One routine, whole: what it is called, where it posts, who answers, what it says
 * and when it fires. Modelled on `PersonaDialog` down to the settle rule — the form
 * holds its own values so a refused save keeps every one of them, and only the
 * server's own routines list closes it.
 */
export function RoutineDialog({
  initial,
  projects,
  chats,
  agents,
  fixedTarget,
  notice,
  pending,
  onSave,
  onDismissNotice,
  onClose,
}: RoutineDialogProps) {
  const [draft, setDraft] = useState(() => bindFixedRoutineTarget(initial, fixedTarget))
  const [shape, setShape] = useState<ScheduleShape>(() => initialShape(initial))
  // Open from the start for a schedule no preset wrote, because otherwise the form
  // would show a preset row that has nothing to do with what this routine does.
  const [custom, setCustom] = useState(() => (initial.runAt ?? null) === null && readPreset(initial.cron) === null)
  // Something this dialog knows and the server does not, a save that never left the
  // browser above all.
  const [problem, setProblem] = useState<string | null>(null)

  const existing = initial.id !== undefined
  const busy = pending !== null
  const single = draft.agentId === SINGLE_CHAT_VOICE.id
  // "No project" is the home room, which works in the memory system.
  const projectOptions = [
    { value: HOME_PROJECT_ID, label: 'No project' },
    ...projects.map((entry) => ({ value: entry.id, label: entry.name })),
  ]
  const targetKind = single || draft.projectId !== null ? 'project' : 'dm'
  // Routines run in DMs and run threads, which seat chat personas only.
  const chatAgents = agents.filter((agent) => agent.placement !== 'session')
  const projectAgents = reachableAgents(chatAgents, undefined)
  const reachable = draft.projectId === null ? chatAgents : projectAgents
  const persona = agents.find((agent) => agent.id === draft.agentId)
  // The models this persona's provider offers, plus whatever she is already pinned to
  // if the roster has moved on since — offered as itself rather than dropped, so
  // opening the form never silently changes what a routine runs on.
  const known = single ? SINGLE_DRIVERS.flatMap((driver) => MODELS[driver]) : persona === undefined ? [] : MODELS[persona.driver]
  const modelOptions: SelectOption<string>[] = [
    ...(single ? [] : [{ value: '', label: `${persona?.name ?? 'Persona'}'s own` }]),
    ...known,
    ...(draft.model !== null && draft.model !== '' && !known.some((model) => model.value === draft.model)
      ? [{ value: draft.model, label: draft.model }]
      : []),
  ]
  const effortLevels =
    single ? effortsFor(driverForModel(draft.model ?? '') ?? 'claude', draft.model ?? undefined) : persona === undefined ? EFFORTS : effortsFor(persona.driver, draft.model ?? persona.model)
  const effortOptions: SelectOption<string>[] = [
    ...(single ? [] : [{ value: '', label: `${persona?.name ?? 'Persona'}'s own` }]),
    ...effortLevels,
  ]

  const edit = (patch: Partial<RoutineDraft>) => {
    setProblem(null)
    onDismissNotice()
    setDraft((current) => ({ ...current, ...patch }))
  }

  const editTarget = (kind: string) => {
    if (kind === 'dm') {
      const agentId = chatAgents.some((agent) => agent.id === draft.agentId)
        ? draft.agentId
        : chatAgents[0]?.id ?? ''
      edit({
        projectId: null,
        chatId: agentId === '' ? null : routineDmChatId(chats, agentId),
        agentId,
        model: null,
        effort: null,
      })
      return
    }
    if (projectAgents.length === 0) {
      const runtime = defaultSingleRuntime(agents)
      edit({ projectId: projects[0]?.id ?? HOME_PROJECT_ID, chatId: null, agentId: SINGLE_CHAT_VOICE.id, model: runtime.model, effort: runtime.effort, action: 'run' })
      return
    }
    const agentId = projectAgents.some((agent) => agent.id === draft.agentId)
      ? draft.agentId
      : projectAgents[0]?.id ?? ''
    // A literal reminder is posted in a DM; a project run always runs the persona.
    edit({ projectId: projects[0]?.id ?? HOME_PROJECT_ID, chatId: null, agentId, action: 'run' })
  }

  const editModel = (model: string) => {
    const nextModel = model === '' ? null : model
    const levels = single ? effortsFor(driverForModel(model) ?? 'claude', model) : persona === undefined ? EFFORTS : effortsFor(persona.driver, nextModel ?? persona.model)
    const keepsEffort =
      draft.effort === null || levels.some((option) => option.value === draft.effort)
    edit({ model: nextModel, ...(keepsEffort ? {} : { effort: 'high' }) })
  }

  const editShape = (patch: Partial<ScheduleShape>) => {
    let next = { ...shape, ...patch }
    // Switching to Once proposes tomorrow at the time already picked, so the field
    // never opens on an empty moment that reads as "now".
    if (next.kind === 'once' && next.at === '') {
      next = { ...next, at: `${epochToWallClock(Date.now() + 24 * 60 * 60 * 1000, draft.timezone).slice(0, 10)}T${next.time}` }
    }
    setShape(next)
    if (next.kind !== 'once') {
      edit({ cron: writeCron(presetOf(next)), runAt: null, lateUntil: null })
      return
    }
    edit({
      cron: '',
      runAt: momentOf(next.at, draft.timezone),
      lateUntil: next.lateUntil === '' ? null : momentOf(next.lateUntil, draft.timezone),
      // A one-time result is something asked for by name; a new one tells by default.
      ...(shape.kind !== 'once' && !existing ? { notify: true } : {}),
    })
  }
  const once = shape.kind === 'once'
  const runAt = draft.runAt ?? null
  const lateUntil = draft.lateUntil ?? null

  /**
   * The escape hatch writes the same one field the presets do. When what is typed
   * happens to be a preset the row above resyncs to it, so the two controls can
   * never end up describing different schedules.
   */
  const editCron = (cron: string) => {
    edit({ cron })
    const preset = readPreset(cron)
    if (preset !== null) setShape(shapeOf(preset))
  }

  const submit = () => {
    if (busy) return
    setProblem(null)
    // Re-apply the contextual target at the save boundary too. Hidden controls are
    // presentation; this is what makes moving the routine impossible from this form.
    const submitted = bindFixedRoutineTarget(draft, fixedTarget)
    // Rules the server holds too, answered here because a round trip to be told the
    // empty box is empty is a round trip for nothing.
    if ((submitted.agentId !== SINGLE_CHAT_VOICE.id && (submitted.projectId === null) === (submitted.chatId === null)) || submitted.agentId === '') {
      setProblem('Pick one destination and a persona to answer.')
      return
    }
    if (submitted.name.trim() === '' || submitted.prompt.trim() === '') {
      setProblem('Give it a name and a prompt.')
      return
    }
    const descriptionProblem = routineDescriptionProblem(submitted.description)
    if (descriptionProblem !== null) {
      setProblem(descriptionProblem)
      return
    }
    if (once) {
      // A moment the zone skips or passes twice reads as no moment; say which.
      const unreadable = [shape.at, shape.lateUntil]
        .map((wall) => wall === '' ? undefined : readWallClock(wall, draft.timezone))
        .find((reading) => reading?.ok === false)
      if (unreadable?.ok === false) {
        setProblem(unreadable.reason)
        return
      }
      if (runAt === null) {
        setProblem('Pick the date and time it should run.')
        return
      }
      // Moving an ended one-time routine is how it is scheduled again, so only a new
      // or moved moment has to be in the future.
      if ((!existing || runAt !== (initial.runAt ?? null)) && runAt <= Date.now()) {
        setProblem('That moment has already passed. Pick a time in the future.')
        return
      }
      if (lateUntil !== null && lateUntil < runAt) {
        setProblem('The latest useful time cannot be before the scheduled time.')
        return
      }
      if (!onSave(submitted)) setProblem(OFFLINE)
      return
    }
    if (submitted.cron.trim() === '') {
      setProblem('Pick a schedule.')
      return
    }
    if (!looksLikeCron(submitted.cron)) {
      setProblem(`That schedule could not be read: "${submitted.cron.trim()}" is not a cron expression.`)
      return
    }
    if (!onSave(submitted)) setProblem(OFFLINE)
  }

  return (
    <Modal
      title={existing ? `Edit ${initial.name}` : 'New task'}
      // The destination controls are gone here and the card covers the panel that
      // established them, so the one sentence is all that is left saying where this lands.
      subtitle={
        fixedTarget === undefined || persona === undefined
          ? undefined
          : `Runs in your conversation with ${persona.name}.`
      }
      width="wide"
      onClose={onClose}
    >
      <FormField label="Name" hint="What the row is called, and what the transcript line says when it fires.">
        <input
          className={formInputClass}
          autoFocus
          value={draft.name}
          placeholder="Morning brief"
          onChange={(event) => edit({ name: event.target.value })}
        />
      </FormField>

      <FormField label="Description" optional hint="One sentence about why this exists.">
        <input
          className={formInputClass}
          value={draft.description ?? ''}
          maxLength={MAX_ROUTINE_DESCRIPTION_LENGTH}
          placeholder="Sorts new vault notes into the right place."
          onChange={(event) => edit({ description: event.target.value })}
        />
      </FormField>

      {fixedTarget === undefined ? (
        <div className="flex gap-3 max-[640px]:flex-col">
          {!single ? <FormField
            label="Destination"
            custom
            className="min-w-0 flex-1"
            hint={
              targetKind === 'dm'
                ? 'Adds an ordinary turn to this persona’s ongoing direct message.'
                : 'Creates a separate run thread in this project.'
            }
          >
            <Select
              label="Destination"
              value={targetKind}
              options={[
                ...(projects.length > 0
                  ? [{ value: 'project', label: 'Project run' }]
                  : []),
                { value: 'dm', label: 'Direct message' },
              ]}
              onChange={editTarget}
            />
          </FormField> : null}
          {targetKind === 'project' ? (
            <FormField
              label="Project"
              optional={single}
              custom
              className="min-w-0 flex-1"
              hint="Runs appear under this task. Choose a project to include its context."
            >
              <Select
                label="Project"
                value={draft.projectId ?? (single ? HOME_PROJECT_ID : '')}
                options={projectOptions}
                placeholder="Pick a room…"
                onChange={(projectId) => edit({ projectId, chatId: null })}
              />
            </FormField>
          ) : null}
        </div>
      ) : null}

      {fixedTarget === undefined ? (
        <div className="flex gap-3 max-[640px]:flex-col">
          <FormField
            label="Agent"
            custom
            className="min-w-0 flex-1"
            hint={single ? 'Runs without a Manor persona, using the model selected below.' : 'Answers every time this fires.'}
          >
            <Select
              label="Agent"
              value={draft.agentId}
              options={[
                { value: SINGLE_CHAT_VOICE.id, label: 'Single agent' },
                ...reachable.map((agent) => ({ value: agent.id, label: agent.name })),
              ]}
              placeholder="Pick a persona…"
              // Pins belong to a provider's model catalogue. Carrying one across a
              // persona switch can leave a Claude routine pinned to a Codex model.
              onChange={(agentId) => {
                if (agentId === SINGLE_CHAT_VOICE.id) {
                  const runtime = defaultSingleRuntime(agents)
                  edit({ agentId, projectId: draft.projectId, chatId: null, model: runtime.model, effort: runtime.effort, action: 'run' })
                  return
                }
                edit({
                  agentId,
                  model: null,
                  effort: null,
                  ...(draft.projectId === null ? { chatId: routineDmChatId(chats, agentId) } : {}),
                })
              }}
            />
          </FormField>
        </div>
      ) : null}

      {/* The pin, written onto each run thread as the same override a chat carries.
          Empty means the persona's own settings, which is what a routine nobody has
          told otherwise should do. */}
      {targetKind === 'project' ? (
        <div className="flex gap-3 max-[640px]:flex-col">
          <FormField
            label="Model"
            optional={!single}
            custom
            className="min-w-0 flex-1"
            hint={single ? 'The model used for every run.' : `Empty runs on whatever ${persona?.name ?? 'this persona'} runs on.`}
          >
            <Select
              label="Model"
              value={draft.model ?? ''}
              options={modelOptions}
              onChange={editModel}
            />
          </FormField>
          <FormField label="Effort" optional={!single} custom className="w-[148px] flex-none">
            <Select
              label="Effort"
              value={draft.effort ?? ''}
              options={effortOptions}
              onChange={(effort) => edit({ effort: effort === '' ? null : (effort as Effort) })}
            />
          </FormField>
        </div>
      ) : null}

      <FormField
        label="Prompt"
        hint={
          draft.action === 'remind'
            ? 'The exact reminder. It is posted as this persona’s message, word for word, with no model call.'
            : targetKind === 'dm'
            ? 'The instruction arrives as an ordinary turn, with everything since this persona last spoke as catch-up.'
            : 'The whole instruction. It runs with nobody in the room, so there is no follow-up question to answer.'
        }
      >
        <textarea
          className={`${formInputClass} min-h-[140px] resize-y leading-relaxed`}
          value={draft.prompt}
          placeholder="Read yesterday's commits and tell me what changed."
          onChange={(event) => edit({ prompt: event.target.value })}
        />
      </FormField>

      {/* Not a <label>: it wraps several controls, and a label would fire the first one. */}
      <div className={formFieldClass}>
        <span className={formLabelClass}>Schedule</span>
        <div className="flex flex-wrap items-center gap-2.5">
          <Select
            label="Repeat"
            className="w-[168px] flex-none"
            value={shape.kind}
            options={PRESETS}
            onChange={(kind) => editShape({ kind })}
          />
          {once ? (
            <input
              className={`${formInputClass} w-[220px] flex-none`}
              type="datetime-local"
              value={shape.at}
              aria-label="Date and time"
              onChange={(event) => editShape({ at: event.target.value })}
            />
          ) : shape.kind === 'hourly' ? (
            <Select
              label="Interval"
              className="w-[132px] flex-none"
              value={String(shape.hours)}
              options={HOURS}
              onChange={(hours) => editShape({ hours: Number(hours) })}
            />
          ) : (
            <>
              {shape.kind !== 'weekly' ? null : (
                <Select
                  label="Day"
                  className="w-[148px] flex-none"
                  value={String(shape.day)}
                  options={DAYS}
                  onChange={(day) => editShape({ day: Number(day) })}
                />
              )}
              <input
                className={`${formInputClass} w-[112px] flex-none`}
                type="time"
                value={shape.time}
                aria-label="Time of day"
                onChange={(event) => editShape({ time: event.target.value })}
              />
            </>
          )}
        </div>

        {/* What will actually be stored, said in both languages. A laptop that sleeps
            does not run cron, and this is the only place to say so before the save. */}
        <span className={formHintClass}>
          {once
            ? runAt === null
              ? 'Pick a date and time; a one-time task with no moment has nothing to fire on.'
              : `${describeSchedule(draft)}, ${draft.timezone}. It runs once. If the Mac is asleep then, it runs when Manor is back and says it is late${lateUntil === null ? '' : `, unless that is after ${formatMoment(lateUntil, draft.timezone)}`}.`
            : draft.cron.trim() === ''
              ? 'Pick a time; without a schedule it has nothing to fire on.'
              : `${describeSchedule(draft)}, Europe/Amsterdam. A missed slot fires shortly after the Mac wakes, or is skipped when that is too late to be what you wanted.`}
        </span>

        {once ? (
          <label className="flex flex-wrap items-center gap-2.5 text-label text-muted">
            <span>Only useful until</span>
            <input
              className={`${formInputClass} w-[220px] flex-none`}
              type="datetime-local"
              value={shape.lateUntil}
              aria-label="Latest useful time"
              onChange={(event) => editShape({ lateUntil: event.target.value })}
            />
            <span className="text-dim">Optional. Past this it is marked expired instead of running late.</span>
          </label>
        ) : null}

        {once ? null : <details className="text-label text-dim" open={custom} onToggle={(event) => setCustom(event.currentTarget.open)}>
          <summary className="w-fit cursor-pointer text-muted hover:text-text">Custom cron</summary>
          <input
            className={`${formInputClass} mt-2 font-mono`}
            value={draft.cron}
            placeholder="0 7 * * 1-5"
            aria-label="Cron expression"
            onChange={(event) => editCron(event.target.value)}
          />
          <p className="mt-1.5 mb-0">
            Five fields, minute first. The presets above write this one field; typing here is the way
            to say something they cannot.
          </p>
        </details>}
      </div>

      {targetKind === 'dm' && !single ? (
        <FormField label="What it does" custom>
          <label className="flex cursor-pointer items-start gap-2.5 text-label text-muted">
            <Checkbox
              className="mt-0.5"
              checked={draft.action === 'remind'}
              onChange={(remind) => edit({ action: remind ? 'remind' : 'run' })}
            />
            <span>
              Just remind me. Posts the prompt as the reminder, without running {persona?.name ?? 'the persona'}.
              Leave this off when something has to be checked at that time.
            </span>
          </label>
        </FormField>
      ) : null}

      {/* The one inbox rule, as a switch rather than a guess. Off means the run's
          thread is born settled: it exists and is readable under this routine, and
          never asks for attention. */}
      <FormField label="When it finishes" custom>
        <label className="flex cursor-pointer items-start gap-2.5 text-label text-muted">
          <Checkbox className="mt-0.5" checked={draft.notify} onChange={(notify) => edit({ notify })} />
          <span>
            Tell me. Leave this off when the result can wait in its{' '}
            {targetKind === 'dm' ? 'conversation' : 'run thread'} without asking for attention.
          </span>
        </label>
      </FormField>

      {/* The server refused, or the browser did. Either way nothing changed, and the
          form keeps every value so the fix is one edit away. */}
      {notice !== null || problem !== null ? (
        <p
          className={`m-0 px-0.5 pt-1 text-label ${
            notice !== null && notice.kind !== 'error' ? 'text-muted' : 'text-danger'
          }`}
          role="status"
        >
          <span className="[overflow-wrap:anywhere]">{notice?.text ?? problem}</span>
        </p>
      ) : null}

      <ModalFooter>
        <div className="flex items-center justify-end gap-2 pt-0.5">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || draft.name.trim() === ''} onClick={submit}>
            {busy ? 'Saving…' : existing ? 'Save' : 'Create'}
          </Button>
        </div>
      </ModalFooter>
    </Modal>
  )
}

function initialShape(initial: RoutineDraft): ScheduleShape {
  const runAt = initial.runAt ?? null
  if (runAt === null) return shapeOf(readPreset(initial.cron))
  const lateUntil = initial.lateUntil ?? null
  return {
    ...DEFAULT_SHAPE,
    kind: 'once',
    at: epochToWallClock(runAt, initial.timezone),
    lateUntil: lateUntil === null ? '' : epochToWallClock(lateUntil, initial.timezone),
  }
}

function shapeOf(preset: SchedulePreset | null): ScheduleShape {
  if (preset === null) return DEFAULT_SHAPE
  if (preset.kind === 'hourly') return { ...DEFAULT_SHAPE, kind: 'hourly', hours: preset.hours }
  if (preset.kind === 'weekly') return { ...DEFAULT_SHAPE, kind: 'weekly', day: preset.day, time: preset.time }
  return { ...DEFAULT_SHAPE, kind: preset.kind, time: preset.time }
}

function presetOf(shape: ScheduleShape): SchedulePreset {
  if (shape.kind === 'once') return { kind: 'daily', time: shape.time }
  if (shape.kind === 'hourly') return { kind: 'hourly', hours: shape.hours }
  if (shape.kind === 'weekly') return { kind: 'weekly', day: shape.day, time: shape.time }
  return { kind: shape.kind, time: shape.time }
}

/** The instant a `datetime-local` value names, or null when there is no single one. */
function momentOf(wall: string, timezone: string): number | null {
  const reading = readWallClock(wall, timezone)
  return reading.ok ? reading.at : null
}
