import type {
  AgentConfig,
  Chat,
  ClientMessage,
  Routine,
  ServerMessage,
} from '@manor/contracts'
import { isRoutineDmTarget, SINGLE_CHAT_VOICE } from '@manor/contracts'
import type { Orchestrator } from './orchestrator.js'
import { routineRuns } from './routineHistory.js'
import { checkCron, checkTimezone, formatMoment } from './routineSchedule.js'
import { runRoutineNow } from './routineScheduler.js'
import { singleRoutineRuntime } from './singleChat.js'
import {
  parseMoment,
  RoutineToolCancelInputSchema,
  RoutineToolSaveInputSchema,
  type RoutineToolContext,
  type RoutineToolInput,
  type RoutineToolName,
} from './routineTool.js'
import type { HouseholdChange, Store } from './store.js'

type RoutineRuntime = Pick<Orchestrator, 'discard' | 'isActiveTurn' | 'submitUserMessage'>

type RoutineClientMessage = Extract<
  ClientMessage,
  {
    type:
      | 'get_routine_runs'
      | 'mark_routine_runs_read'
      | 'mark_all_routine_runs_read'
      | 'save_routine'
      | 'delete_routine'
      | 'set_routine_enabled'
      | 'run_routine_now'
  }
>

interface RoutineModuleOptions {
  store: Store
  agents: () => readonly AgentConfig[]
  orchestrator: RoutineRuntime
  knownChats: () => readonly Chat[]
  broadcast: (message: ServerMessage) => void
  broadcastDirectory: () => Promise<void>
  replaceDirectory: () => Promise<ServerMessage>
  announceFinished: (chatId: string, startedAt: number, alert: boolean) => void
  onChatsDeleted?: (chatIds: readonly string[]) => void
}

/** What a persona sees of one routine: every field it may set, plus how it stands. */
const routineToolRow = (routine: Routine) => ({
  routineId: routine.id,
  name: routine.name,
  prompt: routine.prompt,
  action: routine.action,
  ...(routine.runAt === null
    ? { cron: routine.cron }
    : {
        runAt: formatMoment(routine.runAt, routine.timezone),
        ...(routine.lateUntil === null ? {} : { lateUntil: formatMoment(routine.lateUntil, routine.timezone) }),
      }),
  timezone: routine.timezone,
  enabled: routine.enabled,
  notify: routine.notify,
  status: routineToolStatus(routine),
  nextRunAt: routine.nextRunAt === null ? null : formatMoment(routine.nextRunAt, routine.timezone),
  lastRunAt: routine.lastRunAt === null ? null : formatMoment(routine.lastRunAt, routine.timezone),
})

/** One word a persona can repeat to the user without reading timestamps. */
function routineToolStatus(routine: Routine): string {
  if (routine.endState !== null) return routine.endState
  if (routine.runningSince !== null) return 'running'
  if (!routine.enabled) return 'off'
  return routine.runAt === null ? 'active' : 'scheduled'
}

/**
 * Owns every way routine state changes or executes. The protocol layer only
 * correlates requests and delegates routine messages here; the scheduler and the
 * built-in DM tools cross the same interface rather than recreating the rules.
 */
export class RoutineModule {
  private knownRoutines: Routine[] | undefined

  constructor(private readonly options: RoutineModuleOptions) {}

  /** Household document sent on connect and after every routine mutation. */
  async document(): Promise<ServerMessage> {
    return { type: 'routines', routines: await this.options.store.listRoutines() }
  }

  async broadcast(): Promise<void> {
    const routines = await this.options.store.listRoutines()
    // A normal broadcast may race ahead of an external delete's Realtime event. It
    // may teach the snapshot about new rows, but only that event may prune old ones
    // after their active runs and native state have been cleaned up.
    const known = new Map((this.knownRoutines ?? []).map((routine) => [routine.id, routine]))
    for (const routine of routines) known.set(routine.id, routine)
    this.knownRoutines = [...known.values()]
    this.options.broadcast({ type: 'routines', routines })
  }

  /** Baseline needed to identify rows that vanished during a Realtime gap. */
  async prime(): Promise<void> {
    this.knownRoutines = await this.options.store.listRoutines()
  }

  /** Reconciles routine rows changed outside Manor's request path. */
  async refresh(change: Pick<HouseholdChange, 'event' | 'id'>): Promise<void> {
    const routines = await this.options.store.listRoutines()
    if (JSON.stringify(routines) === JSON.stringify(this.knownRoutines)) return

    const liveIds = new Set(routines.map((routine) => routine.id))
    const removed = (this.knownRoutines ?? []).filter((routine) => !liveIds.has(routine.id))
    const removedIds = new Set(removed.map((routine) => routine.id))
    if (change.event === 'delete' && change.id !== undefined) removedIds.add(change.id)
    const runIds = this.options.knownChats().flatMap((chat) =>
      chat.kind === 'run' && chat.routineId !== null && removedIds.has(chat.routineId) ? [chat.id] : [],
    )
    for (const chatId of runIds) this.options.orchestrator.discard(chatId)
    if (runIds.length > 0) this.options.onChatsDeleted?.(runIds)

    this.knownRoutines = routines
    this.options.broadcast({ type: 'routines', routines })
    if (runIds.length > 0) this.options.broadcast(await this.options.replaceDirectory())
  }

  /**
   * The one write interface behind the DM's built-in routine tools. Destination
   * and persona are capability facts, never model input.
   */
  async useTool(
    context: RoutineToolContext,
    tool: RoutineToolName,
    input?: RoutineToolInput,
  ): Promise<unknown> {
    if (!this.options.orchestrator.isActiveTurn(context.chatId, context.agentId, context.turnId)) {
      throw new Error('This routine tool belongs to a turn that is no longer active.')
    }
    const chat = await this.options.store.getChat(context.chatId)
    if (chat?.kind !== 'dm' || chat.memberIds[0] !== context.agentId) {
      throw new Error('Routines can only be managed by the persona in its own direct message.')
    }
    const own = (await this.options.store.listRoutines()).filter(
      (routine) => routine.chatId === context.chatId && routine.agentId === context.agentId,
    )
    if (tool === 'routine_list') return { routines: own.map(routineToolRow) }
    const ownRoutine = (routineId: string | undefined) => {
      if (routineId === undefined) return undefined
      const found = own.find((routine) => routine.id === routineId)
      if (found === undefined) {
        throw new Error('That routine does not belong to this direct message. List routines and use its current id.')
      }
      return found
    }

    if (tool === 'routine_cancel') {
      const target = ownRoutine(RoutineToolCancelInputSchema.parse(input).routineId)
      if (target === undefined) throw new Error('routine_cancel needs a routineId.')
      // A recurring routine has no single fire to cancel; stopping it is turning it off.
      const saved = target.runAt === null
        ? await this.options.store.setRoutineEnabled(target.id, false)
        : await this.options.store.cancelRoutine(target.id, Date.now())
      if (saved === undefined) throw new Error('That routine is gone.')
      await this.broadcast()
      return { routine: routineToolRow(saved) }
    }

    const fields = RoutineToolSaveInputSchema.parse(input)
    const current = ownRoutine(fields.routineId)
    const name = (fields.name ?? current?.name ?? '').trim()
    const prompt = (fields.prompt ?? current?.prompt ?? '').trim()
    const timezone = fields.timezone ?? current?.timezone ?? 'Europe/Amsterdam'
    try {
      checkTimezone(timezone)
    } catch {
      throw new Error(`The timezone ${JSON.stringify(timezone)} is not an IANA timezone.`)
    }
    // Switching schedule kind is naming the other field: cron makes it recurring,
    // runAt makes it one time. Neither keeps the kind it had.
    const runAt = fields.cron !== undefined
      ? null
      : fields.runAt !== undefined ? parseMoment(fields.runAt, timezone) : (current?.runAt ?? null)
    const rawCron = runAt === null ? (fields.cron ?? current?.cron ?? '') : ''
    const lateUntil = runAt === null
      ? null
      : fields.lateUntil === null
        ? null
        : fields.lateUntil !== undefined ? parseMoment(fields.lateUntil, timezone) : (current?.lateUntil ?? null)
    if (name.length === 0 || prompt.length === 0 || (runAt === null && rawCron.trim().length === 0)) {
      throw new Error('A routine needs a name, prompt, and schedule: cron for recurring or runAt for one time.')
    }
    const cron = runAt === null ? checkCron(rawCron) : ''

    const saved = await this.options.store.saveRoutine({
      ...(current === undefined ? {} : { id: current.id }),
      projectId: null,
      chatId: context.chatId,
      agentId: context.agentId,
      name,
      description: current?.description ?? '',
      prompt,
      cron,
      timezone,
      runAt,
      lateUntil,
      action: fields.action ?? current?.action ?? 'run',
      // An ended one-time routine is off because it ended, not by choice, so a new time
      // brings it back on. Without a new time the store keeps it ended and off anyway.
      enabled: fields.enabled ?? (current?.endState != null || (current?.enabled ?? true)),
      // A one-time result is asked for by name, so it is on unless said otherwise.
      notify: fields.notify ?? current?.notify ?? runAt !== null,
      model: null,
      effort: null,
    })
    await this.broadcast()
    // The exact moment and zone for the persona's own confirmation. Not posted as a
    // note: a line per scheduled task cluttered the DM (2026-09-28), and the
    // tool row in the activity fold already names what was scheduled.
    const confirm = saved.runAt === null || saved.endState !== null || !saved.enabled
      ? undefined
      : `Scheduled "${saved.name}" for ${formatMoment(saved.runAt, saved.timezone)} (${saved.timezone}).`
    return {
      created: current === undefined,
      routine: routineToolRow(saved),
      ...(confirm === undefined ? {} : { confirm }),
    }
  }

  /** Scheduled and manual runs share this one execution path. */
  run(routine: Routine, chatId: string): Promise<void> {
    return this.options.orchestrator.submitUserMessage(chatId, routine.prompt, [], {
      source: 'routine',
      routineId: routine.id,
      routineName: routine.name,
      targetAgentId: routine.agentId,
      previousRunAt: routine.lastRunAt,
      ...(routine.runAt === null ? {} : { dueAt: routine.runAt }),
      ...(routine.action === 'remind' ? { literal: routine.prompt } : {}),
      ...(routine.lateUntil === null ? {} : {
        expiry: {
          at: routine.lateUntil,
          note: `"${routine.name}" did not run. It waited behind another reply until after ${formatMoment(routine.lateUntil, routine.timezone)}, the latest it was useful.`,
        },
      }),
      // Notify off is silent for every routine; notify on only needs saying for a
      // one-time fire, which skips the short-turn floor.
      ...(!routine.notify ? { notice: 'silent' as const } : routine.runAt !== null ? { notice: 'alert' as const } : {}),
    })
  }

  /** Stops routine work that an agent delete will cascade from persistence. */
  async discardAgentWork(agentId: string): Promise<string[]> {
    const routines = (await this.options.store.listRoutines()).filter((routine) => routine.agentId === agentId)
    const runs = (await Promise.all(routines.map((routine) => this.options.store.listRuns(routine.id)))).flat()
    const dmTargets = routines.flatMap((routine) => routine.chatId === null ? [] : [routine.chatId])
    for (const chatId of new Set([...runs.map((run) => run.id), ...dmTargets])) {
      this.options.orchestrator.discard(chatId)
    }
    return runs.map((run) => run.id)
  }

  async handle(
    message: RoutineClientMessage,
    reply: (message: ServerMessage) => void,
    ack: () => void,
  ): Promise<void> {
    switch (message.type) {
      case 'get_routine_runs': {
        const routine = (await this.options.store.listRoutines()).find((entry) => entry.id === message.routineId)
        if (routine === undefined) {
          reply({ type: 'notice', kind: 'error', text: 'That routine is gone, so its history is unavailable.' })
          return
        }
        reply({
          type: 'routine_runs',
          routineId: routine.id,
          chatId: routine.chatId,
          runs: await routineRuns(this.options.store, routine),
        })
        return
      }
      case 'mark_routine_runs_read': {
        // A repeat of a read already applied, or a routine deleted meanwhile, changes nothing to tell.
        if (await this.options.store.markRoutineRunsRead(message.routineId, message.runIds)) await this.broadcast()
        return
      }
      case 'mark_all_routine_runs_read': {
        if (await this.options.store.markAllRoutineRunsRead()) await this.broadcast()
        return
      }
      case 'save_routine': {
        let draft = message.routine
        if (draft.agentId === SINGLE_CHAT_VOICE.id) singleRoutineRuntime(draft)
        const targetAgent = draft.agentId === SINGLE_CHAT_VOICE.id
          ? SINGLE_CHAT_VOICE
          : this.options.agents().find((agent) => agent.id === draft.agentId)
        if (targetAgent === undefined) {
          reply({ type: 'notice', kind: 'error', text: `There is no persona ${draft.agentId} to give a routine to.` })
          return
        }
        if ('placement' in targetAgent && targetAgent.placement === 'session') {
          reply({ type: 'notice', kind: 'error', text: 'Routines need a chat persona or Single runtime.' })
          return
        }
        if (draft.name.trim().length === 0 || draft.prompt.trim().length === 0) {
          reply({ type: 'notice', kind: 'error', text: 'A routine needs a name and a prompt.' })
          return
        }
        try {
          if ((draft.runAt ?? null) === null) checkCron(draft.cron)
        } catch {
          reply({
            type: 'notice',
            kind: 'error',
            text: `That schedule could not be read: "${draft.cron}" is not a cron expression.`,
          })
          return
        }
        let createdDm = false
        if (draft.projectId !== null) {
          if (await this.options.store.getProject(draft.projectId) === undefined) {
            reply({ type: 'notice', kind: 'error', text: 'That room is gone, so there is nowhere to put the runs.' })
            return
          }
        } else if (draft.agentId !== SINGLE_CHAT_VOICE.id) {
          if (draft.model !== null || draft.effort !== null) {
            reply({ type: 'notice', kind: 'error', text: 'A DM routine uses the runtime already selected for that conversation.' })
            return
          }
          if (draft.chatId !== null && isRoutineDmTarget(draft.chatId, draft.agentId)) {
            const dm = await this.options.store.createChat({
              kind: 'dm',
              memberIds: [draft.agentId],
              title: targetAgent.name,
            })
            draft = { ...draft, chatId: dm.id }
            createdDm = true
          }
          const target = draft.chatId === null ? undefined : await this.options.store.getChat(draft.chatId)
          if (target?.kind !== 'dm' || target.memberIds[0] !== draft.agentId) {
            reply({ type: 'notice', kind: 'error', text: 'A direct-message routine must target that persona’s own DM.' })
            return
          }
        }
        await this.options.store.saveRoutine(draft)
        await this.broadcast()
        if (createdDm) await this.options.broadcastDirectory()
        ack()
        return
      }
      case 'delete_routine': {
        const runs = await this.options.store.listRuns(message.routineId)
        for (const run of runs) this.options.orchestrator.discard(run.id)
        await this.options.store.deleteRoutine(message.routineId)
        this.options.onChatsDeleted?.(runs.map((run) => run.id))
        await this.broadcast()
        await this.options.broadcastDirectory()
        ack()
        return
      }
      case 'set_routine_enabled': {
        const saved = await this.options.store.setRoutineEnabled(message.routineId, message.enabled)
        if (saved === undefined) {
          reply({ type: 'notice', kind: 'error', text: 'That routine is gone, so there was nothing to change.' })
          return
        }
        await this.broadcast()
        return
      }
      case 'run_routine_now': {
        const routine = (await this.options.store.listRoutines()).find((entry) => entry.id === message.routineId)
        if (routine === undefined) {
          reply({ type: 'notice', kind: 'error', text: 'That routine is gone, so there was nothing to run.' })
          return
        }
        if (!routine.enabled) {
          reply({
            type: 'notice',
            kind: 'error',
            text: `"${routine.name}" is off. Turn it on first, then run it.`,
          })
          return
        }
        const tick = await runRoutineNow({
          store: this.options.store,
          runTurn: (entry, chatId) => this.run(entry, chatId),
          routineId: routine.id,
          onClaimed: () => this.broadcast(),
          onRunCreated: () => this.options.broadcastDirectory(),
          onRunFinished: (run, startedAt, alert) => this.options.announceFinished(run.id, startedAt, alert),
        })
        if (tick.kind === 'idle') {
          reply({
            type: 'notice',
            kind: 'error',
            text: `"${routine.name}" is already running. It will post in the chat when it is done.`,
          })
        }
        await this.broadcast()
        return
      }
    }
  }
}
