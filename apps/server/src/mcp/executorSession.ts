import { effectReviewArguments } from '../effectReviewInput.js'
import { EFFECT_CALL_LIMIT } from '../effectBroker.js'
import { executorAppAccess } from '../effectPolicy.js'
import type { ExecutorContinuation } from '../effectCapability.js'

type RecordValue = Record<string, unknown>
const record = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

interface PausedExecution {
  origin: unknown
  interaction: RecordValue
  permit?: string
}

/** One proxy lifetime, hence one persona turn. Does not create persistent app grants. */
export class ExecutorSession {
  private readonly paused = new Map<string, PausedExecution>()
  private previous: unknown

  constructor(
    private readonly authorize: (tool: string, input: unknown, reviewInput: unknown, continuation?: ExecutorContinuation) => Promise<string | void>,
    private readonly call: (tool: string, input: unknown) => Promise<RecordValue>,
  ) {}

  async run(tool: string, input: unknown): Promise<RecordValue> {
    const pendingId = tool === 'resume' && record(input) && typeof input.executionId === 'string'
      ? input.executionId : undefined
    const pending = pendingId === undefined ? undefined : this.paused.get(pendingId)
    const origin = tool === 'execute' ? effectReviewArguments(input) : pending?.origin
    const previous = this.previous
    this.previous = undefined
    const granted = await this.authorize(tool, input, {
      input,
      ...(previous === undefined ? {} : { previous }),
      ...(pending === undefined ? {} : { origin: pending.origin, interaction: pending.interaction }),
    })
    const permit = typeof granted === 'string' ? granted : pending?.permit
    if (pendingId !== undefined) this.paused.delete(pendingId)

    let result = await this.call(tool, input)
    // Each continuation still crosses the broker, including revocation and budgets.
    // Bound an upstream that repeatedly asks without making progress.
    for (let hop = 0; ; hop += 1) {
      const payload = result.structuredContent
      if (result.isError === true || !record(payload) || payload.status !== 'waiting_for_interaction' ||
        typeof payload.executionId !== 'string' || !record(payload.interaction)) break
      const { executionId, interaction } = payload
      const context = effectReviewArguments({ origin, interaction })
      this.paused.delete(executionId)
      if (context !== undefined && origin !== undefined && this.paused.size < EFFECT_CALL_LIMIT) {
        this.paused.set(executionId, { origin, interaction, ...(permit === undefined ? {} : { permit }) })
      }
      if (hop >= 3 || context === undefined || origin === undefined || !executorAppAccess(interaction)) break
      const resume = { executionId, action: 'accept', content: '{}' }
      try {
        await this.authorize('resume', resume, {
          input: resume, origin, interaction,
          ...(permit !== undefined || previous === undefined ? {} : { previous }),
        }, permit === undefined ? undefined : { permit, executionId, interaction })
      } catch (error: unknown) {
        return {
          ...result,
          isError: true,
          content: [{ type: 'text', text: `${error instanceof Error ? error.message : 'Continuation denied.'} Execution ${executionId} remains paused; do not retry without new user direction.` }],
        }
      }
      this.paused.delete(executionId)
      result = await this.call('resume', resume)
    }

    // Preserve the gateway's actual output, not a model-written summary of the UI.
    // Oversized or credential-bearing output is omitted as a whole, never truncated.
    if (result.isError !== true) {
      this.previous = effectReviewArguments({
        input: origin ?? input, result: result.structuredContent ?? result.content, capturedAt: Date.now(),
      })
    }
    return result
  }
}
