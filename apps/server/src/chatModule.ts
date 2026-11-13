import type { AgentConfig, ClientMessage, ServerMessage } from '@manor/contracts'
import { SINGLE_CHAT_VOICE, isModelOnlyMessage, placeQuotesAfterText, splitUserMessage, summaryInContext } from '@manor/contracts'
import { NEW_CHAT_TITLE, type GenerateChatTitle } from './chatTitle.js'
import { composeAgentNotesBundle } from './agentNotes.js'
import type { AdvanceChatSummary } from './chatSummary.js'
import type { MemoryTarget } from './memoryTarget.js'
import type { Orchestrator } from './orchestrator.js'
import type { OutboundDraftPort } from './outboundDrafts.js'
import type { Store } from './store.js'
import { subagentSummary } from './subagents.js'

type ChatMessage = Extract<
  ClientMessage,
  {
    type: 'open_chat' | 'get_chat_summary' | 'send_message' | 'stop' | 'stop_background' | 'answer_user_input' | 'answer_secret_request' | 'submit_outbound_draft' | 'discard_outbound_draft' | 'snooze_outbound_draft' | 'ignore_outbound_draft' | 'restore_outbound_draft' | 'outbound_thread_read' | 'set_chat_override'
  }
>

type OpeningMessage = NonNullable<Extract<ClientMessage, { type: 'create_chat' }>['openingMessage']>

type ChatStore = Pick<Store, 'getChat' | 'getProject' | 'loadEvents' | 'setChatTitle' | 'getChatSummary'>

type ChatRuntime = Pick<
  Orchestrator,
  | 'activeChatIds'
  | 'activeGroupRouterThreadIds'
  | 'activeTurn'
  | 'overrides'
  | 'setOverride'
  | 'stop'
  | 'stopBackgroundWork'
  | 'submitUserMessage'
  | 'usage'
>

interface ChatModuleOptions {
  store: ChatStore
  agents: () => readonly AgentConfig[]
  orchestrator: ChatRuntime
  broadcast: (message: ServerMessage) => void
  broadcastDirectory: () => Promise<void>
  answerUserInput?: (
    chatId: string,
    requestId: string,
    answers: Extract<ClientMessage, { type: 'answer_user_input' }>['answers'],
  ) => Promise<boolean>
  /** Takes a secret card's one answer; no value declines. False when the card is gone. */
  answerSecretRequest?: (chatId: string, requestId: string, value?: string) => boolean
  outboundDrafts?: OutboundDraftPort
  onChatFinished?: (chatId: string, startedAt: number, notice?: { alert?: boolean }) => void | Promise<void>
  generateTitle?: GenerateChatTitle
  onTitleError?: (error: unknown) => void
  advanceChatSummary?: AdvanceChatSummary
  memoryTarget?: MemoryTarget
}

/**
 * Owns the lifecycle of an ordinary conversation around the runtime. Snapshot races,
 * auxiliary title and summary jobs, completion announcements, and runtime pins all
 * stay behind the same interface as sending and stopping the conversation.
 */
export class ChatModule {
  private readonly titleJobs = new Map<string, Promise<void>>()
  private readonly summaryJobs = new Map<string, Promise<boolean>>()

  constructor(private readonly options: ChatModuleOptions) {}

  /** The same notes, under the same conditions and cut, that this DM's turns inject. A DM is never Single. */
  private async injectedNotes(chat: { memberIds: readonly string[] }) {
    const agent = this.options.agents().find((candidate) => candidate.id === chat.memberIds[0])
    if (agent?.memoryScope !== true) return undefined
    const bundle = await composeAgentNotesBundle(this.options.memoryTarget, agent.id)
    const source = bundle.sources[0]
    return source === undefined ? undefined : { ...source, truncated: bundle.truncated }
  }

  /** Called by the runtime only after the opening user event is durable. */
  onUserMessageStored(chatId: string, text: string): void {
    if (this.options.generateTitle === undefined || this.titleJobs.has(chatId)) return

    const job = this.nameNewChat(chatId, text)
      .catch((error: unknown) => this.options.onTitleError?.(error))
      .finally(() => this.titleJobs.delete(chatId))
    this.titleJobs.set(chatId, job)
  }

  /** Called by the runtime after a settled turn and tracked for scratch cleanup. */
  startSummary(chatId: string): Promise<boolean> {
    const job = this.options.advanceChatSummary?.(chatId) ?? Promise.resolve(true)
    this.summaryJobs.set(chatId, job)
    const clear = () => {
      if (this.summaryJobs.get(chatId) === job) this.summaryJobs.delete(chatId)
    }
    void job.then(clear, clear)
    return job
  }

  /** Scratch resources the hourly lifecycle sweep must leave alone. */
  activeScratchThreadIds(): string[] {
    return [
      ...this.options.orchestrator.activeChatIds(),
      ...this.options.orchestrator.activeGroupRouterThreadIds(),
      ...[...this.titleJobs.keys()].map((chatId) => `title_${chatId}`),
      ...[...this.summaryJobs.keys()].map((chatId) => `summary_${chatId}`),
    ]
  }

  /** A project-created opening follows the same completion lifecycle as an ordinary send. */
  async sendOpeningMessage(chatId: string, opening: OpeningMessage): Promise<void> {
    await this.runNotifyingExchange(chatId, () =>
      this.options.orchestrator.submitUserMessage(
        chatId,
        opening.text,
        opening.images ?? [],
        undefined,
        opening.pageContexts ?? [],
        opening.files ?? [],
        undefined,
        opening.quotes ?? [],
        opening.documents ?? [],
      ),
    )
  }

  /** Routine runs share the same best-effort completion notification. */
  announceFinished(chatId: string, startedAt: number, alert = false): void {
    // A push outage may be loud, but it may not turn a completed turn into a failure.
    try {
      void Promise.resolve(this.options.onChatFinished?.(chatId, startedAt, alert ? { alert } : undefined)).catch((error: unknown) => {
        console.warn('manor: could not announce a finished chat', chatId, error)
      })
    } catch (error) {
      console.warn('manor: could not announce a finished chat', chatId, error)
    }
  }

  async handle(
    message: ChatMessage,
    reply: (message: ServerMessage) => void,
    ack: () => void,
  ): Promise<void> {
    switch (message.type) {
      case 'get_chat_summary': {
        const { store } = this.options
        const chat = await store.getChat(message.chatId)
        // A project thread keeps the same rolling summary as a DM and shows it the same way.
        const projectThread = chat?.kind === 'project' && chat.projectId !== null &&
          (await store.getProject(chat.projectId))?.threadChatId === chat.id
        if (chat?.kind !== 'dm' && !projectThread) {
          reply({ type: 'notice', kind: 'error', text: chat === undefined ? 'Chat not found' : 'Summary inspection is only available for DMs and project threads.' })
          return
        }
        const events = await store.loadEvents(chat.id)
        const held = summaryInContext(await store.getChatSummary(chat.id), events)
        let summary: Extract<ServerMessage, { type: 'chat_summary' }>['summary'] = null
        if (held !== undefined) {
          const through = events.find(event => event.id === held.throughEventId)
          // Keep a readable saved summary even if its source boundary is unavailable.
          const from = through === undefined ? undefined : events[0]
          summary = {
            text: held.summary,
            fromEventId: from?.id ?? null,
            fromAt: from?.ts ?? null,
            throughEventId: held.throughEventId,
            throughAt: through?.ts ?? null,
            updatedAt: held.updatedAt,
          }
        }
        const notes = await this.injectedNotes(chat)
        reply({
          type: 'chat_summary',
          chatId: chat.id,
          ...(message.requestId === undefined ? {} : { requestId: message.requestId }),
          summary,
          ...(notes === undefined ? {} : { notes }),
        })
        return
      }
      case 'open_chat':
        reply(await this.snapshot(message.chatId, message.after, message.count))
        return
      case 'send_message':
        const room = await this.options.store.getChat(message.chatId)
        if (room?.kind === 'pair') {
          reply({ type: 'notice', kind: 'error', text: 'Agent pair chats are view-only.' })
          return
        }
        if (room?.kind === 'subagent') {
          reply({ type: 'notice', kind: 'error', text: 'A subagent thread is read-only; ask in the chat that started it.' })
          return
        }
        const placed = placeQuotesAfterText(message)
        await this.runNotifyingExchange(message.chatId, () =>
          this.options.orchestrator.submitUserMessage(
            message.chatId,
            placed.text,
            message.images ?? [],
            undefined,
            message.pageContexts ?? [],
            message.files ?? [],
            message.replyTo,
            placed.quotes,
            message.documents ?? [],
          ),
        )
        return
      case 'stop':
        this.options.orchestrator.stop(message.turnId)
        return
      case 'stop_background':
        await this.options.orchestrator.stopBackgroundWork(message.chatId)
        return
      case 'answer_user_input': {
        const answer = this.options.answerUserInput
        if (answer === undefined || !(await answer(message.chatId, message.requestId, message.answers))) {
          reply({ type: 'notice', kind: 'error', text: 'That question is no longer waiting for an answer.' })
        }
        return
      }
      case 'answer_secret_request':
        if (this.options.answerSecretRequest?.(message.chatId, message.requestId, message.value) !== true) {
          reply({ type: 'notice', kind: 'error', text: 'That secret request is gone, and nothing was kept. Ask the agent to request it again.' })
        }
        return
      case 'submit_outbound_draft': {
        const drafts = this.options.outboundDrafts
        if (
          drafts === undefined
          || !(await drafts.submit(message.chatId, message.draftId, message.body, message.subject, message.slackRichText))
        ) {
          reply({ type: 'notice', kind: 'error', text: 'That draft could not be submitted.' })
        }
        return
      }
      case 'discard_outbound_draft': {
        const drafts = this.options.outboundDrafts
        if (drafts === undefined || !(await drafts.discard(message.chatId, message.draftId))) {
          reply({ type: 'notice', kind: 'error', text: 'That draft could not be discarded.' })
        }
        return
      }
      case 'snooze_outbound_draft': {
        const drafts = this.options.outboundDrafts
        if (drafts === undefined || !(await drafts.snooze(message.chatId, message.draftId, message.until))) {
          reply({ type: 'notice', kind: 'error', text: 'That draft could not be postponed.' })
        }
        return
      }
      case 'ignore_outbound_draft': {
        const drafts = this.options.outboundDrafts
        if (drafts === undefined || !(await drafts.ignore(message.chatId, message.draftId))) {
          reply({ type: 'notice', kind: 'error', text: 'That thread could not be ignored.' })
        }
        return
      }
      case 'restore_outbound_draft': {
        const drafts = this.options.outboundDrafts
        if (drafts === undefined || !(await drafts.restore(message.chatId, message.draftId))) {
          reply({ type: 'notice', kind: 'error', text: 'That draft could not be restored.' })
        }
        return
      }
      case 'outbound_thread_read': {
        let result: Extract<ServerMessage, { type: 'outbound_thread' }>['result']
        try {
          const thread = await this.options.outboundDrafts?.readThread(message.chatId, message.draftId)
          result = thread === undefined
            ? { status: 'error', message: 'Thread context is unavailable.' }
            : { status: 'ready', ...thread }
        } catch (error: unknown) {
          result = {
            status: 'error',
            message: error instanceof Error ? error.message : 'The thread could not be loaded.',
          }
        }
        reply({ type: 'outbound_thread', requestId: message.requestId, draftId: message.draftId, result })
        return
      }
      case 'set_chat_override': {
        // Persona existence is a roster rule rather than a store shape rule.
        const pinnedRoom = await this.options.store.getChat(message.chatId)
        const pinned = pinnedRoom?.mode === 'single'
          ? message.agentId === SINGLE_CHAT_VOICE.id
          : this.options.agents().some((agent) => agent.id === message.agentId)
        if (!pinned) {
          reply({
            type: 'notice',
            kind: 'error',
            text: `There is no persona ${message.agentId} to pin runtime settings for.`,
          })
          return
        }
        if (pinnedRoom?.kind === 'pair') {
          reply({ type: 'notice', kind: 'error', text: 'Agent pair chats are view-only.' })
          return
        }
        if (pinnedRoom?.kind === 'side') {
          reply({
            type: 'notice',
            kind: 'error',
            text: 'A side chat runs on its own model, so it takes no per-persona pin.',
          })
          return
        }
        // Do not clear the stored CLI session here. A pin may change while a turn is
        // running, and that turn would write its old session back after the delete.
        // Session provenance already prevents a different provider from resuming it.
        try {
          await this.options.orchestrator.setOverride(message.chatId, message.agentId, message.override)
        } catch (error: unknown) {
          const why = error instanceof Error ? error.message : 'the store refused it'
          reply({ type: 'notice', kind: 'error', text: `Those runtime settings could not be pinned: ${why}.` })
          return
        }
        this.options.broadcast({
          type: 'chat_overrides',
          chatId: message.chatId,
          perAgent: await this.options.orchestrator.overrides(message.chatId),
        })
        if (pinnedRoom?.mode === 'single') await this.options.broadcastDirectory()
        ack()
        return
      }
    }
  }

  /**
   * The whole thread, or only what follows `after` when the client holds exactly the
   * `count` events up to it. Reads active state last so a turn that settled while
   * events, usage and overrides were loading cannot be resurrected as running by the
   * snapshot response.
   */
  private async snapshot(chatId: string, after?: string, count?: number): Promise<ServerMessage> {
    const [events, usage, overrides, chat] = await Promise.all([
      this.options.store.loadEvents(chatId),
      this.options.orchestrator.usage(chatId),
      this.options.orchestrator.overrides(chatId),
      this.options.store.getChat(chatId),
    ])
    const activeTurn = this.options.orchestrator.activeTurn(chatId)
    const subagent = chat === undefined ? undefined : subagentSummary(chat)
    const at = after === undefined ? -1 : events.map((event) => event.id).lastIndexOf(after)
    const held = at >= 0 && at + 1 === count ? at : -1
    return {
      type: 'snapshot',
      chatId,
      events: held < 0 ? [...events] : events.slice(held + 1),
      ...(held < 0 ? {} : { after }),
      usage,
      ...(activeTurn === undefined ? {} : { activeTurn }),
      ...(Object.keys(overrides).length === 0 ? {} : { overrides }),
      ...(subagent === undefined ? {} : { subagent }),
    }
  }

  private async runNotifyingExchange(chatId: string, run: () => Promise<void>): Promise<void> {
    const startedAt = Date.now()
    await run()
    this.announceFinished(chatId, startedAt)
  }

  private async nameNewChat(chatId: string, openingMessage: string): Promise<void> {
    // A primary-key read is intentional. `listChats` also resolves derived rows, far
    // more work than these two guards need.
    const chat = await this.options.store.getChat(chatId)
    if (chat?.title !== NEW_CHAT_TITLE || this.options.generateTitle === undefined) return

    const events = await this.options.store.loadEvents(chatId)
    // Manor's own wording for the model is nobody's opening message.
    const firstMessage = events.find((event) => event.type === 'user_message' && !isModelOnlyMessage(event))
    const title = await this.options.generateTitle(
      chatId,
      firstMessage?.type === 'user_message' ? splitUserMessage(firstMessage).visible : openingMessage,
    )
    if (title === NEW_CHAT_TITLE) return

    // A manual rename or deletion while the model was working always wins.
    const current = await this.options.store.getChat(chatId)
    if (current?.title !== NEW_CHAT_TITLE) return
    await this.options.store.setChatTitle(chatId, title)
    await this.options.broadcastDirectory()
  }
}
