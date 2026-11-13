import type { ChatOverride } from '@manor/contracts'

export interface OptimisticChatOverride {
  requestId: string
  agentId: string
  override: ChatOverride
}

const isPinned = (override: ChatOverride): boolean =>
  override.driver !== undefined ||
  override.model !== undefined ||
  override.effort !== undefined ||
  override.speed !== undefined

function withOverride(
  overrides: Record<string, ChatOverride>,
  agentId: string,
  override: ChatOverride,
): Record<string, ChatOverride> {
  const next = { ...overrides }
  if (isPinned(override)) next[agentId] = override
  else delete next[agentId]
  return next
}

/** Replays client-side choices over the last server document while requests settle. */
export function withOptimisticOverrides(
  base: Record<string, ChatOverride>,
  pending: readonly OptimisticChatOverride[],
): Record<string, ChatOverride> {
  let current = base
  for (const change of pending) current = withOverride(current, change.agentId, change.override)
  return current
}
