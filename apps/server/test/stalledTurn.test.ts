import type { RuntimeEvent, TurnInput } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { Orchestrator } from '../src/orchestrator.js'
import { STALL_CONTINUE_NUDGE, announcesNextStep, stallNudgeLine } from '../src/stalledTurn.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { roster, scratchFor, scripted } from './helpers.js'

describe('announcesNextStep', () => {
  it.each([
    'Ik ga nu de tests draaien.',
    'Now I\'ll check the logs.',
    'The config looks right.\n\nLet me run the build to confirm.',
    'Nu ga ik de migratie toepassen:',
    'Found it in `turnRunner.ts`. Next, I\'ll patch the guard.',
    'Even de logs checken.',
    'The spec is at https://example.com/spec?v=2 and matches. Now I\'ll run the tests.',
    'Nu draai ik de tests opnieuw.',
    'I\'m about to restart the server.',
    'Types are green. Ik check nog of de hover-regel klopt.',
    'Found the existing test. Reading it so I can follow its pattern.',
    'Status: I\'m running a control check.',
  ])('fires on an announced next step: %s', (text) => {
    expect(announcesNextStep(text)).toBe(true)
  })

  it.each([
    // A question to the user.
    'Ik ga nu de tests draaien, of wil je eerst de diff zien?',
    'Should I run the migration now?',
    // A proposal or plan awaiting the user's choice.
    'Two options: patch the guard or rewrite the queue. Let me know which one you prefer.',
    'Plan:\n1. Patch the guard\n2. Add tests\n\nZodra je akkoord geeft, ga ik nu meteen aan de slag.',
    'I\'ll start on the rewrite once you approve the plan.',
    // A finished report.
    'Done. The tests pass and the guard now refuses an empty id.',
    'Klaar: de build is groen en de logs zijn schoon.',
    // Later, or after the user's answer.
    'I\'ll look at the CSS tomorrow.',
    'Ik ga morgen verder met de logs.',
    'I\'ll pick it up later.',
    // Not an action at all.
    'Ik ga ervan uit dat dit de oorzaak is.',
    'I\'ll stop here for now.',
    'Nu weet ik waarom de build faalde.',
    'Even so, the build is fine.',
    '```ts\nconst x = 1\n```',
    'Zeg ja of nee, dan ga ik door naar het overzicht.',
    'Confirm these first, then I\'ll send the correction.',
    'The file is now over budget, so I\'ll trim it at a quiet moment.',
    'Running the tests showed one flaky case.',
    'Reply with yes to proceed.\n\nFirst, I\'ll delete the old files.',
    'Now I\'ll send the email if I get permission.',
    'I\'ll check the logs in an hour:',
    'Nu stop ik hier.',
    'Proceed with deletion?\n\nIf so, I\'ll delete the files now.',
    'Delete [the old files](https://example.com/old-files)?\n\nIf so, I\'ll delete the files now.',
    'Delete <https://example.com/old-files>?\n\nIf so, I\'ll delete the files now.',
  ])('stays quiet on a real ending: %s', (text) => {
    expect(announcesNextStep(text)).toBe(false)
  })
})

/** A DM with Smith whose driver plays one reply per attempt, in order. */
async function dmWith(replies: readonly string[], interviewKickoff?: () => boolean) {
  const store = createMemoryStore({ agents: roster })
  const seen: TurnInput[] = []
  const driver = scripted((input, attempt): RuntimeEvent[] => {
    const text = replies[attempt - 1] ?? 'Done.'
    return [
      { type: 'message', messageId: `m${attempt}`, text },
      { type: 'result', text, sessionId: input.sessionId ?? 'session-1' },
    ]
  }, seen)
  const orchestrator = new Orchestrator({
    agents: () => roster, store, resolveDriver: () => driver, ensureScratchDir: scratchFor, emit: () => undefined, mcpServers: () => [],
    ...(interviewKickoff === undefined ? {} : { interviewKickoff }),
  })
  const dm = await store.createChat({ kind: 'dm', memberIds: ['smith'], title: 'Smith' })
  return { orchestrator, store, seen, chatId: dm.id }
}

const nudged = (input: TurnInput | undefined) =>
  input?.catchUp.some((event) => event.type === 'system_note' && event.text === STALL_CONTINUE_NUDGE) === true

describe('stall continuation', () => {
  it('continues a turn that announced its next step once, with a quiet line', async () => {
    const { orchestrator, store, seen, chatId } = await dmWith(['Ik ga nu de tests draaien.', 'De tests zijn groen.'])
    await orchestrator.submitUserMessage(chatId, 'Fix the guard.')

    expect(seen).toHaveLength(2)
    expect(nudged(seen[0])).toBe(false)
    expect(nudged(seen[1])).toBe(true)
    expect(seen[1]?.sessionId).toBe('session-1')
    const events = await store.loadEvents(chatId)
    expect(events.filter((event) => event.type === 'agent_message').map((event) => 'text' in event && event.text))
      .toEqual(['Ik ga nu de tests draaien.', 'De tests zijn groen.'])
    expect(events.filter((event) => event.type === 'system_note')).toEqual([
      expect.objectContaining({ kind: 'info', agentId: 'smith', text: stallNudgeLine('Smith') }),
    ])
  })

  it('leaves a question to the user alone', async () => {
    const { orchestrator, seen, chatId } = await dmWith(['Ik kan de tests nu draaien. Wil je dat?'])
    await orchestrator.submitUserMessage(chatId, 'Fix the guard.')
    expect(seen).toHaveLength(1)
  })

  it('leaves a plan awaiting approval alone', async () => {
    const { orchestrator, seen, chatId } = await dmWith([
      'Plan:\n1. Patch the guard\n2. Add tests\n\nOnce you approve, I\'ll start with step 1 right away.',
    ])
    await orchestrator.submitUserMessage(chatId, 'Fix the guard.')
    expect(seen).toHaveLength(1)
  })

  it('leaves a finished report alone', async () => {
    const { orchestrator, seen, chatId } = await dmWith(['Done. The guard refuses an empty id and the tests pass.'])
    await orchestrator.submitUserMessage(chatId, 'Fix the guard.')
    expect(seen).toHaveLength(1)
  })

  it('never nudges twice for one message', async () => {
    const { orchestrator, store, seen, chatId } = await dmWith(['Now I\'ll run the tests.', 'Next I\'ll check the logs.'])
    await orchestrator.submitUserMessage(chatId, 'Fix the guard.')

    expect(seen).toHaveLength(2)
    const notes = (await store.loadEvents(chatId)).filter((event) => event.type === 'system_note')
    expect(notes).toHaveLength(1)
  })

  it('leaves a turn alone whose tool call came after the announcement', async () => {
    const store = createMemoryStore({ agents: roster })
    const seen: TurnInput[] = []
    const text = 'Now I\'ll run the tests.'
    const driver = scripted((input, attempt): RuntimeEvent[] => attempt === 1
      ? [
        { type: 'message', messageId: 'm1', text },
        { type: 'tool_use', toolCallId: 't1', tool: 'Bash', detail: 'pnpm test' },
        { type: 'tool_result', toolCallId: 't1', outcome: 'success' },
        { type: 'result', text, sessionId: 'session-1' },
      ]
      : [{ type: 'message', messageId: 'm2', text: 'The tests pass.' }, { type: 'result', text: 'The tests pass.', sessionId: input.sessionId ?? 'session-1' }], seen)
    const orchestrator = new Orchestrator({
      agents: () => roster, store, resolveDriver: () => driver, ensureScratchDir: scratchFor, emit: () => undefined, mcpServers: () => [],
    })
    const dm = await store.createChat({ kind: 'dm', memberIds: ['smith'], title: 'Smith' })
    await orchestrator.submitUserMessage(dm.id, 'Fix the guard.')

    expect(seen.some(nudged)).toBe(false)
    expect((await store.loadEvents(dm.id)).some((event) => event.type === 'system_note' && event.text === stallNudgeLine('Smith'))).toBe(false)
  })

  it('never continues an interview kickoff, whose write grant belongs to that one turn', async () => {
    const { orchestrator, seen, chatId } = await dmWith(['Ik ga nu je antwoorden verwerken.'], () => true)
    await orchestrator.submitUserMessage(chatId, 'Start the interview.')
    expect(seen).toHaveLength(1)
  })

  it('nudges again for the next message', async () => {
    const { orchestrator, seen, chatId } = await dmWith(['Now I\'ll run the tests.', 'Tests pass.', 'Let me check the logs.', 'Logs are clean.'])
    await orchestrator.submitUserMessage(chatId, 'Fix the guard.')
    await orchestrator.submitUserMessage(chatId, 'And the logs?')
    expect(seen.map(nudged)).toEqual([false, true, false, true])
  })
})
