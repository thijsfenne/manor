import {
  DEFAULT_USER_PROFILE,
  contextEvents,
  REACTION_SETTLE_MS,
  isModelOnlyMessage,
  isReactionEmoji,
  reactionExcerpt,
  type ServerMessage,
  type ThreadEvent,
} from '@manor/contracts'
import type { Store } from './store.js'

type AgentMessage = Extract<ThreadEvent, { type: 'agent_message' }>
type UserMessage = Extract<ThreadEvent, { type: 'user_message' }>

/** Older reactions told in one message at most; the rest of a burst is noise to the model. */
const MAX_CONTEXT_LINES = 5

export class ReactionRefusal extends Error {}

export interface ReactionNotice {
  instruction: string
  reactionTo: { eventId: string; emoji: string }
}

export interface ReactionPorts {
  store: Pick<Store, 'getChat' | 'loadEvents' | 'patchEvent' | 'getProfile'>
  emit: (message: ServerMessage) => void
  /** The turn running in this chat right now, if any. */
  runningTurnId: (chatId: string) => string | undefined
  /**
   * Hands a notice to the chat the way the user's own message goes: it steers or starts a
   * turn. `compose` runs in the chat's acceptance order, so what it reads cannot change
   * before the notice is accepted; it gives nothing when the reaction no longer stands.
   */
  deliver: (chatId: string, compose: () => Promise<ReactionNotice | undefined>) => Promise<void>
  settleMs?: number
}

/**
 * Emoji reactions in a DM. The user's reaction on the agent's newest message starts a turn
 * once it has stood for `REACTION_SETTLE_MS`; one on a message of the running turn steers
 * it; any other reaction waits and is told once, as a line in the user's next message.
 * The agent's reaction is a field on the user's message and never starts anything.
 */
export class Reactions {
  private readonly timers = new Map<string, NodeJS.Timeout>()

  constructor(private readonly ports: ReactionPorts) {}

  /** Sets or, with `null`, removes the user's reaction on one agent message in a DM. */
  async setUserReaction(chatId: string, eventId: string, emoji: string | null): Promise<void> {
    if (emoji !== null && !isReactionEmoji(emoji)) throw new ReactionRefusal('A reaction is one emoji.')
    const room = await this.ports.store.getChat(chatId)
    if (room?.kind !== 'dm') throw new ReactionRefusal('Reactions are only for direct messages.')
    const updated = await this.ports.store.patchEvent(chatId, eventId, (event) => {
      if (event.type !== 'agent_message') return undefined
      const { reaction: _previous, ...rest } = event
      return emoji === null ? rest : { ...rest, reaction: { emoji, at: Date.now() } }
    })
    if (updated === undefined) throw new ReactionRefusal('Only an agent\'s message takes a reaction.')
    this.ports.emit({ type: 'event', chatId, event: updated })
    // Any change on this message restarts its wait, so a quick change or removal delivers
    // one reaction or none. Another message's reaction keeps its own wait.
    const key = `${chatId}\n${eventId}`
    clearTimeout(this.timers.get(key))
    this.timers.delete(key)
    if (emoji === null) return
    const at = updated.type === 'agent_message' ? updated.reaction?.at : undefined
    const timer = setTimeout(() => {
      if (this.timers.get(key) !== timer) return
      this.timers.delete(key)
      void this.ports.deliver(chatId, () => this.settle(chatId, eventId, at))
        .catch((error: unknown) => console.error('[manor] a reaction was not delivered', error))
    }, this.ports.settleMs ?? REACTION_SETTLE_MS)
    timer.unref?.()
    this.timers.set(key, timer)
  }

  /**
   * The agent's reaction on the user's message that started its turn. Replaces an earlier
   * one; the turn checks it is still running and that this is its own DM before calling.
   */
  async setAgentReaction(chatId: string, eventId: string, agentId: string, emoji: string): Promise<void> {
    if (!isReactionEmoji(emoji)) throw new ReactionRefusal('A reaction is one emoji, such as 👍.')
    const updated = await this.ports.store.patchEvent(chatId, eventId, (event) =>
      event.type === 'user_message' ? { ...event, reaction: { emoji, at: Date.now(), agentId } } : undefined)
    if (updated === undefined) throw new ReactionRefusal('The message that started this turn is gone.')
    this.ports.emit({ type: 'event', chatId, event: updated })
  }

  /**
   * Lines for the user's reactions the agent has not been told of, to lead the next
   * message, and a call that marks them told once that message is stored.
   */
  async untold(chatId: string): Promise<{ lines: string; markTold: () => Promise<unknown> } | undefined> {
    // A reaction from before the newest `/clear` is gone for the model, like its message.
    const events = contextEvents(await this.ports.store.loadEvents(chatId))
    const untold = events.filter((event): event is AgentMessage =>
      event.type === 'agent_message' && event.reaction !== undefined && event.reaction.seen !== true)
      .slice(-MAX_CONTEXT_LINES)
    if (untold.length === 0) return undefined
    const name = await this.userName()
    const lines = untold.map((event) =>
      `[Manor] Earlier, ${name} reacted ${event.reaction?.emoji ?? ''} to your message: "${reactionExcerpt(event.text)}"\n`).join('')
    return { lines, markTold: () => this.markTold(chatId, untold) }
  }

  /**
   * Whether the reaction a notice told still stands, checked again just before the notice is
   * stored. Removing it, or removing and adding it again, makes a fresh reaction that is untold.
   */
  async stands(chatId: string, reactionTo: { eventId: string; emoji: string }): Promise<boolean> {
    const target = (await this.ports.store.loadEvents(chatId)).find((event) => event.id === reactionTo.eventId)
    return target?.type === 'agent_message' && target.reaction?.emoji === reactionTo.emoji && target.reaction.seen === true
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  /**
   * The notice for the reaction set `at`, when it still stands once its wait ran out, marked
   * told; else nothing. A newer change on the message has its own wait and delivers itself.
   */
  private async settle(chatId: string, eventId: string, at: number | undefined): Promise<ReactionNotice | undefined> {
    const events = contextEvents(await this.ports.store.loadEvents(chatId))
    const target = events.find((event): event is AgentMessage => event.id === eventId && event.type === 'agent_message')
    const reaction = target?.reaction
    if (target === undefined || reaction === undefined || reaction.seen === true || reaction.at !== at) return undefined
    const running = this.ports.runningTurnId(chatId)
    const steers = running !== undefined && target.turnId === running
    // Anything else waits for the next message, where `untold` tells it.
    if (!steers && (running !== undefined || !isNewest(events, target))) return undefined
    if (!await this.markTold(chatId, [target])) return undefined
    const name = await this.userName()
    const which = steers ? 'your message' : 'your last message'
    return {
      instruction: `[Manor] ${name} reacted ${reaction.emoji} to ${which}: "${reactionExcerpt(target.text)}". `
        + 'If that message asked something or proposed an action, take the reaction as the answer and act on it. '
        + (steers
          // A steered turn still owes its answer to the message that started it.
          ? 'Otherwise carry on with your answer.'
          : 'Otherwise end the turn without a reply: write nothing at all.'),
      reactionTo: { eventId, emoji: reaction.emoji },
    }
  }

  /** Marks each reaction told, as long as it is still the one that was read. False when none was. */
  private async markTold(chatId: string, messages: readonly AgentMessage[]): Promise<boolean> {
    let marked = false
    for (const message of messages) {
      const read = message.reaction
      const updated = await this.ports.store.patchEvent(chatId, message.id, (event) =>
        event.type === 'agent_message' && event.reaction !== undefined && read !== undefined &&
        event.reaction.emoji === read.emoji && event.reaction.at === read.at && event.reaction.seen !== true
          ? { ...event, reaction: { ...event.reaction, seen: true as const } }
          : undefined)
      if (updated === undefined) continue
      marked = true
      this.ports.emit({ type: 'event', chatId, event: updated })
    }
    return marked
  }

  private async userName(): Promise<string> {
    const name = (await this.ports.store.getProfile()).name.trim()
    return name === '' || name === DEFAULT_USER_PROFILE.name ? 'The user' : name
  }
}

/** The agent's newest message, with nothing the user wrote after it. A reaction notice is not writing. */
function isNewest(events: readonly ThreadEvent[], target: AgentMessage): boolean {
  const at = events.indexOf(target)
  return events.slice(at + 1).every((event) =>
    event.type !== 'agent_message' && !(event.type === 'user_message' && wroteSomething(event)))
}

const wroteSomething = (event: UserMessage): boolean => event.reactionTo === undefined && !isModelOnlyMessage(event)
