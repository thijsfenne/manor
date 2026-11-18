import { z } from 'zod'
import { EFFORTS, MAX_MESSAGE_ATTACHMENTS, MODELS, SINGLE_DRIVERS, effortsFor, type SingleRuntime } from '@manor/contracts'

export const WORK_TOOL_NAME = 'start_work' as const

export const WorkToolInputSchema = z.object({
  assignmentKey: z.string().trim().min(1).max(100),
  project: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(200),
  task: z.string().trim().min(1).max(40_000),
  summary: z.string().trim().min(1).max(300).optional(),
  firstExecutor: z.string().trim().min(1).max(200).optional(),
  supportingPersonas: z.array(z.string().trim().min(1).max(200)).max(8).optional(),
  // A project thread's proposed Single runtime (2026-10-11). Checked against the
  // catalog by `proposedRuntime`, so a refusal can name the valid choices.
  provider: z.string().trim().min(1).max(40).optional(),
  model: z.string().trim().min(1).max(100).optional(),
  effort: z.string().trim().min(1).max(20).optional(),
  runtimeReason: z.string().trim().min(1).max(120).optional(),
  // Images and files from this conversation the Session needs (2026-10-14).
  attachments: z.array(z.string().trim().min(1).max(1_000)).max(MAX_MESSAGE_ATTACHMENTS).optional(),
}).strict()
export type WorkToolInput = z.infer<typeof WorkToolInputSchema>

export interface WorkToolContext {
  chatId: string
  agentId: string
  turnId: string
  /**
   * A project thread wake: it sees `start_work` so the thread's toolset stays the same
   * on every turn, but only the user's message or a handed-over brief may propose work.
   */
  noProposal?: true
}

/**
 * The runtime a `start_work` call proposes, or undefined when it names none. All four
 * fields come together; anything outside the runtime catalog is refused with the valid
 * list, so the author can correct the call instead of guessing.
 */
export function proposedRuntime(input: WorkToolInput, off: readonly string[] = []): { runtime: SingleRuntime; reason: string } | undefined {
  const { provider, model, effort, runtimeReason } = input
  if (provider === undefined && model === undefined && effort === undefined && runtimeReason === undefined) return undefined
  if (provider === undefined || model === undefined || effort === undefined || runtimeReason === undefined) {
    throw new Error('A proposed runtime needs provider, model, effort and runtimeReason together, or none of them.')
  }
  const driver = SINGLE_DRIVERS.find((candidate) => candidate === provider)
  if (driver === undefined) throw new Error(`Unknown provider ${JSON.stringify(provider)}. Valid providers: ${SINGLE_DRIVERS.join(', ')}.`)
  const models = MODELS[driver].map((option) => option.value)
  if (!models.includes(model)) {
    throw new Error(`Unknown ${driver} model ${JSON.stringify(model)}. Valid ${driver} models: ${models.join(', ')}.`)
  }
  if (off.includes(model)) {
    const on = models.filter((value) => !off.includes(value))
    throw new Error(`${model} is turned off in Settings, Models. ${on.length === 0 ? `Every ${driver} model is off; pick another provider.` : `Models still on for ${driver}: ${on.join(', ')}.`}`)
  }
  const efforts = effortsFor(driver, model).map((option) => option.value)
  const level = EFFORTS.find((option) => option.value === effort)?.value
  if (level === undefined || !efforts.includes(level)) {
    throw new Error(`Effort ${JSON.stringify(effort)} is not available on ${model}. Valid efforts: ${efforts.join(', ')}.`)
  }
  return { runtime: { driver, model, effort: level }, reason: runtimeReason }
}
