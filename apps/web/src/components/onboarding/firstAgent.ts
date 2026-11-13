import type { AgentConfig, AgentDraft, ProviderConnection } from '@manor/contracts'
import { defaultModel } from '@manor/client-runtime/runtimes'
import { emptyDraft } from '../../persona'

type Provider = ProviderConnection['provider']

/** Which provider the first agent runs on when several are ready. */
const PREFERENCE: readonly Provider[] = ['claude', 'codex', 'grok', 'cursor']

const inState = (connections: readonly ProviderConnection[], state: ProviderConnection['state']): Provider[] =>
  PREFERENCE.filter((provider) => connections.some((row) => row.provider === provider && row.state === state))

/**
 * The providers a new agent can run on right now, in the order they are offered. One
 * that is signed in comes first. One that is installed but did not say whether it is
 * signed in still counts, as it does for the server's own side jobs: its CLI may only
 * have been slow, and refusing it would leave the user with nothing to press.
 */
export const usableProviders = (connections: readonly ProviderConnection[]): Provider[] =>
  [...inState(connections, 'ready'), ...inState(connections, 'attention')]

/**
 * The instructions the first agent starts with. They follow the name the user types
 * until the user writes their own.
 */
export const firstAgentCharacter = (name: string): string =>
  `You are ${name.trim() || 'an assistant'} in this workspace. Every message that is not addressed to someone else comes to you. Answer directly and completely, in plain language. Say so when you are unsure, and ask one question when a request is unclear.`

/**
 * The first agent with everything filled in except who it is: the name and the role
 * are the user's to invent. It takes every unaddressed message, because a workspace
 * with one agent needs somebody to.
 */
export function firstAgentDraft(agents: AgentConfig[], driver: Provider): AgentDraft {
  const model = defaultModel(driver)
  return {
    ...emptyDraft(agents),
    description: 'Takes anything not addressed to someone specific.',
    character: firstAgentCharacter(''),
    driver,
    ...(model === undefined ? {} : { model }),
    isCos: true,
    // Memory is what the standing files and the daily log hang on; a first agent has it.
    memoryScope: true,
  }
}

/** Moves the draft to another provider, with that provider's default model. */
export function withProvider(draft: AgentDraft, driver: Provider): AgentDraft {
  const { model: _model, ...rest } = draft
  const model = defaultModel(driver)
  return { ...rest, driver, ...(model === undefined ? {} : { model }) }
}

/** Renames the agent, and its instructions with it while they are still the starter text. */
export function withName(draft: AgentDraft, name: string): AgentDraft {
  const followsName = draft.character === firstAgentCharacter(draft.name)
  return { ...draft, name, ...(followsName ? { character: firstAgentCharacter(name) } : {}) }
}
