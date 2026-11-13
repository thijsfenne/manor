import type { RuntimeEvent, TurnHandle, TurnInput, VolatileBlock } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { blockHeader, blockWithdrawal, createResumedContext } from '../src/drivers/resumedContext.js'
import { sage } from './helpers.js'

const notes: VolatileBlock = { key: 'notes', text: '[Manor] Current notes.md:\n- Export ships next' }
const preferences: VolatileBlock = { key: 'preferences', text: '[Manor] Project preferences:\n- Corners are round' }
const retrieved: VolatileBlock = { key: 'structured-retrieved', text: '[Manor] Memory files retrieved:\nEVIDENCE' }

const input = (blocks: VolatileBlock[], sessionId?: string, character = sage.character): TurnInput => ({
  agent: { ...sage, character },
  threadId: 'thread',
  cwd: '/tmp/manor-scratch/thread',
  repoPaths: [],
  catchUp: [],
  isFullCatchUp: sessionId === undefined,
  ...(sessionId === undefined ? {} : { sessionId }),
  ...(blocks.length === 0 ? {} : { volatileBlocks: blocks }),
})

/** A turn's stream: the events it yields, then the end a stop or failure gives it. */
function handle(events: RuntimeEvent[]): TurnHandle {
  return {
    events: (async function* () {
      for (const event of events) yield event
    })(),
    stop() {},
  }
}
const drain = async (turn: TurnHandle) => {
  for await (const _event of turn.events) { /* consumed by the turn runner */ }
}
const answered = (sessionId: string) => handle([{ type: 'result', text: 'Done.', sessionId }])

describe.each([false, true])('per-block context delivery (retainsCharacter %s)', (retainsCharacter) => {
  /** Prepares and runs one turn the way a driver does, and returns what it wrote. */
  async function turn(context: ReturnType<typeof createResumedContext>, next: TurnInput, events = answered('s1')) {
    const prepared = context(next)
    await drain(prepared.track(events, next.sessionId))
    return prepared.contextBlock ?? ''
  }

  it('gives a fresh session every block, and an unchanged resumed turn none', async () => {
    const context = createResumedContext({ retainsCharacter })
    const fresh = await turn(context, input([notes, preferences]))
    expect(fresh).toContain(`${blockHeader('notes')}\n${notes.text}`)
    expect(fresh).toContain(`${blockHeader('preferences')}\n${preferences.text}`)
    expect(await turn(context, input([notes, preferences], 's1'))).toBe('')
  })

  it('sends a changed block alone and withdraws a removed one once', async () => {
    const context = createResumedContext({ retainsCharacter })
    await turn(context, input([notes, preferences]))
    const changed = { ...notes, text: `${notes.text}\n- Fingerprint landed` }
    const sent = await turn(context, input([changed, preferences], 's1'))
    expect(sent).toContain(changed.text)
    expect(sent).not.toContain(preferences.text)
    const removed = await turn(context, input([changed], 's1'))
    expect(removed).toBe(blockWithdrawal('preferences'))
    expect(await turn(context, input([changed], 's1'))).toBe('')
  })

  it('resends everything after a compaction and on a rolled-over session', async () => {
    const context = createResumedContext({ retainsCharacter })
    await turn(context, input([notes, preferences]))
    context.forget('s1')
    const compacted = await turn(context, input([notes, preferences], 's1'))
    expect(compacted).toContain(notes.text)
    expect(compacted).toContain(preferences.text)
    // A rollover starts a new provider session: Manor resumes nothing.
    const rolled = await turn(context, input([notes, preferences]), answered('s2'))
    expect(rolled).toContain(notes.text)
    expect(rolled).toContain(preferences.text)
    // A compaction the CLI ran on its own mid-turn forgets the session as well.
    const prepared = context(input([notes, preferences], 's2'))
    prepared.invalidate()
    await drain(prepared.track(answered('s2'), 's2'))
    expect(await turn(context, input([notes, preferences], 's2'), answered('s2'))).toContain(notes.text)
  })

  it('withdraws memory blocks without resending them when memory is switched off', async () => {
    const context = createResumedContext({ retainsCharacter })
    await turn(context, input([preferences, retrieved]))
    const off = await turn(context, input([preferences], 's1'))
    expect(off).toBe(blockWithdrawal('structured-retrieved'))
    expect(off).not.toContain('EVIDENCE')
  })

  it('confirms nothing for a failed, stopped or promptless turn, so it goes out again', async () => {
    const context = createResumedContext({ retainsCharacter })
    await turn(context, input([notes]))
    const changed = { ...notes, text: `${notes.text}\n- Changed` }
    // Failed: no result.
    await turn(context, input([changed], 's1'), handle([{ type: 'error', message: 'boom' }]))
    expect(await turn(context, input([changed], 's1'), handle([{ type: 'error', message: 'boom' }]))).toContain(changed.text)
    // Stopped before its result was read.
    const stopped = context(input([changed], 's1'))
    const tracked = stopped.track(answered('s1'), 's1')
    tracked.stop()
    await drain(tracked)
    // A live session's own wake run writes no prompt.
    const promptless = context(input([changed], 's1'))
    promptless.skip()
    await drain(promptless.track(answered('s1'), 's1'))
    // And a block that went out unconfirmed and is gone now is withdrawn.
    expect(await turn(context, input([], 's1'))).toBe(blockWithdrawal('notes'))
  })

  it('restores a block whose withdrawal was never confirmed', async () => {
    const context = createResumedContext({ retainsCharacter })
    await turn(context, input([notes, preferences]))
    // The withdrawal may be in native history although the turn failed.
    await turn(context, input([notes], 's1'), handle([{ type: 'error', message: 'boom' }]))
    expect(await turn(context, input([notes, preferences], 's1'))).toBe(`${blockHeader('preferences')}\n${preferences.text}`)
  })

  it('withdraws every absent block on a resumed session it holds no record of', async () => {
    // A restart or an eviction: the provider session may hold anything from before.
    const context = createResumedContext({ retainsCharacter })
    const resumed = await turn(context, input([notes], 's1'))
    expect(resumed).toContain(notes.text)
    for (const key of ['sessions', 'preferences', 'structured-indexes', 'structured-retrieved', 'selected-skills'] as const) {
      expect(resumed).toContain(blockWithdrawal(key))
    }
    expect(resumed).not.toContain(blockWithdrawal('notes'))
  })
})

describe('persona refresh for CLIs that retain startup instructions', () => {
  it('resends a changed persona whole only where the CLI keeps it, and keeps blocks per key', async () => {
    for (const retainsCharacter of [false, true]) {
      const context = createResumedContext({ retainsCharacter })
      const first = context(input([notes]))
      await drain(first.track(answered('s1'), undefined))
      const next = context(input([notes], 's1', 'You are Sage, updated.'))
      expect(next.contextBlock?.includes('[Manor] Updated persona and working context for this turn.') ?? false).toBe(retainsCharacter)
      // A resent persona carries its old preferences copy, so the blocks that correct it go along.
      expect((next.contextBlock ?? '').includes(notes.text)).toBe(retainsCharacter)
    }
  })
})
