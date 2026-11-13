import type { AgentDraft, McpAttachment, McpServerConfig } from '@manor/contracts'

/**
 * What a connector costs in the window. No provider loads its schemas up front any
 * more (measured 2026-10-18 on Claude, Codex, Grok and Cursor): at rest a turn carries
 * at most one listed name per tool, Codex not even that, and a schema enters only
 * when a persona looks the tool up, as conversation from then on.
 */

/**
 * A listed `mcp__<server>__<tool>` name. Measured at about ten tokens per tool on a
 * 56-tool server: 557 on Cursor, 497 on Grok.
 */
const LISTED_TOKENS_PER_TOOL = 10

/**
 * Input tokens per character of tool schemas plus the server's `instructions` block,
 * once they are loaded. Fitted against Context7 and Supabase on real `claude -p` turns;
 * see `.claude/ideas/2026-08-07-mcp-in-manor.md`.
 */
const LOADED_TOKENS_PER_CHAR = 0.42

/** What one registered connector costs a turn: listed while unused, and if every schema is loaded. */
export const connectorCost = (server: Pick<McpServerConfig, 'tools' | 'schemaChars'>) => ({
  listedTokens: server.tools.length * LISTED_TOKENS_PER_TOOL,
  loadedTokens: Math.round(server.schemaChars * LOADED_TOKENS_PER_CHAR),
})

export interface AttachmentCost {
  /** Tools the persona would actually receive, exclusions already taken out. */
  tools: number
}

/** Registry rows for a draft's attachments, in registry order. Unknown ids are dropped. */
export const attachedServers = (draft: AgentDraft, registry: McpServerConfig[]): McpServerConfig[] =>
  registry.filter((server) => draft.mcpServers.some((attachment) => attachment.serverId === server.id))

export const attachmentOf = (draft: AgentDraft, serverId: string): McpAttachment | undefined =>
  draft.mcpServers.find((attachment) => attachment.serverId === serverId)

/** How many tools this persona's attachments give it, exclusions already taken out. */
export function attachmentCost(draft: AgentDraft, registry: McpServerConfig[]): AttachmentCost {
  let tools = 0
  for (const server of attachedServers(draft, registry)) {
    const excluded = attachmentOf(draft, server.id)?.disabledTools.length ?? 0
    tools += Math.max(0, server.tools.length - excluded)
  }
  return { tools }
}

/** 7.342 reads better than 7342 in a form, and matches how the notes write numbers. */
export const formatTokens = (tokens: number): string =>
  tokens < 1_000 ? String(tokens) : `${(tokens / 1_000).toFixed(1)}k`

/**
 * Attaches or detaches one server, keeping the exclusion list of the ones that stay.
 * A fresh attachment of a write-capable server starts with nothing excluded: the
 * decision to attach it is the decision, and a half-excluded default would only make
 * the form disagree with itself.
 */
export function toggleAttachment(draft: AgentDraft, serverId: string): McpAttachment[] {
  const held = draft.mcpServers.some((attachment) => attachment.serverId === serverId)
  if (held) return draft.mcpServers.filter((attachment) => attachment.serverId !== serverId)
  return [...draft.mcpServers, { serverId, disabledTools: [] }]
}

/**
 * Excludes or restores every tool of one attached server at once. Names rather than a
 * flag, so a server whose tool list has grown since the exclusion was saved cannot be
 * left holding a name it no longer offers. Detaching stays the way to reach zero: a
 * fully excluded server still ships its instructions block on every turn.
 */
export function setExcludedTools(draft: AgentDraft, serverId: string, tools: string[]): McpAttachment[] {
  return draft.mcpServers.map((attachment) =>
    attachment.serverId === serverId ? { ...attachment, disabledTools: tools } : attachment,
  )
}

/** Excludes or restores one tool of one attached server. */
export function toggleExcludedTool(draft: AgentDraft, serverId: string, tool: string): McpAttachment[] {
  return draft.mcpServers.map((attachment) => {
    if (attachment.serverId !== serverId) return attachment
    const excluded = attachment.disabledTools.includes(tool)
    return {
      ...attachment,
      disabledTools: excluded
        ? attachment.disabledTools.filter((name) => name !== tool)
        : [...attachment.disabledTools, tool],
    }
  })
}
