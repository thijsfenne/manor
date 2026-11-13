import type { AgentConfig, AgentDraft } from '@manor/contracts'
import { cleanDraft, emptyDraft } from '../../persona'
import { MODELS, defaultModel, effortsFor } from '../../runtimes'

type Driver = AgentDraft['driver']

/** A blank agent on `driver` with that provider's default model, for the short New agent form. */
export function newAgentDraft(agents: AgentConfig[], driver: Driver = 'claude'): AgentDraft {
  const model = defaultModel(driver)
  return { ...emptyDraft(agents), driver, ...(model === undefined ? {} : { model }) }
}

/**
 * Moves the draft to another provider or model. A provider switch takes that provider's
 * default model, and the effort stays wherever the new model accepts it, else High.
 */
export function withRuntime(draft: AgentDraft, driver: Driver, model?: string): AgentDraft {
  const { model: _model, ...rest } = draft
  const nextModel = model !== undefined && MODELS[driver].some((option) => option.value === model) ? model : defaultModel(driver)
  const keepsEffort = effortsFor(driver, nextModel).some((option) => option.value === draft.effort)
  return { ...rest, driver, ...(nextModel === undefined ? {} : { model: nextModel }), ...(keepsEffort ? {} : { effort: 'high' }) }
}

/**
 * The instructions an agent starts with until the interview writes its own. The server
 * refuses an agent without instructions, so the form writes these from what it asked.
 */
export function starterInstructions({ name, description, isCos }: Pick<AgentDraft, 'name' | 'description' | 'isCos'>): string {
  const job = description.trim()
  return [
    `You are ${name.trim() || 'an assistant'} in this workspace.`,
    job === '' ? null : `You help with this: ${job}`,
    isCos ? 'Every message that is not addressed to someone else comes to you.' : null,
    'Answer directly and completely, in plain language. Say so when you are unsure, and ask one question when a request is unclear.',
  ].filter((line) => line !== null).join(' ')
}

/** What Create sends: the draft with its starter instructions, cleaned for the wire. */
export const draftToCreate = (draft: AgentDraft): AgentDraft =>
  cleanDraft({ ...draft, character: starterInstructions(draft) })
