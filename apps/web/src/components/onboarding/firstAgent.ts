import type { AgentConfig, AgentDraft, ProviderConnection } from '@manor/contracts'
import { draftToCreate, newAgentDraft } from '../agents/newAgent'

type Provider = ProviderConnection['provider']

/** Which provider the first agent runs on when several are ready. */
const PREFERENCE: readonly Provider[] = ['claude', 'codex', 'grok', 'cursor']

/** What routing reads for a first agent whose job the user left blank. */
const CATCH_ALL = 'Takes anything not addressed to someone specific.'

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
 * The first agent: the short New agent form's draft, plus the one thing a workspace
 * with one agent needs. It takes every unaddressed message.
 */
export function firstAgentDraft(agents: AgentConfig[], driver: Provider): AgentDraft {
  return { ...newAgentDraft(agents, driver), isCos: true }
}

/** What Create sends for the first agent: a blank job falls back to the catch-all line. */
export function firstAgentToCreate(draft: AgentDraft): AgentDraft {
  const created = draftToCreate(draft)
  return created.description === '' ? { ...created, description: CATCH_ALL } : created
}
