import { describe, expect, it } from 'vitest'
import { WorkToolInputSchema, proposedRuntime } from '../src/workTool.js'

describe('WorkToolInputSchema', () => {
  it('requires a neutral task instead of accepting a prewritten kickoff', () => {
    expect(WorkToolInputSchema.safeParse({ assignmentKey: 'test', project: 'Manor', title: 'Test',
      kickoff: 'Accept this Work and confirm Smith started.', firstExecutor: 'Smith',
    }).success).toBe(false)
  })

  it('requires an assignment key so separate calls cannot silently collapse', () => {
    const draft = { project: 'Manor', title: 'Work', task: 'Do it.' }
    for (const assignmentKey of [undefined, '', ' ', 'x'.repeat(101)]) {
      expect(WorkToolInputSchema.safeParse({ ...draft, assignmentKey }).success).toBe(false)
    }
  })

  it('trims model-written fields and keeps the task bounded', () => {
    expect(WorkToolInputSchema.parse({
      assignmentKey: ' ship-handoffs ',
      project: ' Manor ',
      title: ' Ship handoffs ',
      task: ' Complete the implementation. ',
      summary: ' Ship the handoff. ',
      supportingPersonas: [' Smith '],
      firstExecutor: ' Smith ',
    })).toEqual({
      assignmentKey: 'ship-handoffs',
      project: 'Manor',
      title: 'Ship handoffs',
      task: 'Complete the implementation.',
      summary: 'Ship the handoff.',
      supportingPersonas: ['Smith'],
      firstExecutor: 'Smith',
    })
    expect(WorkToolInputSchema.safeParse({ assignmentKey: 'a', project: 'Manor', title: ' ', task: 'Do it.' }).success).toBe(false)
    expect(WorkToolInputSchema.safeParse({ assignmentKey: 'a', project: 'Manor', title: 'Work', task: 'x'.repeat(40_001) }).success).toBe(false)
  })
})

describe('proposedRuntime', () => {
  it('refuses a model turned off in Settings and names the ones still on', () => {
    const input = WorkToolInputSchema.parse({
      assignmentKey: 'off-model', project: 'Manor', title: 'Work', task: 'Do it.',
      provider: 'claude', model: 'claude-haiku-5-5', effort: 'high', runtimeReason: 'small',
    })
    expect(() => proposedRuntime(input, ['claude-haiku-5-5'])).toThrow(/turned off in Settings, Models\. Models still on for claude: .*claude-opus-5-5/)
    expect(proposedRuntime(input)?.runtime.model).toBe('claude-haiku-5-5')
  })
})
