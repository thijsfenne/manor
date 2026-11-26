import {
  MAX_MEMORY_TRACE_READS,
  OutboundDraftContentSchema,
  slackRichTextFallback,
  REASONING_LIMIT,
  type AgentConfig,
  type BackgroundWait,
  type LiveContext,
  type MemoryRead,
  type RuntimeEvent,
  type ServerMessage,
  type TurnHandle,
  type Usage,
} from '@manor/contracts'
import { parseDmRoutineOutcome } from './composer.js'
import { collectMemoryReads } from './memoryTrace.js'
import { isSubagentLaunchTool } from './mcp/interactionAttachment.js'
import { isManorTool } from './goalReview.js'
import { createLiveContext } from './liveContext.js'
import { endedBackgroundNote, unconfirmedBackgroundNote } from './turnSweep.js'
import type { DraftEvent } from './store.js'

type DeferredAgentMessage = Extract<DraftEvent, { type: 'agent_message' }>

export type TurnOutcome =
  | {
      kind: 'result'
      text: string
      usage?: Usage
      contextTokens?: number
      contextWindow?: number
      /** Known compaction threshold; only Claude reports one. See the runtime result event. */
      autoCompactTokens?: number
      reportedModel?: string
      observedSpeed?: 'fast'
      sessionId?: string
      /** The provider compacted this session's history during the turn. */
      compacted?: true
      usedTools: boolean
      /** A provider or tool reported an error even if the turn later returned a result. */
      hadError: boolean
      /**
       * Whether the persona said anything *after* its last tool call.
       *
       * Not the same question as "did it speak at all", and the difference is the
       * whole of a class of turns that read as finished and reported nothing: a
       * preamble ("I'll run the scan, then follow the instructions") counts as text,
       * so a turn that opened with one, worked for a minute and stopped looked like a
       * turn that answered. The transcript has always drawn it correctly — the
       * client's own `finishedSilent` asks exactly this — and the server disagreeing
       * meant the report-back nudge never fired for it.
       */
      reportedAfterTools: boolean
      /** Manor intentionally ended this attempt after an accepted asynchronous handoff. */
      completedByTool?: boolean
      /** Successful explicit memory reads observed during this driver attempt. */
      memoryReads: MemoryRead[]
      /** Held until a provider-independent postcondition accepts this attempt. */
      deferredMessages?: DeferredAgentMessage[]
    }
  | {
      kind: 'error'
      message: string
      retryable?: boolean
      sessionId?: string
      usage?: Usage
      memoryReads?: MemoryRead[]
    }

export const mergeMemoryReads = (...groups: readonly MemoryRead[][]): MemoryRead[] => {
  const reads: MemoryRead[] = []
  const seen = new Set<string>()
  for (const read of groups.flat()) {
    const key = `${read.source}\0${read.path}`
    if (seen.has(key)) continue
    seen.add(key)
    reads.push(read)
    if (reads.length === MAX_MEMORY_TRACE_READS) break
  }
  return reads
}

export interface TurnStream {
  consume(
    handle: TurnHandle,
    messageNamespace: string,
    onProviderActivity?: () => void,
    memoryPaths?: { roots: readonly string[]; cwd: string },
    deferMessages?: boolean,
    isSuperseded?: () => boolean,
  ): Promise<TurnOutcome>
  persistInterrupted(): Promise<void>
  discardLive(): void
}

export function createTurnStream({
  chatId,
  turnId,
  agent,
  liveMessages,
  append,
  emit,
  finishOnToolResult,
  onResult,
  onBackgroundWait,
  onContext,
}: {
  chatId: string
  turnId: string
  agent: AgentConfig
  liveMessages: Map<string, string>
  append: (draft: DraftEvent) => Promise<void>
  emit: (message: ServerMessage) => void
  finishOnToolResult?: (tool: string, outcome: 'success' | 'error' | 'stopped') => boolean
  onResult?: () => void
  /** The turn answered and waits on background work, or stopped waiting (zero counts). */
  onBackgroundWait?: (wait: BackgroundWait | undefined) => void
  /** The live context state the clients were just sent; the snapshot carries the latest. */
  onContext?: (context: LiveContext) => void
}): TurnStream {
  // Per turn, not per attempt: a retried attempt continues the same session's reading.
  const liveContext = createLiveContext((context) => {
    onContext?.(context)
    emit({ type: 'turn_context', chatId, turnId, agentId: agent.id, context })
  })
  return {
    /** Drains one driver stream, turning runtime events into wire deltas and durable events. */
    async consume(
      handle: TurnHandle,
      messageNamespace: string,
      onProviderActivity?: () => void,
      memoryPaths?: { roots: readonly string[]; cwd: string },
      deferMessages = false,
      isSuperseded?: () => boolean,
    ): Promise<TurnOutcome> {
      let streamed = ''
      let result: TurnOutcome | undefined
      let firstError: Extract<RuntimeEvent, { type: 'error' }> | undefined
      let hadError = false
      let finishedByTool = false
      // Whether this attempt did anything the thread can see. A turn that only thought
      // and then said nothing is a persona declining to speak; a turn that edited files
      // and then said nothing left work nobody was told about.
      let usedTools = false
      // Flipped false by every tool call and true by every message that lands after
      // one, so what survives to the end is "did the last word come after the work".
      let reportedAfterTools = true
      /** Calls first announced as foreground work, so Codex promoting one is no new tool call. */
      const foregroundCalls = new Set<string>()
      const completedMessages = new Set<string>()
      const attachments: Extract<RuntimeEvent, { type: 'attachment' }>['image'][] = []
      const pendingMemoryReads = new Map<string, MemoryRead[]>()
      const pendingTools = new Map<string, string>()
      // Manor writes a delegate_task launch as its own row with the child thread, so the
      // provider's report of the same call would draw it twice.
      const launchCalls = new Set<string>()
      let memoryReads: MemoryRead[] = []
      const deferredMessages: DeferredAgentMessage[] = []
      const messageId = (runtimeId: string) => `${messageNamespace}:${runtimeId}`
      const publishMessage = async (draft: DeferredAgentMessage): Promise<void> => {
        if (deferMessages) {
          deferredMessages.push(draft)
          return
        }
        // A persona whose resumed session once ran a DM routine may echo its outcome
        // marker in an ordinary reply. Only a deferred routine turn reads the marker.
        const text = parseDmRoutineOutcome(draft.text)?.text ?? draft.text
        if (text.trim().length === 0 && (draft.images?.length ?? 0) === 0) return
        await append(text === draft.text ? draft : { ...draft, text })
      }

      // A throw from the driver or an append still settles, so no reading lands after the turn ends.
      try {
        for await (const event of handle.events) {
          if (isSuperseded?.() === true) continue
          if (finishedByTool) continue
          if (event.type !== 'error') onProviderActivity?.()
          switch (event.type) {
            case 'delta':
              streamed += event.text
              if (usedTools) reportedAfterTools = true
              if (!deferMessages) {
                const canonicalId = messageId(event.messageId)
                liveMessages.set(canonicalId, (liveMessages.get(canonicalId) ?? '') + event.text)
                emit({
                  type: 'delta',
                  chatId,
                  turnId,
                  agentId: agent.id,
                  messageId: canonicalId,
                  text: event.text,
                })
              }
              break
            case 'message': {
              const canonicalId = messageId(event.messageId)
              if (event.text.length === 0 || completedMessages.has(canonicalId)) break
              completedMessages.add(canonicalId)
              reportedAfterTools = true
              await publishMessage({
                type: 'agent_message',
                agentId: agent.id,
                turnId,
                messageId: canonicalId,
                text: event.text,
              })
              liveMessages.delete(canonicalId)
              break
            }
            case 'attachment':
              if (attachments.length < 4) attachments.push(event.image)
              break
            case 'reasoning':
              await append({
                type: 'reasoning',
                agentId: agent.id,
                turnId,
                ...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
                // Clamped here as well as in each driver. Nothing validates on the way
                // into the store, and a row over the cap fails the snapshot's array
                // parse on reload, which makes the whole chat unopenable rather than
                // just hiding the bad row. One driver forgetting must not cost a thread.
                text: event.text.slice(0, REASONING_LIMIT),
              })
              break
            case 'todo_update':
              await append({
                type: 'todo_update',
                agentId: agent.id,
                turnId,
                todos: event.todos,
              })
              break
            case 'outbound_draft': {
              const draft = OutboundDraftContentSchema.safeParse({
                channel: event.channel,
                to: event.to,
                ...(event.subject === undefined ? {} : { subject: event.subject }),
                ...(event.cc === undefined ? {} : { cc: event.cc }),
                body: event.body,
                ...(event.mailAccount === undefined ? {} : { mailAccount: event.mailAccount }),
                ...(event.slackChannelId === undefined ? {} : { slackChannelId: event.slackChannelId }),
                ...(event.slackThreadTs === undefined ? {} : { slackThreadTs: event.slackThreadTs }),
                ...(event.slackRichText === undefined ? {} : { slackRichText: event.slackRichText }),
                ...(event.thread === undefined ? {} : { thread: event.thread }),
              })
              if (!draft.success) {
                await append({
                  type: 'system_note',
                  kind: 'error',
                  agentId: agent.id,
                  turnId,
                  text: 'The outbound draft was invalid and was not added.',
                })
                break
              }
              await append({
                type: 'outbound_draft',
                agentId: agent.id,
                turnId,
                draftId: `${turnId}:${agent.id}:${crypto.randomUUID()}`,
                channel: draft.data.channel,
                to: draft.data.to,
                ...(draft.data.channel === 'gmail' && draft.data.subject !== undefined && draft.data.subject !== ''
                  ? { subject: draft.data.subject }
                  : {}),
                ...(draft.data.channel === 'gmail' && draft.data.cc !== undefined && draft.data.cc.trim() !== ''
                  ? { cc: draft.data.cc.trim() }
                  : {}),
                ...(draft.data.channel === 'gmail'
                  ? { mailAccount: draft.data.mailAccount ?? 'personal' as const }
                  : {
                      slackChannelId: draft.data.slackChannelId,
                      ...(draft.data.slackThreadTs === undefined ? {} : { slackThreadTs: draft.data.slackThreadTs }),
                      ...(draft.data.slackRichText === undefined ? {} : { slackRichText: draft.data.slackRichText }),
                    }),
                body: draft.data.channel === 'slack' && draft.data.slackRichText !== undefined
                  ? slackRichTextFallback(draft.data.slackRichText) : draft.data.body,
                ...(draft.data.thread === undefined ? {} : { thread: draft.data.thread }),
              })
              break
            }
            case 'tool_use': {
              // Codex marks a still-running foreground row as background work only at its
              // turn's answer, after the report. That promotion is no new tool call; a
              // helper resumed under its old call id (Claude) is, and needs a report again.
              const id = event.toolCallId
              const promoted = id !== undefined && event.background === true && foregroundCalls.has(id) &&
                (pendingTools.has(id) || launchCalls.has(id))
              if (id !== undefined && event.background !== true) foregroundCalls.add(id)
              // A reaction is an answer the user sees, not work that owes a report.
              if (!promoted && !isManorTool(event.tool, 'react')) {
                usedTools = true
                reportedAfterTools = false
              }
              if (isSubagentLaunchTool(event.tool)) {
                if (event.toolCallId !== undefined) launchCalls.add(event.toolCallId)
                break
              }
              if (event.toolCallId !== undefined) {
                pendingTools.set(event.toolCallId, event.tool)
              }
              if (memoryPaths !== undefined && event.targets !== undefined) {
                const observed = collectMemoryReads([{
                  source: 'on_demand',
                  tool: event.tool,
                  targets: event.targets,
                }], memoryPaths)
                if (observed.length > 0) {
                  if (event.toolCallId === undefined) {
                    // Drivers without call ids cannot later pair a result. The explicit
                    // read intent is still more truthful than silently dropping it.
                    memoryReads = mergeMemoryReads(memoryReads, observed)
                  } else {
                    pendingMemoryReads.set(event.toolCallId, observed)
                  }
                }
              }
              await append({
                type: 'tool_use',
                agentId: agent.id,
                turnId,
                ...(event.toolCallId === undefined ? {} : { toolCallId: event.toolCallId }),
                ...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
                tool: event.tool,
                ...(event.agentType === undefined ? {} : { agentType: event.agentType }),
                ...(event.subagent === undefined ? {} : { subagent: event.subagent }),
                ...(event.detail === undefined ? {} : { detail: event.detail }),
                ...(event.subject === undefined ? {} : { subject: event.subject }),
                ...(event.targets === undefined ? {} : { targets: event.targets }),
                ...(event.command === undefined ? {} : { command: event.command }),
                ...(event.edits === undefined ? {} : { edits: event.edits }),
                ...(event.background === true ? { background: true } : {}),
              })
              break
            }
            case 'background_wait': {
              // Live only: a reconnecting client reads it from the active turn instead.
              const waiting = event.agents + event.commands > 0
              onBackgroundWait?.(waiting ? { agents: event.agents, commands: event.commands } : undefined)
              emit({ type: 'turn_background', chatId, turnId, agentId: agent.id, agents: event.agents, commands: event.commands })
              break
            }
            case 'context':
              liveContext.reading(event.contextTokens, event.contextWindow, event.autoCompactTokens)
              break
            case 'compaction':
              liveContext.compaction(event.phase, event.contextTokens)
              break
            case 'background_stopped':
              await append({
                type: 'system_note', kind: event.unconfirmed ? 'error' : 'info', agentId: agent.id, turnId,
                text: (event.unconfirmed ? unconfirmedBackgroundNote : endedBackgroundNote)(agent.name, event.titles),
              })
              break
            case 'tool_result':
              {
                if (launchCalls.delete(event.toolCallId)) break
                const pendingTool = pendingTools.get(event.toolCallId)
                let finishTurn = false
                if (pendingTool !== undefined) {
                  finishTurn = finishOnToolResult?.(pendingTool, event.outcome) === true
                  pendingTools.delete(event.toolCallId)
                }
                if (event.outcome === 'error') hadError = true
                const pending = pendingMemoryReads.get(event.toolCallId)
                if (event.outcome === 'success' && pending !== undefined) {
                  memoryReads = mergeMemoryReads(memoryReads, pending)
                }
                pendingMemoryReads.delete(event.toolCallId)
                await append({
                  type: 'tool_result',
                  agentId: agent.id,
                  turnId,
                  toolCallId: event.toolCallId,
                  ...(event.parentToolCallId === undefined ? {} : { parentToolCallId: event.parentToolCallId }),
                  outcome: event.outcome,
                  ...(event.tool === undefined ? {} : { tool: event.tool }),
                  ...(event.subject === undefined ? {} : { subject: event.subject }),
                  ...(event.output === undefined ? {} : { output: event.output }),
                  ...(event.outcome !== 'error' || event.error === undefined ? {} : { error: event.error }),
                  ...(event.usage === undefined ? {} : { usage: event.usage }),
                  ...(event.reportedModel === undefined ? {} : { reportedModel: event.reportedModel }),
                  ...(event.reportedEffort === undefined ? {} : { reportedEffort: event.reportedEffort }),
                  ...(event.edits === undefined ? {} : { edits: event.edits }),
                })
                if (finishTurn) {
                  finishedByTool = true
                  handle.stop()
                }
              }
              break
            case 'result':
              {
                onResult?.()
                const effectiveText = event.text.length > 0 ? event.text : streamed
                if (completedMessages.size === 0 && effectiveText.length > 0) {
                  const canonicalId = `${messageNamespace}:message_1`
                  completedMessages.add(canonicalId)
                  // A terminal result body is itself a report. Delta fallback keeps the
                  // timing established by the last tool call: text streamed only before
                  // that call is a preamble, not a report-back.
                  if (event.text.length > 0) reportedAfterTools = true
                  await publishMessage({
                    type: 'agent_message',
                    agentId: agent.id,
                    turnId,
                    messageId: canonicalId,
                    text: effectiveText,
                  })
                  liveMessages.delete(canonicalId)
                }
                result = {
                  kind: 'result',
                  text: effectiveText,
                  usedTools,
                  hadError,
                  reportedAfterTools,
                  memoryReads,
                  ...(deferMessages ? { deferredMessages } : {}),
                  ...(event.usage ? { usage: event.usage } : {}),
                  ...(event.contextTokens === undefined ? {} : { contextTokens: event.contextTokens }),
                  ...(event.contextWindow === undefined ? {} : { contextWindow: event.contextWindow }),
                  ...(event.autoCompactTokens === undefined ? {} : { autoCompactTokens: event.autoCompactTokens }),
                  ...(event.reportedModel === undefined ? {} : { reportedModel: event.reportedModel }),
                  ...(event.observedSpeed === undefined ? {} : { observedSpeed: event.observedSpeed }),
                  ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
                  ...(event.compacted === undefined ? {} : { compacted: event.compacted }),
                }
              }
              break
            case 'error':
              hadError = true
              if (firstError === undefined) {
                console.warn(`[manor] turn error (${agent.driver}, ${agent.model ?? 'default model'}): ${event.message.slice(0, 200)}`)
              }
              firstError ??= event
              break
          }
        }
      } finally {
        liveContext.settle()
      }

      if (isSuperseded?.() === true) {
        for (const toolCallId of pendingTools.keys()) {
          await append({
            type: 'tool_result',
            agentId: agent.id,
            turnId,
            toolCallId,
            outcome: 'error',
          })
        }
        pendingTools.clear()
        pendingMemoryReads.clear()
      }

      if (isSuperseded?.() !== true && attachments.length > 0) {
        await publishMessage({
          type: 'agent_message',
          agentId: agent.id,
          turnId,
          messageId: `${messageNamespace}:attachments`,
          text: '',
          images: attachments,
        })
      }

      if (finishedByTool) {
        liveMessages.clear()
        return {
          kind: 'result',
          text: '',
          usedTools,
          hadError,
          reportedAfterTools: true,
          completedByTool: true,
          memoryReads,
          ...(deferMessages ? { deferredMessages } : {}),
        }
      }

      if (result !== undefined) {
        // A turn that hit a problem and answered anyway used to drop the problem on
        // the floor here. It stays in the turn's trace instead: the answer is still the
        // answer, but "it went wrong once and recovered" leaves a record.
        if (firstError !== undefined) {
          await append({
            type: 'system_note',
            kind: 'info',
            text: `Problem mid-turn, carried on: ${firstError.message}`,
            agentId: agent.id,
            turnId,
            trace: true,
          })
        }
        if (result.kind !== 'result') return result
        return { ...result, hadError }
      }
      if (firstError !== undefined) {
        return {
          kind: 'error',
          message: firstError.message,
          ...(firstError.retryable === true ? { retryable: true } : {}),
          ...(firstError.sessionId === undefined ? {} : { sessionId: firstError.sessionId }),
          ...(firstError.usage === undefined ? {} : { usage: firstError.usage }),
          ...(memoryReads.length === 0 ? {} : { memoryReads }),
        }
      }
      return { kind: 'error', message: 'the driver ended the turn without a result' }
    },
    /**
     * Makes provider text that never reached a message boundary part of the canonical
     * transcript before the terminal note lands. Deleting only after a successful
     * append makes a retry safe and leaves the text available to the outer failure path
     * when the store itself is what broke the turn.
     */
    async persistInterrupted(): Promise<void> {
      for (const [messageId, text] of [...liveMessages]) {
        if (text.length === 0) continue
        await append({
          type: 'agent_message',
          agentId: agent.id,
          turnId,
          messageId,
          text,
          interrupted: true,
        })
        liveMessages.delete(messageId)
      }
    },
    discardLive(): void {
      liveMessages.clear()
    },
  }
}
