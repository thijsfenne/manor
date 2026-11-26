import { CONTEXT_CLEARED_NOTE, modelTextOf, type Driver, type RuntimeEvent, type ServerMessage, type ThreadEvent, type TurnInput } from '@manor/contracts'
import { describe, expect, it, vi } from 'vitest'
import { AsyncQueue } from '../src/asyncQueue.js'
import { Orchestrator } from '../src/orchestrator.js'
import { ReactionRefusal } from '../src/reactions.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { roster, scratchFor, until } from './helpers.js'

const SETTLE_MS = 30

/** A DM with Sage whose turns the test plays by hand: each started turn hands back its queue. */
async function dmHarness() {
  const store = createMemoryStore({ agents: roster })
  const sent: ServerMessage[] = []
  const turns: { input: TurnInput; queue: AsyncQueue<RuntimeEvent> }[] = []
  const driver: Driver = {
    startTurn(input) {
      const queue = new AsyncQueue<RuntimeEvent>()
      turns.push({ input, queue })
      return { events: queue, stop: () => queue.close() }
    },
  }
  const orchestrator = new Orchestrator({
    agents: () => roster,
    store,
    mcpServers: () => [],
    skills: () => [],
    resolveDriver: () => driver,
    ensureScratchDir: scratchFor,
    emit: (message) => sent.push(message),
    reactionSettleMs: SETTLE_MS,
  })
  const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
  const events = () => store.loadEvents(dm.id)
  const finish = (at: number, text: string) => {
    const queue = turns[at]!.queue
    if (text !== '') queue.push({ type: 'message', messageId: `m${at}`, text })
    queue.push({ type: 'result', text, sessionId: 'session-1' })
    queue.close()
  }
  /** One full exchange: the user's message and Sage's reply. */
  const exchange = async (text: string, reply: string) => {
    const at = turns.length
    const running = orchestrator.submitUserMessage(dm.id, text)
    await until(() => turns.length === at + 1, 'the turn to start')
    finish(at, reply)
    await running
  }
  const lastReply = async () => (await events()).filter((event) => event.type === 'agent_message').at(-1)!
  const runningTurn = () => {
    const state = sent.filter((message) => message.type === 'turn_state' && message.chatId === dm.id).at(-1)
    return state?.type === 'turn_state' && state.state === 'running' ? state.turnId : undefined
  }
  return { orchestrator, store, sent, turns, dm, events, finish, exchange, lastReply, runningTurn }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS * 4))
const userMessages = (events: readonly ThreadEvent[]) => events.filter((event) => event.type === 'user_message')
const turnResults = (events: readonly ThreadEvent[]) => events.filter((event) => event.type === 'turn_result')

describe('emoji reactions in a DM', () => {
  it("stores the user's reaction on an agent message, replaces it, and removes it", async () => {
    const h = await dmHarness()
    await h.exchange('Hello', 'Hi there.')
    const reply = await h.lastReply()

    await h.orchestrator.reactions.setUserReaction(h.dm.id, reply.id, '👍')
    await h.orchestrator.reactions.setUserReaction(h.dm.id, reply.id, '❤️')
    expect(await h.lastReply()).toMatchObject({ reaction: { emoji: '❤️' } })
    expect(h.sent.some((message) => message.type === 'event' && message.event.id === reply.id)).toBe(true)

    await h.orchestrator.reactions.setUserReaction(h.dm.id, reply.id, null)
    expect(await h.lastReply()).not.toHaveProperty('reaction')

    const userMessage = userMessages(await h.events())[0]!
    await expect(h.orchestrator.reactions.setUserReaction(h.dm.id, userMessage.id, '👍')).rejects.toBeInstanceOf(ReactionRefusal)
    await expect(h.orchestrator.reactions.setUserReaction(h.dm.id, reply.id, 'yes')).rejects.toBeInstanceOf(ReactionRefusal)
    const group = await h.store.createChat({ kind: 'group', memberIds: ['sage', 'marlow'] })
    await expect(h.orchestrator.reactions.setUserReaction(group.id, reply.id, '👍')).rejects.toBeInstanceOf(ReactionRefusal)
    await settle()
    expect(h.turns).toHaveLength(1)
  })

  it('starts one turn for the final reaction on the newest message, after quick changes', async () => {
    const h = await dmHarness()
    await h.exchange('Plan the week', 'Shall I move the dentist to Friday?')
    const reply = await h.lastReply()

    await h.orchestrator.reactions.setUserReaction(h.dm.id, reply.id, '👎')
    await h.orchestrator.reactions.setUserReaction(h.dm.id, reply.id, '👍')
    await until(() => h.turns.length === 2, 'the reaction turn to start')
    h.finish(1, 'Moved it to Friday.')
    await until(() => h.runningTurn() === undefined, 'the reaction turn to end')
    await settle()

    expect(h.turns).toHaveLength(2)
    const notice = userMessages(await h.events()).at(-1)!
    expect(notice).toMatchObject({ text: '', reactionTo: { eventId: reply.id, emoji: '👍' } })
    expect(modelTextOf(notice)).toContain('reacted 👍 to your last message: "Shall I move the dentist to Friday?"')
    expect(await h.lastReply()).toMatchObject({ text: 'Moved it to Friday.' })
    expect((await h.events()).find((event) => event.id === reply.id)).toMatchObject({ reaction: { emoji: '👍', seen: true } })
  })

  it('starts nothing when the reaction is removed, during the wait or after it', async () => {
    const h = await dmHarness()
    await h.exchange('Hello', 'Hi there.')
    const reply = await h.lastReply()

    await h.orchestrator.reactions.setUserReaction(h.dm.id, reply.id, '😂')
    await h.orchestrator.reactions.setUserReaction(h.dm.id, reply.id, null)
    await settle()
    expect(h.turns).toHaveLength(1)
  })

  it('starts no turn for an older message and tells it once, in the next message', async () => {
    const h = await dmHarness()
    await h.exchange('First', 'An early answer that the user liked a lot.')
    const older = await h.lastReply()
    await h.exchange('Second', 'A later answer.')

    await h.orchestrator.reactions.setUserReaction(h.dm.id, older.id, '🎉')
    await settle()
    expect(h.turns).toHaveLength(2)

    await h.exchange('Third', 'Noted.')
    await h.exchange('Fourth', 'Fine.')
    const told = (at: number) => modelTextOf(userMessages(h.turns[at]!.input.catchUp).at(-1)!)
    expect(told(2)).toContain('Earlier, The user reacted 🎉 to your message: "An early answer that the user liked a lot."')
    expect(told(2)).toContain('Third')
    expect(told(3)).not.toContain('reacted')
    // The context line rides in the message, never in the cached prefix.
    expect(h.turns[2]!.input.contextBlock ?? '').not.toContain('reacted')
    expect(userMessages(await h.events()).find((event) => event.text === 'Third')?.text).toBe('Third')
  })

  it('steers the running turn when the user reacts to one of its messages', async () => {
    const h = await dmHarness()
    const running = h.orchestrator.submitUserMessage(h.dm.id, 'Draft the mail')
    await until(() => h.turns.length === 1, 'the turn to start')
    h.turns[0]!.queue.push({ type: 'message', messageId: 'progress', text: 'Shall I keep it short?' })
    await until(() => h.sent.some((message) => message.type === 'event' && message.event.type === 'agent_message'), 'the progress message')
    const progress = (await h.events()).find((event) => event.type === 'agent_message')!

    await h.orchestrator.reactions.setUserReaction(h.dm.id, progress.id, '👍')
    // Without native steering the running answer restarts with the reaction in its input.
    await until(() => h.turns.length === 2, 'the steered attempt')
    const steered = userMessages(h.turns[1]!.input.catchUp).at(-1)!
    expect(steered.reactionTo).toEqual({ eventId: progress.id, emoji: '👍' })
    expect(modelTextOf(steered)).toContain('reacted 👍 to your message: "Shall I keep it short?"')
    // The steered turn still owes its answer, so it is never told to end without one.
    expect(modelTextOf(steered)).toContain('Otherwise carry on with your answer.')
    expect(modelTextOf(steered)).not.toContain('write nothing')
    h.finish(1, 'Kept it short.')
    await running
    await until(() => h.runningTurn() === undefined, 'the steered turn to end')
  })

  it('leaves no visible row when the reaction turn ends without words', async () => {
    const h = await dmHarness()
    await h.exchange('Thanks for the summary', 'Glad it helped.')
    const reply = await h.lastReply()
    const before = (await h.events()).length

    await h.orchestrator.reactions.setUserReaction(h.dm.id, reply.id, '❤️')
    await until(() => h.turns.length === 2, 'the reaction turn to start')
    h.finish(1, '')
    await until(() => h.sent.filter((message) => message.type === 'event' && message.event.type === 'turn_result').length === 2, 'the quiet ending')
    await until(() => h.runningTurn() === undefined, 'the turn to end')

    const added = (await h.events()).slice(before)
    expect(added.map((event) => event.type)).toEqual(['user_message', 'turn_result'])
    expect(added[1]).toMatchObject({ quiet: true })
    expect(h.sent.filter((message) => message.type === 'turn_state' && message.chatId === h.dm.id).at(-1)).toMatchObject({ notice: 'silent' })
  })

  it("lets the agent react to the turn's own message, replace it, and nothing else", async () => {
    const h = await dmHarness()
    const running = h.orchestrator.submitUserMessage(h.dm.id, 'I got the job!')
    await until(() => h.turns.length === 1, 'the turn to start')
    await until(() => h.runningTurn() !== undefined, 'the running state')
    const context = { chatId: h.dm.id, agentId: 'sage', turnId: h.runningTurn()! }

    await h.orchestrator.recordAgentReaction(context, '👍')
    await h.orchestrator.recordAgentReaction(context, '🎉')
    await expect(h.orchestrator.recordAgentReaction(context, 'hooray')).rejects.toBeInstanceOf(ReactionRefusal)
    await expect(h.orchestrator.recordAgentReaction({ ...context, turnId: 'other' }, '👍')).rejects.toBeInstanceOf(ReactionRefusal)
    const other = await h.store.createChat({ kind: 'group', memberIds: ['sage', 'marlow'] })
    await expect(h.orchestrator.recordAgentReaction({ ...context, chatId: other.id }, '👍')).rejects.toBeInstanceOf(ReactionRefusal)
    h.finish(0, 'Congratulations, well earned.')
    await running
    await expect(h.orchestrator.recordAgentReaction(context, '👍')).rejects.toBeInstanceOf(ReactionRefusal)

    expect(userMessages(await h.events())[0]).toMatchObject({ reaction: { emoji: '🎉', agentId: 'sage' } })
    expect(await h.lastReply()).toMatchObject({ text: 'Congratulations, well earned.' })
    await settle()
    expect(h.turns).toHaveLength(1)
  })

  it('shows only the badge when the reaction is the whole answer', async () => {
    const h = await dmHarness()
    const running = h.orchestrator.submitUserMessage(h.dm.id, 'Thanks!')
    await until(() => h.runningTurn() !== undefined, 'the running state')
    const turnId = h.runningTurn()!
    const queue = h.turns[0]!.queue
    queue.push({ type: 'tool_use', toolCallId: 'react-1', tool: 'mcp__manor__react', detail: '❤️' })
    await h.orchestrator.recordAgentReaction({ chatId: h.dm.id, agentId: 'sage', turnId }, '❤️')
    queue.push({ type: 'tool_result', toolCallId: 'react-1', outcome: 'success' })
    queue.push({ type: 'result', text: '', sessionId: 'session-1' })
    queue.close()
    await running

    const events = await h.events()
    expect(h.turns).toHaveLength(1)
    expect(events.some((event) => event.type === 'agent_message' || event.type === 'system_note')).toBe(false)
    expect(userMessages(events)[0]).toMatchObject({ reaction: { emoji: '❤️', agentId: 'sage' } })
    expect(turnResults(events)[0]).toMatchObject({ quiet: true })
  })

  it("keeps each message's wait apart, so a change on an older one does not cancel the newest", async () => {
    const h = await dmHarness()
    await h.exchange('First', 'An older answer.')
    const older = await h.lastReply()
    await h.exchange('Second', 'Shall I book Friday?')

    await h.orchestrator.reactions.setUserReaction(h.dm.id, older.id, '😂')
    await h.orchestrator.reactions.setUserReaction(h.dm.id, (await h.lastReply()).id, '👍')
    await h.orchestrator.reactions.setUserReaction(h.dm.id, older.id, null)
    await until(() => h.turns.length === 3, 'the reaction turn to start')
    expect(userMessages(h.turns[2]!.input.catchUp).at(-1)).toMatchObject({ reactionTo: { emoji: '👍' } })
    h.finish(2, 'Booked.')
    await until(() => h.runningTurn() === undefined, 'the turn to end')
  })

  it('steers once for a reaction taken back and given again while earlier additions are delivered', async () => {
    const h = await dmHarness()
    const running = h.orchestrator.submitUserMessage(h.dm.id, 'Draft the mail')
    await until(() => h.turns.length === 1, 'the turn to start')
    h.turns[0]!.queue.push({ type: 'message', messageId: 'progress', text: 'Shall I keep it short?' })
    await until(() => h.sent.some((message) => message.type === 'event' && message.event.type === 'agent_message'), 'the progress message')
    const progress = (await h.events()).find((event) => event.type === 'agent_message')!
    const reactions = h.orchestrator.reactions
    const stands = reactions.stands.bind(reactions)
    // The user takes the reaction back and gives it again while the notice waits.
    vi.spyOn(reactions, 'stands').mockImplementationOnce(async (chatId, reactionTo) => {
      await reactions.setUserReaction(chatId, reactionTo.eventId, null)
      await reactions.setUserReaction(chatId, reactionTo.eventId, reactionTo.emoji)
      return stands(chatId, reactionTo)
    })

    await reactions.setUserReaction(h.dm.id, progress.id, '👍')
    // Only the second reaction's own wait steers the turn.
    await until(() => h.turns.length === 2, 'the steered attempt')
    await settle()
    expect(h.turns).toHaveLength(2)
    expect(userMessages(await h.events()).filter((event) => event.reactionTo !== undefined)).toHaveLength(1)
    h.finish(1, 'Kept it short.')
    await running
    await until(() => h.runningTurn() === undefined, 'the steered turn to end')
  })

  it('lets an expired wait deliver only its own reaction, never a newer one before its wait', async () => {
    const h = await dmHarness()
    await h.exchange('Plan the week', 'Shall I move the dentist to Friday?')
    const reply = await h.lastReply()
    const load = h.store.loadEvents.bind(h.store)
    let release!: () => void
    const held = new Promise<void>((resolve) => { release = resolve })
    let reading = false
    // Holds the first wait's read, so the user can change the reaction before it runs.
    vi.spyOn(h.store, 'loadEvents').mockImplementationOnce(async (chatId) => {
      reading = true
      await held
      return load(chatId)
    })

    await h.orchestrator.reactions.setUserReaction(h.dm.id, reply.id, '👎')
    await until(() => reading, 'the first wait to run out')
    await h.orchestrator.reactions.setUserReaction(h.dm.id, reply.id, '👍')
    release()
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS / 3))
    expect(h.turns).toHaveLength(1)
    await until(() => h.turns.length === 2, 'the newer reaction to start its turn')
    expect(userMessages(await h.events()).at(-1)).toMatchObject({ reactionTo: { eventId: reply.id, emoji: '👍' } })
    h.finish(1, 'Moved it to Friday.')
    await until(() => h.runningTurn() === undefined, 'the reaction turn to end')
  })

  it('tells nothing from before a /clear, neither as a turn nor as a line', async () => {
    const h = await dmHarness()
    await h.exchange('First', 'Before the clear.')
    const before = await h.lastReply()
    await h.store.appendEvent(h.dm.id, { type: 'system_note', kind: 'info', text: CONTEXT_CLEARED_NOTE, contextBoundary: { keepEventIds: [] } })

    await h.orchestrator.reactions.setUserReaction(h.dm.id, before.id, '👍')
    await settle()
    expect(h.turns).toHaveLength(1)
    await h.exchange('Fresh start', 'Hello again.')
    expect(modelTextOf(userMessages(h.turns[1]!.input.catchUp).at(-1)!)).not.toContain('reacted')
    expect(await h.events()).toContainEqual(expect.objectContaining({ id: before.id, reaction: expect.objectContaining({ emoji: '👍' }) }))
  })

  it('still asks for a report when work with other tools ends in only a reaction', async () => {
    const h = await dmHarness()
    const running = h.orchestrator.submitUserMessage(h.dm.id, 'Check the build please.')
    await until(() => h.runningTurn() !== undefined, 'the running state')
    const turnId = h.runningTurn()!
    const queue = h.turns[0]!.queue
    queue.push({ type: 'tool_use', toolCallId: 'bash-1', tool: 'Bash', detail: 'pnpm build' })
    queue.push({ type: 'tool_result', toolCallId: 'bash-1', outcome: 'success' })
    queue.push({ type: 'tool_use', toolCallId: 'react-1', tool: 'mcp__manor__react', detail: '👍' })
    await h.orchestrator.recordAgentReaction({ chatId: h.dm.id, agentId: 'sage', turnId }, '👍')
    queue.push({ type: 'tool_result', toolCallId: 'react-1', outcome: 'success' })
    queue.push({ type: 'result', text: '', sessionId: 'session-1' })
    queue.close()
    // The report nudge resumes the turn once; this time it still says nothing.
    await until(() => h.turns.length === 2, 'the report nudge')
    h.finish(1, '')
    await running

    const events = await h.events()
    expect(events.some((event) => event.type === 'system_note' && event.text.includes('without reporting back'))).toBe(true)
    expect(turnResults(events).at(-1)).not.toHaveProperty('quiet')
  })

  it('refuses the react tool in a turn the user reaction started', async () => {
    const h = await dmHarness()
    await h.exchange('Is Friday fine?', 'Shall I book Friday?')
    await h.orchestrator.reactions.setUserReaction(h.dm.id, (await h.lastReply()).id, '👍')
    await until(() => h.turns.length === 2, 'the reaction turn to start')
    await until(() => h.runningTurn() !== undefined, 'the running state')

    await expect(h.orchestrator.recordAgentReaction({ chatId: h.dm.id, agentId: 'sage', turnId: h.runningTurn()! }, '👍'))
      .rejects.toThrow(/no message of the user's/)
    h.finish(1, 'Booked.')
    await until(() => h.runningTurn() === undefined, 'the turn to end')
  })
})
