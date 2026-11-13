import type { AgentConfig, Driver, RuntimeEvent, TurnInput } from '@manor/contracts'
import { AsyncQueue } from '../src/asyncQueue.js'
import type { DraftEvent, Store } from '../src/store.js'

export const sage: AgentConfig = {
  id: 'sage',
  name: 'Sage',
  color: '#6FA8A0',
  driver: 'mock',
  effort: 'high',
  allowedTools: [],
  mcpServers: [],
  memoryScope: false,
  role: 'Generalist',
  description: 'Generalist thinker.',
  isCos: false,
  character: 'You are Sage.',
}

export const smith: AgentConfig = {
  id: 'smith',
  name: 'Smith',
  color: '#D08A3E',
  driver: 'mock',
  effort: 'high',
  allowedTools: ['Read', 'Bash'],
  mcpServers: [],
  memoryScope: false,
  role: 'Engineer',
  description: 'Engineer.',
  isCos: false,
  character: 'You are Smith.',
}

export const marlow: AgentConfig = {
  id: 'marlow',
  name: 'Marlow',
  color: '#8B7EC8',
  driver: 'mock',
  effort: 'high',
  allowedTools: [],
  mcpServers: [],
  memoryScope: false,
  role: 'Chief of staff',
  description: 'Chief of staff.',
  isCos: true,
  character: 'You are Marlow.',
}

/** A household with no chief of staff: the pre-CoS behaviour, unchanged. */
export const roster = [sage, smith]

/** The same household with Marlow in it, for the routing and summon tests. */
export const cosRoster = [marlow, sage, smith]

/** Turns never touch the filesystem in tests; the path only has to be per chat. */
export const scratchFor = (chatId: string): Promise<string> => Promise.resolve(`/tmp/manor-test/${chatId}`)

/**
 * Just the stored session id, for the many tests whose subject is whether a session
 * survived a cascade rather than which CLI it belongs to. Without a provider it is the
 * pair's first session, which in those tests is its only one; the tests about
 * providers name the one they mean.
 */
export const sessionIdIn = async (
  store: Store,
  chatId: string,
  agentId: string,
  driver?: AgentConfig['driver'],
): Promise<string | undefined> => {
  const held = await store.getSessions(chatId, agentId)
  return (driver === undefined ? held[0] : held.find((session) => session.driver === driver))?.sessionId
}

/** Wraps a driver so a test can assert on exactly what each turn was handed. */
/** Everything Manor handed a turn as context: the persona, then its changing blocks. */
export const handed = (input: TurnInput | undefined): string =>
  input === undefined ? '' : [input.agent.character, ...(input.volatileBlocks ?? []).map((block) => block.text)].join('\n\n')

export function recording(inner: Driver, seen: TurnInput[]): Driver {
  return {
    startTurn(input) {
      seen.push(input)
      return inner.startTurn(input)
    },
    ...(inner.compactSession === undefined
      ? {}
      : { compactSession: (input) => inner.compactSession!(input) }),
  }
}

/** Driver that replays a fixed script per attempt, no process and no timing. */
/**
 * A driver that plays one script per turn. An async script models a CLI blocked on a
 * Manor tool call, such as `goal_reached`, until Manor answers it.
 */
export function scripted(
  script: (input: TurnInput, attempt: number) => RuntimeEvent[] | Promise<RuntimeEvent[]>,
  seen: TurnInput[],
): Driver {
  return {
    startTurn(input) {
      seen.push(input)
      const queue = new AsyncQueue<RuntimeEvent>()
      const play = (events: RuntimeEvent[]) => {
        for (const event of events) queue.push(event)
        queue.close()
      }
      const events = script(input, seen.length)
      // A failed assertion inside an async script surfaces as an unhandled rejection, which fails the run.
      if (events instanceof Promise) {
        void events.then(play, (error: unknown) => {
          queue.close()
          throw error
        })
      } else play(events)
      return {
        events: queue,
        stop() {
          queue.close()
        },
      }
    },
  }
}

/**
 * A store where one kind of append explodes and everything else still works. The
 * shape of the failure the terminal-event guarantee exists for: the write that dies
 * is mid-turn, so the note explaining it still has to land.
 */
export function appendFailsOn(
  store: Store,
  when: (draft: DraftEvent) => boolean,
  message = 'the store lost the connection',
): Store {
  return {
    ...store,
    appendEvent: async (chatId, draft) => {
      if (when(draft)) throw new Error(message)
      return store.appendEvent(chatId, draft)
    },
  }
}

/**
 * A store that drops the first `failures` appends and then works. The transient
 * hiccup the orchestrator's append retry exists for, rather than an outage.
 */
export function appendFailsTimes(
  store: Store,
  failures: number,
  message = 'the store lost the connection',
): { store: Store; attempts: () => number } {
  let attempts = 0
  return {
    store: {
      ...store,
      appendEvent: async (chatId, draft) => {
        attempts += 1
        if (attempts <= failures) throw new Error(message)
        return store.appendEvent(chatId, draft)
      },
    },
    attempts: () => attempts,
  }
}

/**
 * A driver whose stream never ends on its own. Only `stop()` closes it, so a turn
 * that leaves this handle running is a leaked CLI process in production.
 */
export function endless(stops: string[]): { driver: Driver; started: TurnInput[] } {
  const started: TurnInput[] = []
  const driver: Driver = {
    startTurn(input) {
      started.push(input)
      const queue = new AsyncQueue<RuntimeEvent>()
      queue.push({ type: 'message', messageId: 'message-1', text: 'half an answer' })
      return {
        events: queue,
        stop() {
          stops.push(input.agent.id)
          queue.close()
        },
      }
    },
  }
  return { driver, started }
}

/** Like `endless`, but the provider has not closed the message boundary yet. */
export function partialEndless(stops: string[]): { driver: Driver; started: TurnInput[] } {
  const started: TurnInput[] = []
  const driver: Driver = {
    startTurn(input) {
      started.push(input)
      const queue = new AsyncQueue<RuntimeEvent>()
      queue.push({ type: 'delta', messageId: 'message-1', text: 'half an answer' })
      return {
        events: queue,
        stop() {
          stops.push(input.agent.id)
          queue.close()
        },
      }
    },
  }
  return { driver, started }
}

export interface Gate {
  input: TurnInput
  /** Ends this turn with a successful result; until then the turn hangs. */
  finish: () => void
  /** Publishes a completed reply while the turn keeps running. */
  say: (text: string) => void
}

/**
 * Driver whose turns only end when the test says so. That is what makes turn
 * ordering observable: a chat with a gate still open is provably mid-turn.
 */
export function gated(replyText: (input: TurnInput) => string = (input) => `${input.agent.name} answered`) {
  const gates: Gate[] = []
  const driver: Driver = {
    startTurn(input) {
      const queue = new AsyncQueue<RuntimeEvent>()
      gates.push({
        input,
        finish() {
          queue.push({
            type: 'result',
            text: replyText(input),
            usage: { inputTokens: 10, outputTokens: 4 },
            sessionId: `session-${input.threadId}-${input.agent.id}`,
          })
          queue.close()
        },
        say(text) {
          queue.push({ type: 'message', messageId: 'said', text })
        },
      })
      return {
        events: queue,
        stop() {
          queue.close()
        },
      }
    },
  }
  const forChat = (chatId: string) => gates.filter((gate) => gate.input.threadId === chatId)
  return { driver, gates, forChat }
}

/** Polls until the predicate holds; fails loudly instead of hanging the suite. */
export async function until(predicate: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** The project + chat every memory store seeds itself with. */
export async function seededChat(store: Store): Promise<{ projectId: string; chatId: string }> {
  const [chat] = await store.listChats()
  if (chat === undefined) throw new Error('the memory store should seed one chat')
  // The seeded chat is a project chat by construction; a null here would mean the
  // store seeded a home chat, which no test wants and every test would misread.
  if (chat.projectId === null) throw new Error('the seeded chat should belong to a project')
  return { projectId: chat.projectId, chatId: chat.id }
}
