import { describe, expect, it } from 'vitest'
import type { ThreadEvent } from '@manor/contracts'
import { CHANGED_AFTER_RESULT_NOTE, changedAfterResult, goalReviewBlock } from '../src/goalReview.js'

let seq = 0
const base = () => ({ id: `e${++seq}`, chatId: 'c', createdAt: seq })
const turn = (agentId: string, turnId: string, changed: boolean | string = false) => ({
  ...base(), type: 'turn_result', agentId, turnId,
  ...(changed === false ? {} : {
    fileChanges: [{ path: changed === true ? '/repo/a.ts' : changed, status: 'edited', added: 1, removed: 0, edits: [] }],
  }),
})
const pass = (turnId: string, tool = 'mcp__manor__review_passed') => [
  { ...base(), type: 'tool_use', agentId: 'argus', turnId, toolCallId: `${turnId}_call`, tool },
  { ...base(), type: 'tool_result', agentId: 'argus', turnId, toolCallId: `${turnId}_call`, outcome: 'success' },
]
const say = (agentId: string, turnId: string, text: string) => ({ ...base(), type: 'agent_message', agentId, turnId, text })
const gate = (events: unknown[]) => goalReviewBlock(events as ThreadEvent[], 'Argus')

describe('goalReviewBlock', () => {
  it('does not gate a Session that changed no files', () => {
    expect(gate([turn('smith', 't1'), turn('argus', 't2')])).toBeUndefined()
  })

  it('does not gate a Session that changed only prose', () => {
    expect(gate([turn('smith', 't1', '/repo/docs/report.md'), turn('smith', 't2', '/repo/.claude/ideas/note.txt')])).toBeUndefined()
  })

  it('refuses code a stopped or failed turn changed, when a later turn marks the goal', () => {
    const stopped = { ...base(), type: 'system_note', kind: 'aborted', text: "Smith's turn was stopped.", agentId: 'smith', turnId: 't1', changedFiles: ['/repo/a.ts'] }
    expect(gate([stopped, turn('smith', 't2')])).toBeDefined()
    expect(gate([stopped, ...pass('t3'), turn('argus', 't3'), turn('smith', 't4')])).toBeUndefined()
  })

  it('counts an MDX component as code', () => {
    expect(gate([turn('smith', 't1', '/repo/docs/Chart.mdx')])).toBeDefined()
  })

  it('counts a checkout Manor could not measure as changed code', () => {
    expect(gate([{ ...turn('smith', 't1'), fileChangesFailed: true }])).toBeDefined()
    expect(gate([{ ...base(), type: 'system_note', kind: 'error', text: 'failed', agentId: 'smith', turnId: 't1', fileChangesFailed: true }])).toBeDefined()
  })

  it('lets an earlier pass lapse when a later review stops or fails', () => {
    const passedOnce = [turn('smith', 't1', true), ...pass('t2'), turn('argus', 't2')]
    const failedRecheck = { ...base(), type: 'system_note', kind: 'error', text: 'Argus could not answer.', agentId: 'argus', turnId: 't3' }
    expect(gate(passedOnce)).toBeUndefined()
    expect(gate([...passedOnce, failedRecheck])).toBeDefined()
    expect(gate([...passedOnce, failedRecheck, ...pass('t4'), turn('argus', 't4')])).toBeUndefined()
  })

  it('refuses changed files that Argus has not reviewed', () => {
    expect(gate([turn('smith', 't1', true)])).toContain('summon @Argus')
  })

  it('refuses when Argus reviewed without passing', () => {
    expect(gate([turn('smith', 't1', true), turn('argus', 't2')])).toBeDefined()
  })

  it('allows once Argus passes the latest diff', () => {
    expect(gate([turn('smith', 't1', true), ...pass('t2'), turn('argus', 't2')])).toBeUndefined()
  })

  it('keeps a pass through a later answer that neither passes nor hands anything on', () => {
    const passedOnce = [turn('smith', 't1', true), ...pass('t2'), turn('argus', 't2')]
    expect(gate([...passedOnce, say('argus', 't3', 'Nothing is committed yet; that waits for Confirm.'), turn('argus', 't3')])).toBeUndefined()
    expect(gate([...passedOnce, say('argus', 't3', 'I checked it with @browser.'), turn('argus', 't3')])).toBeUndefined()
  })

  it('withdraws a pass when a later review hands findings on without passing', () => {
    const passedOnce = [turn('smith', 't1', true), ...pass('t2'), turn('argus', 't2')]
    const rejected = [...passedOnce, say('argus', 't3', '@Smith the save bar overlaps the form.'), turn('argus', 't3')]
    expect(gate(rejected)).toBeDefined()
    expect(gate([...rejected, ...pass('t4'), turn('argus', 't4')])).toBeUndefined()
  })

  it('keeps a rejection whatever the mentioned persona is called later', () => {
    // Read without the roster: Smith renamed to Alex, or removed, still handed findings on.
    const passedOnce = [turn('smith', 't1', true), ...pass('t2'), turn('argus', 't2')]
    expect(gate([...passedOnce, say('argus', 't3', '@Smith the save bar overlaps the form.'), turn('argus', 't3')])).toBeDefined()
  })

  it('refuses again when files change after the pass, until the next pass', () => {
    const changedAfter = [turn('smith', 't1', true), ...pass('t2'), turn('argus', 't2'), turn('smith', 't3', true)]
    expect(gate(changedAfter)).toBeDefined()
    expect(gate([...changedAfter, ...pass('t4'), turn('argus', 't4')])).toBeUndefined()
  })

  it('ignores a pass from anyone but Argus', () => {
    const forged = pass('t2').map((event) => ({ ...event, agentId: 'smith' }))
    expect(gate([turn('smith', 't1', true), ...forged, turn('smith', 't2')])).toBeDefined()
  })
})

describe('changedAfterResult', () => {
  const reachedNote = (handoffId = 'h1') => ({ ...base(), type: 'system_note', kind: 'info', text: 'Wren marked the goal reached.', workGoalHandoffId: handoffId })
  const warned = () => ({ ...base(), type: 'system_note', kind: 'info', text: CHANGED_AFTER_RESULT_NOTE })
  const after = (events: unknown[]) => changedAfterResult(events as ThreadEvent[], 'h1')

  it('flags a change after the published result, prose included, once', () => {
    expect(after([turn('wren', 't1', true), reachedNote(), turn('wren', 't2', '/repo/docs/a.md')])).toBe(true)
    expect(after([reachedNote(), turn('wren', 't2', true), warned(), turn('wren', 't3', true)])).toBe(false)
  })

  it('leaves changes made before the result, or before any result, alone', () => {
    expect(after([turn('wren', 't1', true), reachedNote(), turn('argus', 't2')])).toBe(false)
    expect(after([turn('wren', 't1', true), reachedNote('other')])).toBe(false)
  })

  it('warns again for a change after a newer result', () => {
    expect(after([reachedNote(), turn('wren', 't2', true), warned(), reachedNote(), turn('wren', 't4', true)])).toBe(true)
  })
})
