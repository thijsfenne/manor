import { describe, expect, it } from 'vitest'
import { WorkToolInputSchema } from '../src/workTool.js'

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
