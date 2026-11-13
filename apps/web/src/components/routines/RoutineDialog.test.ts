import { describe, expect, it } from 'vitest'
import { emptyRoutineDraft } from '../../routines'
import { bindFixedRoutineTarget } from './RoutineDialog'

describe('a routine dialog fixed to a direct message', () => {
  it('pins the hidden destination and persona without changing editable fields', () => {
    const draft = {
      ...emptyRoutineDraft('project_1', 'wren'),
      id: 'routine_1',
      name: 'Slack catch-up',
      description: 'Finds new mentions.',
      prompt: 'Check Slack.',
      model: 'claude-opus-4-1',
      effort: 'high' as const,
      notify: true,
    }

    expect(bindFixedRoutineTarget(draft, { kind: 'dm', chatId: 'dm_1', agentId: 'smith' })).toEqual({
      ...draft,
      projectId: null,
      chatId: 'dm_1',
      agentId: 'smith',
      model: null,
      effort: null,
    })
  })

  it('leaves the house-wide editor draft untouched', () => {
    const draft = emptyRoutineDraft('project_1', 'smith')

    expect(bindFixedRoutineTarget(draft, undefined)).toBe(draft)
  })
})
