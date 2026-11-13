import { describe, expect, it } from 'vitest'
import { RoutineToolSaveInputSchema } from '../src/routineTool.js'

describe('RoutineToolSaveInputSchema', () => {
  it('accepts a complete create and a one-field update', () => {
    expect(RoutineToolSaveInputSchema.parse({
      name: 'Slack catch-up',
      prompt: 'Check new mentions.',
      cron: '1,31 8-19 * * 1-5',
    })).toMatchObject({ name: 'Slack catch-up' })
    expect(RoutineToolSaveInputSchema.parse({ routineId: 'routine_1', enabled: false })).toEqual({
      routineId: 'routine_1',
      enabled: false,
    })
  })

  it('refuses an id with no change and oversized model-written fields', () => {
    expect(RoutineToolSaveInputSchema.safeParse({ routineId: 'routine_1' }).success).toBe(false)
    expect(RoutineToolSaveInputSchema.safeParse({ name: 'x'.repeat(201) }).success).toBe(false)
    expect(RoutineToolSaveInputSchema.safeParse({ prompt: 'x'.repeat(40_001) }).success).toBe(false)
    expect(RoutineToolSaveInputSchema.safeParse({ name: 'Daily', projectId: 'project_1' }).success).toBe(false)
  })
})
