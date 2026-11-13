import { describe, expect, it } from 'vitest'
import { emptyWorkspace, reduce } from '../src/state'

describe('suggestions state', () => {
  it('keeps host availability beside the complete Jeeves ledger response', () => {
    const loaded = reduce(emptyWorkspace, {
      type: 'workflow_suggestions',
      available: true,
      suggestions: [{
        id: 'interview-prep-note',
        name: 'Interview prep note',
        description: 'A vault template.',
        occurrences: '5 across companies.',
        corrections: 'Prefer a template.',
        existingCoverage: 'Partial.',
        status: 'ready',
        statusDetail: 'ready',
      }],
    })

    expect(loaded.workflowSuggestions).toMatchObject({
      available: true,
      suggestions: [{ id: 'interview-prep-note', status: 'ready' }],
    })
    expect(reduce(emptyWorkspace, {
      type: 'workflow_suggestions',
      available: false,
      suggestions: [],
    }).workflowSuggestions).toEqual({ available: false, suggestions: [] })
  })
})
