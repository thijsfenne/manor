import { contextWindowFor, type AgentConfig, type AttachedMcpServer, type ContextEstimate, type ContextFigure } from '@manor/contracts'

/**
 * What the provider said about this turn's window, as the driver handed it over.
 * Every field is optional because every driver answers a different subset: Codex
 * names a window, Claude and Cursor only a fill, Grok and mock neither.
 */
export interface ReportedContext {
  model: string | undefined
  /** `turn_result.contextTokens`, the prompt of the turn's final request. */
  contextTokens?: number
  /** `turn_result.contextWindow`, present only when the CLI named one. */
  contextWindow?: number
  /** Known rather than reported; see `claudeAutocompactTokens`. */
  autoCompactTokens?: number
}

/**
 * Characters per token for the text Manor supplies, by tokenizer family. Measured on
 * 2026-10-18 by sending one 74,149-character Manor system prompt on a one-request
 * turn with and without it: Claude Opus 5.5 took 27.7k tokens (2.68, matching the
 * CLI's own `/context`, which gives the same 27.9k on Sonnet and Haiku 5.5), Grok 4.7
 * 20.0k (3.70), GPT 6.1 Sol 17.4k (4.27) and Cursor's Composer 2.5 17.3k (4.28). The
 * model decides, not the driver, because Cursor also runs Claude and Grok models; an
 * unmeasured family keeps the plain four.
 */
function charsPerToken(driver: AgentConfig['driver'], model: string | undefined): number {
  const id = `${driver === 'cursor' ? '' : driver} ${model ?? ''}`
  if (/claude|opus|sonnet|haiku|fable/.test(id)) return 2.7
  if (/grok/.test(id)) return 3.7
  if (/codex|gpt|composer/.test(id)) return 4.25
  return 4
}

/** Identifiers tokenise worse than prose, so names count three characters a token, not four. */
const NAME_CHARS_PER_TOKEN = 3

/**
 * Schema tokens per tool of Manor's own server, which Claude loads up front
 * (`alwaysLoad`) while every other connector waits behind tool search. Measured with
 * `/context` on Opus 5.5: nine of its tools came to 5.3k, about 590 each.
 */
const MANOR_TOOL_TOKENS = 590

/**
 * Grok's `search_tool` and `use_tool`, the gateway it adds only when MCP is attached.
 * Measured on grok 1.0.62 as the difference between turns with and without them.
 */
const GROK_MCP_GATEWAY_TOKENS = 2_100

const enabledTools = ({ server, disabledTools }: AttachedMcpServer): string[] =>
  server.tools.filter((tool) => !disabledTools.includes(tool))

/**
 * One listed name per enabled tool, in the `mcp__<server>__<tool>` form Claude prints.
 * Measured against 56 tools of one server: Cursor listed 557 tokens and Grok 497,
 * where this gives 552.
 */
function listedNameTokens(servers: readonly AttachedMcpServer[]): number {
  const chars = servers.reduce((sum, attachment) =>
    sum + enabledTools(attachment).reduce((names, tool) => names + `mcp__${attachment.server.name}__${tool}`.length + 1, 0), 0)
  return Math.ceil(chars / NAME_CHARS_PER_TOKEN)
}

/**
 * What attached MCP tools occupy in the window while nobody uses them, as each CLI
 * loads them (measured 2026-10-18). None loads a connector's schemas up front. Claude
 * lists the names behind tool search, except Manor's own server, whose schemas sit
 * inline. Grok and Cursor list the names too, and Grok adds its gateway tools. Codex
 * lists nothing: its code mode reaches MCP tools from inside one `exec` tool, and a
 * turn with a 56-tool server attached measured the same to the token as one without.
 * A schema fetched mid-turn is conversation by then, so it counts as Messages.
 */
function mcpTokens(driver: AgentConfig['driver'], servers: readonly AttachedMcpServer[]): number {
  if (servers.length === 0) return 0
  if (driver === 'claude') {
    const inline = servers.filter(({ server }) => server.id === 'builtin_manor')
    const deferred = servers.filter(({ server }) => server.id !== 'builtin_manor')
    return listedNameTokens(deferred) + inline.reduce((sum, attachment) => sum + enabledTools(attachment).length * MANOR_TOOL_TOKENS, 0)
  }
  if (driver === 'grok') return GROK_MCP_GATEWAY_TOKENS + listedNameTokens(servers)
  if (driver === 'cursor') return listedNameTokens(servers)
  return 0
}

const measured = (tokens: number | undefined): ContextFigure =>
  tokens === undefined || !Number.isFinite(tokens) || tokens < 0
    ? { source: 'unknown' }
    : { source: 'measured', tokens: Math.round(tokens) }

/**
 * Count current supplied blocks, not secrets, message bodies or native CLI history.
 *
 * The supplied-block counts use the measured characters per token of the turn's model
 * and the MCP count follows how its CLI loads tools, so all of them are estimates. The
 * window figures travel with their provenance, so nothing a driver never reported
 * reaches a reader as a zero or as an estimate wearing a measurement's label.
 */
export function estimateContext(input: {
  driver: AgentConfig['driver']
  character: string
  memory: string
  skillChars: number
  mcpServers: readonly AttachedMcpServer[]
  /** Absent for callers with no turn to report, which then get the estimate alone. */
  reported?: ReportedContext
}): ContextEstimate {
  const ratio = charsPerToken(input.driver, input.reported?.model)
  const tokens = (chars: number) => Math.ceil(Math.max(0, chars) / ratio)
  const estimate: ContextEstimate = {
    instructions: tokens(input.character.length - input.memory.length - input.skillChars),
    memory: tokens(input.memory.length),
    skills: tokens(input.skillChars),
    mcpCatalog: mcpTokens(input.driver, input.mcpServers),
    unmeasuredMcpServers: input.mcpServers.filter(({ server }) => server.tools.length === 0).length,
  }
  const reported = input.reported
  if (reported === undefined) return estimate
  return {
    ...estimate,
    used: measured(reported.contextTokens),
    // A catalog constant is a real number and a useful denominator, but it is not a
    // reading, so it says so. Only Codex gets to claim `measured` here.
    window: reported.contextWindow !== undefined && reported.contextWindow > 0
      ? { source: 'measured', tokens: Math.round(reported.contextWindow) }
      : { source: 'estimated', tokens: contextWindowFor(input.driver, reported.model) },
    autoCompactAt: measured(reported.autoCompactTokens),
  }
}
