import {
  type AgentConfig,
  type CatchUpSummary,
  type Chat,
  type Project,
  type ThreadEvent,
  LIVE_COMPACT_CONTEXT_FRACTION,
  contextEvents,
  contextWindowFor,
  hasBrowserMention,
  hasComputerMention,
  summaryInContext,
} from '@manor/contracts'
import {
  SESSION_CEILING_CHARS,
  SESSION_CONTEXT_FRACTION,
  SESSION_CONTEXT_TOKEN_CAP,
  catchUpCut,
  composeSideContext,
  renderCatchUpEvents,
} from './composer.js'
import { materialisedImageStem } from './scratch.js'
import type { AgentSession, ChatSummary, Store } from './store.js'
import { access, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { retainedEvidence } from './retainedEvidence.js'
import { ridesAlong } from './projectThreads.js'
import { withRelayExchanges } from './agentRelay.js'

/** Everything appended strictly after `afterId`; the whole list if the cursor is unknown. */
const eventsAfter = (events: readonly ThreadEvent[], afterId: string): ThreadEvent[] => {
  const index = events.findIndex((event) => event.id === afterId)
  return index === -1 ? [...events] : events.slice(index + 1)
}

/** Summary plus its exact unsummarized tail, or the whole canon if the cursor is gone. */
const tieredCatchUp = (
  events: readonly ThreadEvent[],
  summary: ChatSummary | undefined,
): { events: ThreadEvent[]; summary?: CatchUpSummary } => {
  if (summary === undefined) return { events: [...events] }
  const through = events.findIndex((event) => event.id === summary.throughEventId)
  if (through === -1) return { events: [...events] }
  const evidence = retainedEvidence(events.slice(0, through + 1))
  return {
    events: events.slice(through + 1),
    summary: { text: summary.summary, throughEventId: summary.throughEventId,
      ...(evidence ? { retainedEvidence: evidence } : {}) },
  }
}

/**
 * Whether a persona's turn was seen by her session on this provider. A turn stamped
 * with another provider ran in another session; an unstamped one predates the stamp
 * (when the pair held one session, the one still stored) or ran on no provider.
 */
const seenOn = (event: ThreadEvent, driver: AgentConfig['driver']): boolean =>
  event.type !== 'turn_result' || event.driver === undefined || event.driver === driver

/**
 * Cursor for a persona's conversation session on one provider: the last turn she
 * completed there, or her last legacy message. Turns she answered on another provider
 * stay after the cursor, so a session resumed after a switch is told what was said in
 * between. A DM routine fire (its `turn_result` carries `routineOutcome`) ran in its
 * own throwaway session, so it is not a turn this session saw; skipping it is what
 * brings the routine's prompt and result into the next conversational catch-up.
 */
const lastAgentCursorId = (
  events: readonly ThreadEvent[],
  agentId: string,
  driver: AgentConfig['driver'],
): string | undefined => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn_result' && event.agentId === agentId && event.routineOutcome === undefined &&
      seenOn(event, driver)) return event.id
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'agent_message' && event.agentId === agentId && event.messageId === undefined) {
      return event.id
    }
  }
  return undefined
}

/**
 * Relay markers that reached a DM while the turn ending at `cursor` ran: after its
 * prompt was built, before the result that became the cursor. Steering extends that
 * turn, and a message queued during it (running now, or never run) did not open it, so
 * the walk passes both. A marker that landed just before the prompt was built comes
 * again, which costs a line, not a lost message.
 */
const relaysDuringTurn = (events: readonly ThreadEvent[], cursor: string): ThreadEvent[] => {
  const missed: ThreadEvent[] = []
  for (let index = events.findIndex((event) => event.id === cursor) - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === undefined || (event.type === 'user_message' && event.steersTurnId === undefined &&
      (event.dispatchState === undefined || event.dispatchState === 'completed'))) break
    if (event.type === 'agent_relay') missed.unshift(event)
  }
  return missed
}

export interface PreparedTurnContext {
  catchUp: ThreadEvent[]
  browserTargetMessageId: string | undefined
  computerTargeted: boolean
  catchUpSummary?: CatchUpSummary
  isFullCatchUp: boolean
  imagePaths: string[]
  side: { block: string; cursor: string | undefined }
}

/** What the ceiling check needs to know about the persona whose session it judges. */
export interface SessionOwner {
  agentId: string
  driver: AgentConfig['driver']
  /** The model this chat runs the persona on; undefined falls back to the driver's default window. */
  model: string | undefined
}

export interface TurnContext {
  /**
   * Whether this provider session should be dropped and reseeded before the turn:
   * either the canon it holds passed the ceiling, or its last turn reported a context
   * already past the room's window fraction (live compact when `liveCompact`, see
   * `wantsLiveCompact`; rollover elsewhere).
   */
  sessionIsOverCeiling: (
    chatId: string,
    room: Chat | undefined,
    session: AgentSession,
    owner: SessionOwner,
    liveCompact: boolean,
  ) => Promise<boolean>
  /** Canonical transcript, side-chat context and visible images for one provider attempt. */
  prepareAttempt: (input: {
    chatId: string
    agentId: string
    /** The provider the attempt runs on; a resumed session catches up from its own last turn. */
    driver: AgentConfig['driver']
    sessionId: string | undefined
    room: Chat | undefined
    cwd: string
    reviewHop?: boolean
    catchUpOverride?: ThreadEvent[]
    allowComputerTarget?: boolean
    /** A DM routine fire: a fresh session reads its routine message, not the DM. */
    routineOnly?: boolean
  }) => Promise<PreparedTurnContext>
}

/**
 * Live CLI compact is Single Work only. DM, Multiple, house, side, run and the project
 * thread roll over. The thread is Single-shaped but a standing room like a DM, so its
 * record is Manor's summary rather than a private CLI one (2026-10-11). Pass the
 * room's project so the thread can be told apart from the sessions it starts.
 */
export const wantsLiveCompact = (
  room: Chat | undefined,
  project: Pick<Project, 'threadChatId'> | undefined,
): boolean =>
  room?.kind === 'project' && room.mode === 'single' && project?.threadChatId !== room.id

export function createTurnContext(options: {
  store: Store
  agents: () => readonly AgentConfig[]
}): TurnContext {
  /**
   * Count only canon added after this provider session was seeded. A legacy row has
   * no cursor and therefore keeps the lifetime-transcript behaviour until rollover.
   * The side voice accumulates both its own conversation and the parent it reads.
   */
  const sessionIsOverCeiling = async (
    chatId: string,
    room: Chat | undefined,
    session: AgentSession,
    owner: SessionOwner,
    liveCompact: boolean,
  ): Promise<boolean> => {
    const parentId = room?.kind === 'side' ? room.parentChatId : null
    const [events, parentEvents] = await Promise.all([
      options.store.loadEvents(chatId),
      parentId === null ? Promise.resolve([]) : options.store.loadEvents(parentId),
    ])
    const roster = options.agents()
    const heldEvents = session.seededThroughEventId === undefined
      ? events
      : eventsAfter(events, session.seededThroughEventId)
    const heldParentEvents = session.parentSeededThroughEventId === undefined
      ? parentEvents
      : eventsAfter(parentEvents, session.parentSeededThroughEventId)
    // The session's own report of how full it is, read off the last turn it finished.
    // Only turns after the seed on its own provider belong to this session; an older
    // result describes the session that was rolled away, and another provider's
    // describes another session. Drivers that report nothing fall through to canon.
    const reported = heldEvents
      .filter((event) => event.type === 'turn_result' && event.agentId === owner.agentId && seenOn(event, owner.driver))
      .at(-1)
    if (reported?.type === 'turn_result' && reported.contextTokens !== undefined) {
      const window = reported.contextWindow !== undefined && reported.contextWindow > 0
        ? reported.contextWindow
        : contextWindowFor(owner.driver, owner.model)
      const threshold = liveCompact
        ? window * LIVE_COMPACT_CONTEXT_FRACTION
        : Math.min(window * SESSION_CONTEXT_FRACTION, SESSION_CONTEXT_TOKEN_CAP)
      if (reported.contextTokens >= threshold) return true
    }
    return renderCatchUpEvents(heldEvents, roster).length
      + renderCatchUpEvents(heldParentEvents, roster).length
      > SESSION_CEILING_CHARS
  }

  /**
   * The chat a side chat hangs off, rendered for this turn, and how far it now reaches.
   * Empty for every other room, so an ordinary turn never reads a second transcript.
   */
  const sideContextFor = async (
    room: Chat | undefined,
    sessionId: string | undefined,
  ): Promise<{ block: string; cursor: string | undefined }> => {
    const parentId = room?.kind === 'side' ? room.parentChatId : null
    if (room === undefined || parentId === null) return { block: '', cursor: undefined }
    const [parent, loaded, parentSummary] = await Promise.all([
      options.store.getChat(parentId),
      options.store.loadEvents(parentId),
      options.store.getChatSummary(parentId),
    ])
    const events = contextEvents(loaded)
    // Without a session the voice holds none of the thread, whatever a stored cursor says.
    const seen = sessionId === undefined
      ? undefined
      : (await options.store.getSideSession(room.id))?.contextEventId
    const hasSeenCursor = seen !== undefined && events.some((event) => event.id === seen)
    const full = !hasSeenCursor
    const context = full ? tieredCatchUp(events, summaryInContext(parentSummary, loaded)) : { events: eventsAfter(events, seen) }
    return {
      block: composeSideContext({
        events: context.events,
        ...(context.summary === undefined ? {} : { summary: context.summary }),
        agents: options.agents(),
        title: parent?.title ?? '',
        isFull: full,
      }),
      // The newest event, not the newest rendered event. Tool-only tails must not repeat.
      cursor: loaded.at(-1)?.id,
    }
  }

  const catchUpFor = async (
    chatId: string,
    agentId: string,
    driver: AgentConfig['driver'],
    sessionId: string | undefined,
    override?: ThreadEvent[],
    reviewHop = false,
    allowComputerTarget = false,
    routineOnly = false,
  ): Promise<{ browserTargetMessageId: string | undefined; computerTargeted: boolean; catchUp: ThreadEvent[]; catchUpSummary?: CatchUpSummary; isFullCatchUp: boolean }> => {
    const [loaded, summary] = await Promise.all([
      options.store.loadEvents(chatId),
      options.store.getChatSummary(chatId),
    ])
    const events = contextEvents(loaded).filter((event) => event.type !== 'user_message' || event.dispatchState !== 'pending')
    // Steering extends the current request. A new ordinary user message resets it. A
    // wake row reports background results, not a request, so the target looks past it.
    let browserTargetMessageId: string | undefined
    let computerTargeted = false
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== 'user_message' || event.source === 'background_wake' || ridesAlong(event)) continue
      if (browserTargetMessageId === undefined && hasBrowserMention(event.text)) browserTargetMessageId = event.id
      if (allowComputerTarget && hasComputerMention(event.text)) computerTargeted = true
      if (event.steersTurnId === undefined) break
    }
    if (override !== undefined) return { browserTargetMessageId, computerTargeted, catchUp: override, isFullCatchUp: false }
    const cursor = sessionId === undefined ? undefined : lastAgentCursorId(events, agentId, driver)
    if (cursor === undefined && routineOnly) {
      let fire = events.length - 1
      for (; fire >= 0; fire -= 1) {
        const event = events[fire]
        if (event?.type === 'user_message' && event.source === 'routine') break
      }
      return { browserTargetMessageId, computerTargeted, catchUp: fire === -1 ? [] : events.slice(fire), isFullCatchUp: false }
    }
    if (cursor === undefined) {
      const tiered = tieredCatchUp(events, summaryInContext(summary, loaded))
      return {
        browserTargetMessageId,
        computerTargeted,
        catchUp: await withRelayExchanges(chatId, tiered.events, options.store, options.agents()),
        ...(tiered.summary === undefined ? {} : { catchUpSummary: tiered.summary }),
        isFullCatchUp: true,
      }
    }
    const tail = eventsAfter(events, cursor)
    // Accepted input may predate the previous turn's result because it waited.
    // Bring its original row into this attempt without copying it in the transcript.
    const waiting = events.filter((event) => !reviewHop && event.type === 'user_message' && event.dispatchState === 'started' &&
      !tail.some((row) => row.id === event.id))
    const catchUp = await withRelayExchanges(chatId, [...relaysDuringTurn(events, cursor), ...waiting, ...tail], options.store, options.agents())
    return { browserTargetMessageId, computerTargeted, catchUp, isFullCatchUp: false }
  }

  return {
    sessionIsOverCeiling,
    async prepareAttempt(input) {
      const catchUpContext = await catchUpFor(input.chatId, input.agentId, input.driver, input.sessionId, input.catchUpOverride, input.reviewHop, input.allowComputerTarget, input.routineOnly)
      // Tool names in a side chat quote the parent conversation, never request host capabilities.
      if (input.room?.kind === 'side') {
        catchUpContext.browserTargetMessageId = undefined
        catchUpContext.computerTargeted = false
      }
      const { from } = catchUpCut({ events: catchUpContext.catchUp, agents: options.agents() })
      const imagePaths = input.room?.kind === 'side'
        ? []
        : await materialiseImages(input.cwd, catchUpContext.catchUp.slice(from))
      const side = await sideContextFor(input.room, input.sessionId)
      return { ...catchUpContext, imagePaths, side }
    },
  }
}

export async function materialiseImages(cwd: string, events: readonly ThreadEvent[]): Promise<string[]> {
  const dir = path.join(cwd, 'attachments')
  const results: string[] = []
  for (const event of events) {
    if (event.type !== 'user_message' && event.type !== 'agent_message') continue
    for (const [index, image] of (event.images ?? []).entries()) {
      // Raster only. SVG attachments render in the transcript but provider CLIs reject them.
      const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(image.dataUrl ?? '')
      if (!match) continue
      await mkdir(dir, { recursive: true })
      const extension = match[1] === 'jpeg' ? 'jpg' : match[1]
      const target = path.join(dir, `${materialisedImageStem(event.id, index)}.${extension}`)
      const present = await access(target).then(
        () => true,
        () => false,
      )
      if (!present) await writeFile(target, Buffer.from(match[2]!, 'base64'))
      results.push(target)
    }
  }
  return results
}
