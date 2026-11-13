import { readWallClock } from '@manor/contracts'
import { z } from 'zod'

export const ROUTINE_TOOL_NAMES = ['routine_list', 'routine_save', 'routine_cancel'] as const
export type RoutineToolName = (typeof ROUTINE_TOOL_NAMES)[number]

/**
 * A moment as a persona writes it: ISO 8601, either with an offset (`...+02:00`, `Z`)
 * or as wall-clock time (`2026-09-28T10:00`) read in the routine's timezone. Wall
 * clock is the form a model gets right; an offset it computed itself is the form it
 * gets an hour wrong across the October change.
 */
const MomentSchema = z.string().min(10).max(40)

/** The fields a persona may choose; destination and persona come from its DM capability. */
export const RoutineToolSaveInputSchema = z.object({
  routineId: z.string().min(1).max(200).optional(),
  name: z.string().max(200).optional(),
  prompt: z.string().max(40_000).optional(),
  cron: z.string().max(240).optional(),
  runAt: MomentSchema.optional(),
  lateUntil: MomentSchema.nullable().optional(),
  action: z.enum(['run', 'remind']).optional(),
  timezone: z.string().min(1).max(120).optional(),
  enabled: z.boolean().optional(),
  notify: z.boolean().optional(),
}).strict().superRefine((input, context) => {
  if (input.cron !== undefined && input.runAt !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'routine_save takes either cron (recurring) or runAt (one time), not both',
    })
  }
  if (
    input.name !== undefined ||
    input.prompt !== undefined ||
    input.cron !== undefined ||
    input.runAt !== undefined ||
    input.lateUntil !== undefined ||
    input.action !== undefined ||
    input.timezone !== undefined ||
    input.enabled !== undefined ||
    input.notify !== undefined
  ) return
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'routine_save needs at least one field to save',
  })
})
export type RoutineToolSaveInput = z.infer<typeof RoutineToolSaveInputSchema>

export const RoutineToolCancelInputSchema = z.object({
  routineId: z.string().min(1).max(200),
}).strict()
export type RoutineToolCancelInput = z.infer<typeof RoutineToolCancelInputSchema>

export type RoutineToolInput = RoutineToolSaveInput | RoutineToolCancelInput

export interface RoutineToolContext {
  chatId: string
  agentId: string
  turnId: string
}

const OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/i

/**
 * Epoch ms for a persona-written moment, or a throw naming what could not be read.
 * Wall-clock time is resolved in `timezone`, and refused when it does not exist there
 * or happens twice; an explicit offset is taken as written, which is also how an
 * autumn hour that happens twice is named exactly.
 */
export function parseMoment(value: string, timezone: string): number {
  const text = value.trim()
  const offset = OFFSET.exec(text)
  if (offset === null) {
    const reading = readWallClock(text, timezone)
    if (!reading.ok) throw new Error(reading.reason)
    return reading.at
  }
  // Date.parse rolls 30 February into March, so the fields are checked on their own.
  const fields = readWallClock(text.slice(0, offset.index).replace(/\.\d+$/, ''), 'UTC')
  const at = Date.parse(text)
  if (!fields.ok || Number.isNaN(at)) {
    throw new Error(fields.ok ? `${JSON.stringify(value)} is not a date and time like 2026-09-28T10:00` : fields.reason)
  }
  return at
}
