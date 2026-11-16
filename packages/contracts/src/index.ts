export { MODELS, EFFORTS, defaultModel, modelLabel, effortsFor, clampsEffort } from './runtimeCatalog.js'
import { MODELS, defaultModel, effortsFor } from './runtimeCatalog.js'
import { z } from 'zod'
export * from './auth.js'
export * from './slackRichText.js'
export * from './searchText.js'
export * from './connectCard.js'
export * from './remoteImages.js'
export * from './webLinks.js'
export * from './imageRefs.js'
export * from './quoteRefs.js'
export * from './userMessage.js'
export * from './chatCommands.js'
import { ConnectRequestEventSchema, ConnectStatusEventSchema, OpenConnectCardMessageSchema } from './connectCard.js'
export * from './composioApps.js'
import {
  ComposioAccountsMessageSchema,
  ComposioCatalogMessageSchema,
  ComposioConnectedAppSchema,
  ComposioKeyMessageSchema,
  ConnectComposioAppMessageSchema,
  DisconnectComposioAppMessageSchema,
  ListComposioAppsMessageSchema,
  RemoveComposioKeyMessageSchema,
  SetComposioKeyMessageSchema,
} from './composioApps.js'
export * from './directoryPatch.js'
import { SlackRichTextSchema, type SlackRichText } from './slackRichText.js'

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

/**
 * How hard the model thinks before it answers. Drivers map this shared five-level
 * scale to the closest setting each installed CLI exposes.
 */
export const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
export type Effort = z.infer<typeof EffortSchema>

/**
 * Which provider runs a turn. One list rather than two, because a persona's roster
 * value and a chat's pin have to name the same set: a provider a chat can pin but a
 * persona cannot hold (or the other way round) is a pin that resolves to nothing.
 */
export const DriverSchema = z.enum(['claude', 'codex', 'grok', 'cursor', 'mock'])
/** The name of one, not the interface: `Driver` below is what a driver *is*. */
export type DriverName = z.infer<typeof DriverSchema>

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

/**
 * An MCP server Manor knows how to attach. One row per server, shared by the
 * whole household; which personas get it is the attachment below.
 *
 * A row is either a spawned stdio process (`command`) or a streamable HTTP
 * endpoint (`url`). Exactly one of those is set; the drivers render the matching
 * shape (Claude/Cursor `type: "http"`, Codex `url`, Grok `url` plus
 * `transport = "http"`).
 *
 * `envKeys` names the environment variables a stdio server needs, never their values.
 * The rendered config carries `${KEY}` and the CLI expands it from the environment
 * the driver inherits (verified on claude 2.1.224, both as a file and inline), so a
 * secret never reaches the database, an argv, or a log line. `httpHeaders` applies
 * the same rule to HTTP: each header stores only the environment-variable name whose
 * value the provider must send.
 *
 * `tools` and `schemaChars` come from probing the server once at registration.
 * They exist so the persona form can price an attachment without spending a model
 * token: measured, an eagerly loaded server costs about 0,42 tokens per character of
 * schemas plus instructions, per persona, per turn.
 */
const hasMcpCommand = (row: { command: string; url?: string }): boolean => row.command.trim().length > 0
const hasMcpUrl = (row: { command: string; url?: string }): boolean => (row.url ?? '').trim().length > 0
const xorMcpTransport = (row: { command: string; url?: string }): boolean => hasMcpCommand(row) !== hasMcpUrl(row)
const MCP_TRANSPORT_XOR =
  'A server needs a command to start, or a URL for an HTTP server, not both.'

export const McpHttpHeaderSchema = z.object({
  name: z.string(),
  envKey: z.string(),
})
export type McpHttpHeader = z.infer<typeof McpHttpHeaderSchema>

/** Whether write-capable calls from one connector pause for durable user approval. */
export const McpEffectPolicySchema = z.enum(['confirm_writes', 'trusted'])
export type McpEffectPolicy = z.infer<typeof McpEffectPolicySchema>

const McpServerFieldsSchema = z.object({
  id: z.string(),
  /** Also the `mcp__<name>__` tool prefix, so it must survive as an identifier. */
  name: z.string(),
  command: z.string().default(''),
  args: z.array(z.string()).default([]),
  envKeys: z.array(z.string()).default([]),
  /** HTTP header name to host environment-variable name. Values never persist. */
  httpHeaders: z.array(McpHttpHeaderSchema).optional(),
  /**
   * Streamable HTTP endpoint. When set, Manor does not start a process and `command`
   * is empty. Absent or empty means stdio.
   */
  url: z.string().optional(),
  /** One line for the registry list; what this server is for. */
  description: z.string().default(''),
  /**
   * Whether this server can change things. Drives the UI warning and the default
   * exclusion list on a fresh attachment. Deliberately NOT wired to the Codex
   * sandbox flag: that flag governs shell commands and cannot reach an MCP process,
   * so letting it depend on this would buy a feeling of safety and no safety.
   */
  writes: z.boolean().default(false),
  /**
   * Trust is chosen per connector. Unknown and newly registered connectors take the
   * guarded default; `trusted` is the explicit exception for internal systems whose
   * writes are ordinary work rather than an outward act on the user's behalf.
   */
  effectPolicy: McpEffectPolicySchema.default('confirm_writes'),
  /** Tool names as the server reports them, without the `mcp__<name>__` prefix. */
  tools: z.array(z.string()).default([]),
  /**
   * Tools classified read-only by Manor's exact, code-owned connector policy.
   * Upstream annotations never grant trust; anything absent is write-capable.
   */
  readOnlyTools: z.array(z.string()).default([]),
  /** Wire size of the tool schemas plus the server's `instructions` block. */
  schemaChars: z.number().default(0),
  /** Host-local refusal reason. Keeps the row visible without attaching it to turns. */
  unavailable: z.string().optional(),
  /**
   * Composio toolkits this host currently has connected, with their aliases.
   * Filled at reconcile, never a form field, preserved across registry reloads
   * the same way `unavailable` is.
   */
  connectedApps: z.array(ComposioConnectedAppSchema).optional(),
})

export const McpServerConfigSchema = McpServerFieldsSchema.refine(xorMcpTransport, { message: MCP_TRANSPORT_XOR })
export type McpServerConfig = z.infer<typeof McpServerConfigSchema>

/** Present when this row is an HTTP endpoint rather than a spawned process. */
export function mcpHttpUrl(server: { url?: string }): string | undefined {
  const value = server.url?.trim() ?? ''
  return value.length === 0 ? undefined : value
}

/**
 * Checks an HTTP MCP URL before it is stored. The message is shown verbatim, so it
 * says what to do. Credentials in the URL are refused because they would land in the
 * database, the same leak `envKeys` exists to prevent.
 */
export function parseHttpMcpUrl(
  value: string,
): { ok: true; url: string } | { ok: false; message: string } {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    return { ok: false, message: 'An HTTP server needs a URL.' }
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, message: 'That is not a URL Manor can open.' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, message: 'Manor only speaks http or https MCP endpoints.' }
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return {
      ok: false,
      message:
        'Do not put credentials in the URL. Name an environment key instead; Manor never stores values.',
    }
  }
  return { ok: true, url: trimmed }
}

/** A registry entry on its way in. No id yet when it is being created. */
export const McpServerDraftSchema = McpServerFieldsSchema.omit({
  id: true,
  tools: true,
  readOnlyTools: true,
  schemaChars: true,
  unavailable: true,
  connectedApps: true,
})
  .extend({ id: z.string().optional() })
  .refine(xorMcpTransport, { message: MCP_TRANSPORT_XOR })
export type McpServerDraft = z.infer<typeof McpServerDraftSchema>

/** What this Manor host knows about one registry entry right now. Never persisted. */
export const McpHostStatusSchema = z.object({
  serverId: z.string(),
  env: z.array(z.object({ key: z.string(), present: z.boolean() })),
  check: z
    .object({
      checkedAt: z.string(),
      result: z.enum(['verified', 'server_only', 'failed']),
      /** Present only when a real, side-effect-free tool call proved the credential. */
      tool: z.string().optional(),
    })
    .nullable(),
})
export type McpHostStatus = z.infer<typeof McpHostStatusSchema>

/**
 * One server attached to one persona. `disabledTools` holds bare tool names; the
 * driver adds the `mcp__<server>__` prefix. Excluding every tool is not the same as
 * detaching: an attached server still costs its `instructions` block, so the UI
 * should offer detachment rather than a full exclusion list.
 */
export const McpAttachmentSchema = z.object({
  serverId: z.string(),
  disabledTools: z.array(z.string()).default([]),
})
export type McpAttachment = z.infer<typeof McpAttachmentSchema>

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/** The local provider folder an import candidate was found in. */
export const SkillSourceSchema = z.enum(['claude', 'codex'])
export type SkillSource = z.infer<typeof SkillSourceSchema>

/** Slugs are typed after `$`, so they use one whitespace-free identifier shape. */
export const SkillIdSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/)

/** One imported, provider-neutral skill in Manor's household registry. */
export const SkillConfigSchema = z.object({
  id: SkillIdSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(500).default(''),
  instructions: z.string().min(1).max(150_000),
  sources: z.array(SkillSourceSchema).min(1),
  /** Content address of the complete owned folder in private Storage. */
  bundleRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  /** Includes SKILL.md. Zero means a pre-bundle registry row. */
  fileCount: z.number().int().nonnegative().optional(),
  bundleBytes: z.number().int().nonnegative().optional(),
  /** Host-local invocation telemetry when available. Never persisted. */
  usageCount: z.number().int().nonnegative().optional(),
  lastUsedAt: z.string().datetime({ offset: true }).optional(),
})
export type SkillConfig = z.infer<typeof SkillConfigSchema>

/**
 * A local SKILL.md Manor can copy into its registry. The opaque candidate id is
 * resolved server side, so the browser never sends an arbitrary filesystem path.
 */
export const SkillCandidateSchema = z.object({
  candidateId: z.string(),
  slug: SkillIdSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(500).default(''),
  sources: z.array(SkillSourceSchema).min(1),
  /** True when the imported bundle contains more than SKILL.md. */
  hasSupportingFiles: z.boolean().default(false),
  fileCount: z.number().int().positive().optional(),
  bundleBytes: z.number().int().nonnegative().optional(),
})
export type SkillCandidate = z.infer<typeof SkillCandidateSchema>

/** One workflow the memory folder tracks before it becomes a permanent capability. */
export const WorkflowSuggestionStatusSchema = z.enum([
  'watching',
  'ready',
  'proposed',
  'building',
  'shipped',
  'dismissed',
  'existing-skill',
])
export type WorkflowSuggestionStatus = z.infer<typeof WorkflowSuggestionStatusSchema>

export const WorkflowSuggestionSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(240),
  description: z.string().max(12_000),
  occurrences: z.string().max(12_000),
  corrections: z.string().max(12_000),
  existingCoverage: z.string().max(12_000),
  status: WorkflowSuggestionStatusSchema,
  statusDetail: z.string().max(2_000),
})
export type WorkflowSuggestion = z.infer<typeof WorkflowSuggestionSchema>

/**
 * Every persona's built-in tools since tool groups went (2026-11-13). The Claude Code
 * set, each name read off the installed CLI because one it does not resolve is
 * silently dropped. Grok maps the names to its own built-ins; Codex and Cursor cannot
 * pick per tool, and a non-empty list puts them in their acting mode. Connections stay
 * per persona, and the effect broker still asks before an outside write.
 */
export const PERSONA_TOOLS: readonly string[] = [
  'Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep',
  'Bash',
  'WebSearch', 'WebFetch',
  'Agent', 'Skill', 'SendMessage', 'Monitor', 'ToolSearch',
  'TaskCreate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskUpdate', 'TaskStop',
  'CronCreate', 'CronList', 'CronDelete', 'ScheduleWakeup', 'PushNotification', 'RemoteTrigger',
  'Artifact', 'Workflow', 'ReportFindings', 'DesignSync', 'EnterWorktree', 'ExitWorktree',
]

export const AgentConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  // Hex color used by the UI to label this persona's messages.
  color: z.string(),
  // Full system prompt. On the Claude driver this REPLACES the harness prompt.
  character: z.string(),
  driver: DriverSchema,
  // Model id passed to the driver; driver default when omitted.
  model: z.string().optional(),
  // Always set: a persona with no effort chosen is a state nobody wants, so the
  // default lands here rather than being left to whatever the CLI does today.
  effort: EffortSchema.default('high'),
  /** Default speed for this persona; absent means Standard. */
  speed: z.literal('fast').optional(),
  // Built-in tool names the turn may use. Empty array = no built-ins, which only
  // Manor's own side calls (titles, summaries, routing) still use: every persona holds
  // `PERSONA_TOOLS`, set by the server, never by a draft. This field governs BUILT-INS
  // ONLY: `--tools ""` was measured not to gate MCP at all (a persona with an empty
  // toolset executed mcp__filesystem__write_file), so MCP has its own field below.
  allowedTools: z.array(z.string()),
  // MCP servers attached to this persona. Empty = no MCP. Attachment is the whole
  // access decision: a server absent from this list is absent from the rendered
  // config, which is the only state that costs nothing and grants nothing.
  mcpServers: z.array(McpAttachmentSchema).default([]),
  // Imported Manor skills this persona may invoke. The skill body is injected only
  // when a user selects it with `$`; attachment alone adds no prompt cost.
  skillIds: z.array(SkillIdSchema).optional(),
  // The per-persona memory toggle: on, this persona's turns get memory injected and may write to it.
  memoryScope: z.boolean().default(false),
  // One line for the CoS roster and the UI; what this persona is for. The only one
  // of the two labels that reaches a model, so it stays a full sentence.
  description: z.string().default(''),
  // Job title, one to three words. Purely for a human scanning a list of personas,
  // which is why it is separate from description rather than a shortening of it:
  // "Engineer" tells the chief of staff far less than the sentence does. Empty is
  // normal and renders as nothing.
  role: z.string().default(''),
  // The chief of staff: receives un-mentioned messages. At most one agent holds
  // this. It answers them itself; free delegation by @mention went out on
  // 2026-08-13, so it summons through `mentionAllowlist` like any persona.
  isCos: z.boolean().default(false),
  // Agent ids this persona's own replies may summon by @mention (decided
  // 2026-08-11 so Smith can tag Argus for review; since 2026-08-13 the only
  // summon path there is, the chief of staff's included). First summons share
  // the per-message delegation budget. A summoned persona that already had a
  // turn this message is not run again, except along the summoner↔summoned
  // edge for at most three review hops (2026-08-17, cap 3 on 2026-09-20). Absent or empty means this
  // persona's mentions do nothing.
  mentionAllowlist: z.array(z.string()).optional(),
  // A small square portrait as a `data:image/...;base64,` URI, or absent. Stored on
  // the row rather than in a bucket or on disk: the roster is one short list for one
  // user, so a bucket with its policies and signed URLs is machinery without a second
  // consumer, and a file on the server's disk would not survive a VPS rebuild. The
  // client shrinks the picture before sending and the server caps what it accepts, so
  // this stays kilobytes and can ride along in the roster.
  avatar: z.string().optional(),
  // Which silhouette her generated face is built on, as the blobatar shape name
  // ("round", "sun", …), or absent to let her own name pick one. A plain string
  // rather than an enum: the set belongs to the avatar library the client draws
  // with, and a server that validated it would have to be redeployed to add a
  // shape. An id no client knows falls back to the seeded shape, which is the
  // same thing absent does.
  avatarShape: z.string().optional(),
  // Position in the avatar library's tone range; absent keeps the deep (0.7) swatch.
  avatarTone: z.number().min(0).max(1).optional(),
  // Absent only on pre-migration rosters. New personas default to chat in the store.
  placement: z.enum(['chat', 'session']).optional(),
  // Lifted to the top of the chat list, desktop and phone, instead of taking a place
  // in its recency order. At most CHAT_LIST_PIN_LIMIT there; absent reads as not pinned.
  pinned: z.boolean().optional(),
  // A face in the desktop rail under the destinations, one click from her DM.
  // Independent of `pinned`. Absent reads as not pinned.
  railPinned: z.boolean().optional(),
})
export type AgentConfig = z.infer<typeof AgentConfigSchema>

/**
 * The usable context window of one model, in tokens, and the provider fallback for
 * a model this table has never heard of (an unpinned default, or one saved before
 * the registry knew it). Read off the installed CLIs rather than remembered.
 *
 * Here rather than in the web app because the server measures against it too: the
 * note a routine posts when its thread crosses two thirds of the window is decided
 * where the run finishes, and a second copy of these numbers would be a second thing
 * to keep in agreement. Every reader marks the result as an estimate.
 */
const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  'claude-fable-5-1': 1_000_000,
  'claude-fable-5-2': 1_000_000,
  'claude-opus-5': 1_000_000,
  'claude-opus-5-5': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-sonnet-5-5': 1_000_000,
  'claude-haiku-5-5': 1_000_000,
  'gpt-5.6-luna': 258_000,
  'gpt-6-astra': 258_000,
  // Codex's own catalogue (`codex debug models`): 95% of the raw window is usable,
  // so 272k models give 258k and GPT 6.1 Sol's 500k gives 475k, as its rollouts report.
  'gpt-6.1-sol': 475_000,
  'gpt-6.1-terra': 475_000,
  'gpt-6-sol': 258_000,
  'gpt-6-luna': 258_000,
  'gpt-5.6-terra': 258_000,
  'gpt-5.6-sol': 258_000,
  'grok-4.5': 500_000,
  'grok-4.6': 500_000,
  'grok-4.7': 500_000,
  'cursor-grok-4.6': 256_000,
  // Cursor's docs/models pages and `cursor-agent models` labels, for the ids Manor
  // sends. Grok 4.7 runs 256k by default but bills up to 500k as long context on
  // usage plans (Plus alone is held at 256k); Kimi K3 and Gemini 3.8 Flash reach 1M
  // only as Max context, which the ids Manor sends are not.
  'cursor-grok-4.7': 500_000,
  'cursor-composer-2.5': 200_000,
  'cursor-claude-opus-5': 1_000_000,
  'cursor-claude-opus-5-5': 1_000_000,
  'cursor-claude-sonnet-5-5': 200_000,
  'cursor-gpt-5.6-luna': 1_000_000,
  'cursor-gpt-5.6-sol': 1_000_000,
  'cursor-claude-fable-5-1': 1_000_000,
  'cursor-claude-fable-5-2': 1_000_000,
  'cursor-gemini-3.8-flash': 200_000,
  'cursor-kimi-k3': 200_000,
  'cursor-glm-5.2': 200_000,
  'cursor-muse-spark-1.3': 1_000_000,
  // 300k standard; 1M only in Max Mode, which the ids Manor sends are not.
  'cursor-muse-wonder-1.0': 300_000,
}

/**
 * Which CLI answers for a model id. Same list as the windows above, keyed the same
 * way, because both are read off the installed CLIs and a model that gains one gains
 * the other. Its reader is the side chat, which is a model and an effort rather than
 * a persona: nothing there picks a provider, so the provider is derived from the pick
 * that was made.
 */
const MODEL_DRIVERS: Record<string, DriverName> = {
  'claude-fable-5-1': 'claude',
  'claude-fable-5-2': 'claude',
  'claude-opus-5': 'claude',
  'claude-opus-5-5': 'claude',
  'claude-sonnet-5': 'claude',
  'claude-sonnet-5-5': 'claude',
  'claude-haiku-5-5': 'claude',
  'gpt-5.6-luna': 'codex',
  'gpt-6-astra': 'codex',
  'gpt-6.1-sol': 'codex',
  'gpt-6.1-terra': 'codex',
  'gpt-6-sol': 'codex',
  'gpt-6-luna': 'codex',
  'gpt-5.6-terra': 'codex',
  'gpt-5.6-sol': 'codex',
  'grok-4.5': 'grok',
  'grok-4.6': 'grok',
  'grok-4.7': 'grok',
  'cursor-grok-4.6': 'cursor',
  'cursor-grok-4.7': 'cursor',
  'cursor-composer-2.5': 'cursor',
  'cursor-claude-opus-5': 'cursor',
  'cursor-claude-opus-5-5': 'cursor',
  'cursor-claude-sonnet-5-5': 'cursor',
  'cursor-gpt-5.6-luna': 'cursor',
  'cursor-gpt-5.6-sol': 'cursor',
  'cursor-claude-fable-5-1': 'cursor',
  'cursor-claude-fable-5-2': 'cursor',
  'cursor-gemini-3.8-flash': 'cursor',
  'cursor-kimi-k3': 'cursor',
  'cursor-glm-5.2': 'cursor',
  'cursor-muse-spark-1.3': 'cursor',
  'cursor-muse-wonder-1.0': 'cursor',
}

/** The provider for a model id, or nothing for one no installed CLI offers. */
export const driverForModel = (model: string): DriverName | undefined => MODEL_DRIVERS[model]

/** Every model the house can name, for a picker that is not keyed by persona. */
export const KNOWN_MODELS: readonly string[] = Object.keys(MODEL_DRIVERS)

const DEFAULT_CONTEXT_WINDOWS: Record<AgentConfig['driver'], number> = {
  claude: 1_000_000,
  codex: 258_000,
  grok: 500_000,
  cursor: 200_000,
  mock: 1_000_000,
}

export const contextWindowFor = (driver: AgentConfig['driver'], model: string | undefined): number =>
  MODEL_CONTEXT_WINDOWS[model ?? ''] ?? DEFAULT_CONTEXT_WINDOWS[driver]

/**
 * Share of the session's reported window at which Single Work asks the live
 * driver to compact. The reported window is `turn_result.contextWindow` when the
 * CLI named one, otherwise `contextWindowFor`. Stays below Codex (~0.95)
 * auto-compact. Rollover rooms use `SESSION_CONTEXT_FRACTION` in the server
 * composer (0.7).
 *
 * This no longer governs Claude. The Claude driver passes `--autocompact`
 * (`AUTOCOMPACT_TOKENS`), which bounds a session far below 0.9 of its 1M window,
 * and the CLI never reports a `contextWindow`, so a Claude session cannot reach
 * this threshold and the CLI compacts first. Claude therefore posts no
 * `LIVE_COMPACT_DONE`.
 *
 * The client dial is a separate reading: `readContextMeter` divides by the measured
 * compaction threshold where one exists, so this fraction still colours a Claude
 * ring, against 300k rather than 1m. That is visual only; it asks for no compact.
 */
export const LIVE_COMPACT_CONTEXT_FRACTION = 0.9

/** Fast variants verified in the installed subscription-authenticated CLIs. */
const CURSOR_FAST_MODELS = new Set([
  'cursor-grok-4.6',
  'cursor-grok-4.7',
  'cursor-composer-2.5',
  'cursor-claude-opus-5',
  'cursor-claude-opus-5-5',
  'cursor-gpt-5.6-luna',
  'cursor-gpt-5.6-sol',
])

/** Fast is protocol-shaped on Codex and model-shaped on Cursor. */
export function supportsFastMode(driver: DriverName, model: string | undefined): boolean {
  if (driver === 'codex') return true
  return driver === 'cursor' && model !== undefined && CURSOR_FAST_MODELS.has(model)
}

/**
 * One Auto mode task category: what the classifier matches on, and the complete
 * runtime it pins. Owned by `apps/server/auto-runtime.json` and edited from the
 * composer's Auto settings dialog, so server and web validate with this one schema.
 * `mock` is never a destination and `speed` only exists where the CLI has a fast mode.
 */
export const AutoRuleSchema = z.object({
  description: z.string().trim().min(1, 'a rule needs a description'),
  driver: DriverSchema,
  model: z.string().min(1),
  effort: EffortSchema,
  speed: z.literal('fast').optional(),
}).strict().superRefine(({ driver, model, effort, speed }, context) => {
  const issue = (message: string, path: string) =>
    context.addIssue({ code: z.ZodIssueCode.custom, message, path: [path] })
  if (driver === 'mock') return issue('mock is not a runtime Auto can pick', 'driver')
  if (!MODELS[driver].some((option) => option.value === model)) return issue(`${model} is not a ${driver} model`, 'model')
  if (!effortsFor(driver, model).some((option) => option.value === effort)) issue(`${model} does not support ${effort} effort`, 'effort')
  if (speed !== undefined && !supportsFastMode(driver, model)) issue(`${model} has no fast mode`, 'speed')
})
export type AutoRule = z.infer<typeof AutoRuleSchema>

/** Reserved by the classifier for "no category fits"; never a rule key. */
export const AUTO_RULE_DEFER_KEY = 'defer'
export const AutoRuleKeySchema = z.string()
  .regex(/^[a-z][a-z0-9-]*$/, 'a key is lowercase letters, digits and dashes, starting with a letter')
  .refine((key) => key !== AUTO_RULE_DEFER_KEY, `${AUTO_RULE_DEFER_KEY} is reserved for the classifier`)

/** The whole rule file. At least one rule, or Auto has nothing to choose from. */
export const AutoRulesSchema = z.record(AutoRuleKeySchema, AutoRuleSchema)
  .refine((rules) => Object.keys(rules).length > 0, 'Auto needs at least one rule')
export type AutoRules = z.infer<typeof AutoRulesSchema>

/**
 * What a save carries on the wire. Deliberately looser than `AutoRulesSchema`: a
 * frame that fails the wire schema is dropped without a reply, and a rule whose
 * model does not fit its driver deserves the reason back, so the service does that
 * check and answers with a notice.
 */
export const AutoRulesDraftSchema = z.record(z.string(), z.object({
  description: z.string(),
  driver: z.string(),
  model: z.string(),
  effort: z.string(),
  speed: z.literal('fast').optional(),
}))
export type AutoRulesDraft = z.infer<typeof AutoRulesDraftSchema>

/** An agent on its way in. No id yet when it is being created. Its built-in tools are the server's to set. */
export const AgentDraftSchema = AgentConfigSchema.omit({ id: true, allowedTools: true }).extend({
  id: z.string().optional(),
})
export type AgentDraft = z.infer<typeof AgentDraftSchema>

export { addsAgentMention, hasBrowserMention, hasComputerMention, mentionSpans, parseMentions, type MentionSpan } from './mentions.js'

/**
 * A per-chat, per-agent runtime override, chosen from the composer. It lives for
 * the chat it was set in and never touches the roster: the Agents section stays
 * the default every new chat starts from. An absent field means "the agent's own
 * configured value"; an empty object clears the override entirely, which is how
 * picking the default back removes it.
 */
export const ChatOverrideSchema = z.object({
  /**
   * The provider this chat runs the persona on. A pinned provider makes the roster's
   * model id meaningless (it belongs to the other CLI), so the merge below drops it
   * rather than carrying it across: a provider pinned on its own runs that provider's
   * own default model, and `model` here is the only thing that overrides it.
   */
  driver: DriverSchema.optional(),
  model: z.string().optional(),
  effort: EffortSchema.optional(),
  // Absence follows the persona until Auto snapshots it. Standard overrides a Fast default.
  speed: z.enum(['standard', 'fast']).optional(),
  /**
   * Model/effort selection before this persona's first turn.
   *
   * Absent means on: Auto is what a chat does unless it was switched off, so `false`
   * is a real stored value rather than an absence, and it is the only thing that
   * opts one chat out. `true` is still written by the switch itself, and stays the
   * value the rooms that refuse Auto (side, pair, run, single) check for.
   */
  auto: z.boolean().optional(),
  /** Durable once-only marker, retained when a manual pick disables Auto. */
  autoResolved: z.literal(true).optional(),
})
export type ChatOverride = z.infer<typeof ChatOverrideSchema>

/** Resolve speed once for clients and the runner, including unsupported model switches. */
export function effectiveSpeed(agent: AgentConfig, override: ChatOverride = {}): 'fast' | undefined {
  const driver = override.driver ?? agent.driver
  const model = override.model ?? (driver === agent.driver ? agent.model : undefined) ?? defaultModel(driver)
  const speed = override.speed ?? (override.autoResolved ? undefined : agent.speed)
  return speed === 'fast' && supportsFastMode(driver, model) ? 'fast' : undefined
}

/**
 * What this override says about Auto, with `undefined` for "nobody has said". The two
 * sides fill that gap differently, the composer shows the switch on and the server
 * also wants a selector and a real driver, so the default belongs to the caller
 * rather than in here.
 *
 * A runtime picked by hand answers no. The pick is what turns Auto off, which is why
 * only the switch itself ever writes `false`, and why a pin stored before Auto had a
 * default is not re-decided under whoever made it.
 */
export const autoRequested = (override: ChatOverride | undefined): boolean | undefined =>
  override?.auto ??
  (override?.driver !== undefined ||
  override?.model !== undefined ||
  override?.effort !== undefined ||
  override?.speed !== undefined
    ? false
    : undefined)

/** A single session uses the existing pin store under a non-persona speaker id. */
export const SINGLE_CHAT_VOICE = { id: '__single__', name: 'Assistant' } as const
export const SINGLE_DRIVERS = ['claude', 'codex', 'grok', 'cursor'] as const
export const SingleRuntimeSchema = ChatOverrideSchema.extend({
  driver: z.enum(SINGLE_DRIVERS),
  model: z.string().min(1),
  effort: EffortSchema,
})
export type SingleRuntime = z.infer<typeof SingleRuntimeSchema>
/** The manual runtime shown when composing a new Single chat. */
export const NEW_SINGLE_CHAT_DEFAULT = { driver: 'claude', model: 'claude-opus-5-5', effort: 'high' } as const satisfies SingleRuntime
export const isSingleDriver = (driver: AgentConfig['driver']): driver is SingleRuntime['driver'] =>
  SINGLE_DRIVERS.some((candidate) => candidate === driver)

/** Starts a bare session on the house default where that provider supports it. */
export function defaultSingleRuntime(agents: readonly AgentConfig[]): SingleRuntime {
  const supported = agents.filter((agent): agent is AgentConfig & { driver: SingleRuntime['driver'] } =>
    isSingleDriver(agent.driver),
  )
  const preferred = supported.find((agent) => agent.isCos) ?? supported[0]
  const driver = preferred?.driver ?? 'claude'
  return {
    driver,
    model: preferred?.model ?? defaultModel(driver)!,
    effort: preferred?.effort ?? 'high',
    ...(preferred === undefined || effectiveSpeed(preferred) === undefined ? {} : { speed: 'fast' as const }),
  }
}
/**
 * The Single runtime a Work card opens on when its author proposed none: the chief of
 * staff's provider, but on Claude the house Opus default rather than the CoS persona's
 * model. A project thread may propose its own per card (2026-10-11).
 */
export function workSingleDefault(agents: readonly AgentConfig[]): SingleRuntime {
  const runtime = defaultSingleRuntime(agents)
  return runtime.driver === NEW_SINGLE_CHAT_DEFAULT.driver ? { ...NEW_SINGLE_CHAT_DEFAULT } : runtime
}
export const ChatModeSchema = z.enum(['house', 'single'])
export type ChatMode = z.infer<typeof ChatModeSchema>

// ---------------------------------------------------------------------------
// Usage accounting from CLI result events
// ---------------------------------------------------------------------------

/**
 * Anthropic's prices for cached prompt tokens, as ratios against fresh input.
 * These are what make `inputTokens` the wrong number to read as API-priced input:
 * the bulk of a long chat's input arrives as cache reads at a tenth of the price.
 *
 * Checked against the CLI's own `total_cost_usd` on 2026-08-13. A haiku turn
 * reporting 10 fresh, 19_935 one-hour-write and 18_101 read tokens weights to
 * 41_690 input-equivalents; at haiku's $1/MTok input and $5/MTok output that
 * predicts $0.04202 against a reported $0.0420101. Re-run that check before
 * trusting these numbers after a provider price change.
 */
export const CLAUDE_CACHE_PRICE_WEIGHTS = { fresh: 1, write5m: 1.25, write1h: 2, read: 0.1 } as const

/**
 * The parts behind `inputTokens`, kept apart because they cost different amounts.
 *
 * Absent unless the provider reported the split itself. The CLI gives the cache
 * write its duration in `usage.cache_creation`, and without that field a write
 * cannot be priced at all — a 5-minute and a 1-hour write differ by 60%. Same
 * rule as `contextTokens` on the turn result: a driver that cannot report this
 * reports nothing, rather than a plausible guess the user would then act on.
 */
const UsageBreakdownFieldsSchema = z.object({
  /** Prompt tokens that hit neither half of the cache, billed at full price. */
  freshInputTokens: z.number(),
  cacheWrite5mTokens: z.number(),
  cacheWrite1hTokens: z.number(),
  cacheReadTokens: z.number(),
  /**
   * The four fields above priced against fresh input via
   * `CLAUDE_CACHE_PRICE_WEIGHTS`. This reproduces the input half of Claude's API
   * price, not how a Max subscription consumes quota. On the 2026-08-13
   * multi-persona chat this proxy and raw input read 493k and 1.89M for the same work.
   */
  apiPricedInputEquivalent: z.number(),
})

/**
 * `weightedInputTokens` was written briefly while this field was first measured on
 * the live Manor database. Accept it as an input alias so one experimental durable
 * event cannot make its whole transcript fail validation after the honest rename.
 */
export const UsageBreakdownSchema = z.preprocess((raw) => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw
  const record = raw as Record<string, unknown>
  if (record['apiPricedInputEquivalent'] !== undefined || typeof record['weightedInputTokens'] !== 'number') {
    return raw
  }
  return { ...record, apiPricedInputEquivalent: record['weightedInputTokens'] }
}, UsageBreakdownFieldsSchema)
export type UsageBreakdown = z.infer<typeof UsageBreakdownSchema>

/** Claude API-priced input equivalent of one breakdown. It is not subscription usage. */
export function apiPricedInputEquivalent(
  parts: Omit<UsageBreakdown, 'apiPricedInputEquivalent'>,
): number {
  return Math.round(
    parts.freshInputTokens * CLAUDE_CACHE_PRICE_WEIGHTS.fresh +
      parts.cacheWrite5mTokens * CLAUDE_CACHE_PRICE_WEIGHTS.write5m +
      parts.cacheWrite1hTokens * CLAUDE_CACHE_PRICE_WEIGHTS.write1h +
      parts.cacheReadTokens * CLAUDE_CACHE_PRICE_WEIGHTS.read,
  )
}

/**
 * What one turn cost, summed over every request the CLI made to serve it.
 *
 * `inputTokens` is therefore NOT how full the context window is: a turn with ten
 * tool calls re-sends the whole prompt eleven times and reports the sum, which on
 * a measured three-tool turn was 132k against a real context of 33k. It is also
 * NOT the subscription bill: it adds cache reads at face value when they cost a
 * tenth of that. It is one thing only, how much text the provider processed for
 * this turn. Read `breakdown.apiPricedInputEquivalent` only as a Claude API pricing
 * proxy and `contextTokens` on the turn result for the gauge. Only provider usage
 * can say how much subscription quota remains.
 */
export const UsageSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number().optional(),
  breakdown: UsageBreakdownSchema.optional(),
})
export type Usage = z.infer<typeof UsageSchema>

// ---------------------------------------------------------------------------
// Provider usage — how much of a SUBSCRIPTION is spent, house-wide.
//
// Deliberately not called `usage`: that word already means per-turn token totals
// above (`UsageSchema`, the `usage` server message, `usageFrom` on the client).
// This is the other thing entirely, and the two must never be summed, compared,
// or rendered as one number. It also counts work done outside Manor, which is
// exactly why it can only ever be the provider's own figure and never ours.
// ---------------------------------------------------------------------------

/** An actual account reading; never a reconstructed zero or a forecast. */
export const UsageSampleSchema = z.object({
  at: z.number().finite(),
  usedPercent: z.number().finite().nonnegative(),
})
export type UsageSample = z.infer<typeof UsageSampleSchema>

/** One limit window, with optional observations collected by Manor. */
export const UsageWindowSchema = z.object({
  /**
   * What this window is, in the provider's own vocabulary, built by the driver.
   * Carried rather than derived because duration does not identify a window:
   * Claude reports an all-models weekly limit and a per-model weekly limit that
   * are both 10080 minutes and differ only in scope.
   */
  label: z.string(),
  /** The provider's own number, 0..100. Never estimated, never back-filled. */
  usedPercent: z.number(),
  /** Epoch ms. Absent when the provider states no reset moment. */
  resetsAt: z.number().optional(),
  /** Exact period start when the provider gives one. Epoch ms. */
  startsAt: z.number().optional(),
  /** Window length reported by the provider or defined by its named window kind. */
  minutes: z.number().optional(),
  /** The provider's own alarm level, so the heat threshold is not invented here. */
  severity: z.enum(['normal', 'warning', 'critical']).optional(),
  /** The window currently binding this account, when the provider says which. */
  binding: z.boolean().optional(),
  /** Current-period observations only. Absent when collection failed or is unsupported. */
  history: z.array(UsageSampleSchema).optional(),
})
export type UsageWindow = z.infer<typeof UsageWindowSchema>

export const ProviderUsageSchema = z.object({
  provider: z.enum(['claude', 'codex', 'grok', 'cursor']),
  /** `unavailable` is a real answer and the only alternative to a real number. */
  status: z.enum(['ok', 'unavailable']),
  /** The provider's own plan label, verbatim ("max", "plus"). */
  plan: z.string().optional(),
  /** Epoch ms on the server clock, so the client can say how old this reading is. */
  fetchedAt: z.number(),
  /** Empty when unavailable. The panel renders these and only these. */
  windows: z.array(UsageWindowSchema),
})
export type ProviderUsage = z.infer<typeof ProviderUsageSchema>

/**
 * One provider CLI that is behind its newest release, or is being brought up to it.
 * A provider that is current, or whose newest release Manor cannot know (Cursor
 * updates itself and publishes no version feed), has no entry at all.
 */
export const ProviderUpdateSchema = z.object({
  provider: z.enum(['claude', 'codex', 'grok', 'cursor']),
  /** Empty while Manor installs a runtime it had none of, such as Codex on a fresh start. */
  currentVersion: z.string(),
  latestVersion: z.string(),
  /**
   * False when Manor may not run this provider's updater, such as a one-off Codex
   * binary set through `MANOR_CODEX_COMMAND`. The row then offers no button.
   */
  canUpdate: z.boolean(),
  state: z.enum(['available', 'updating', 'updated', 'failed']),
  /** Short updater reason, only on `failed`. */
  error: z.string().optional(),
})
export type ProviderUpdate = z.infer<typeof ProviderUpdateSchema>

/** What a driver's update probe reports. Null from the probe means "cannot know". */
/**
 * How one provider CLI stands on this Mac, as the settings and the first-run screen
 * show it. The server derives `state`, so every client draws the same row.
 */
export const ProviderConnectionSchema = z.object({
  provider: z.enum(['claude', 'codex', 'grok', 'cursor']),
  installed: z.boolean(),
  version: z.string().nullable(),
  /** Null when the CLI could not say, which is not the same as signed out. */
  signedIn: z.boolean().nullable(),
  /** The account the CLI names, verbatim. */
  account: z.string().optional(),
  /** The provider's own plan or login label, verbatim ("max", "ChatGPT"). */
  plan: z.string().optional(),
  state: z.enum(['install', 'installing', 'sign_in', 'signing_in', 'ready', 'attention']),
  /** Plain words for `attention`, or for an install or a sign-in that did not finish. */
  message: z.string().optional(),
  /** False when this provider has no sign-in command Manor can start. */
  canSignIn: z.boolean(),
  /** True when the CLI is missing and Manor can run the provider's own installer for it. */
  canInstall: z.boolean().default(false),
})
export type ProviderConnection = z.infer<typeof ProviderConnectionSchema>

/** What a provider CLI says about its own login. */
export interface ProviderAccount {
  signedIn: boolean | null
  account?: string
  plan?: string
}

/** The provider's own sign-in command. It opens the browser; Manor never sees a credential. */
export interface ProviderSignIn {
  command: string
  args: string[]
  env: Record<string, string | undefined>
}

export interface ProviderVersionCheck {
  currentVersion: string
  latestVersion: string
  canUpdate: boolean
}

// ---------------------------------------------------------------------------
// The usage report — what Manor's own turns processed, and what that would cost.
//
// A third meaning of the word, and the furthest from `ProviderUsage` above. That one
// says how much of a subscription is left and comes from the provider. This one says
// what Manor itself processed and comes from Manor's own transcript, so it can never
// say anything about quota. The two are never summed, compared, or put in one strip.
// ---------------------------------------------------------------------------

/** The providers a usage row can be credited to. `unknown` is a turn that named neither driver nor model. */
export const UsageReportProviderSchema = z.enum(['claude', 'codex', 'grok', 'cursor', 'unknown'])
export type UsageReportProvider = z.infer<typeof UsageReportProviderSchema>

/** The windows the Usage view offers, in days ending today. */
export const USAGE_WINDOW_DAYS = [7, 30, 90] as const
export const UsageWindowDaysSchema = z.union([z.literal(7), z.literal(30), z.literal(90)])
export type UsageWindowDays = z.infer<typeof UsageWindowDaysSchema>

/**
 * One model on one provider on one day, already priced.
 *
 * Every number is a plain sum, so the client merges rows by adding them: totals,
 * per-provider shares, the daily chart and the model table all come from these.
 */
export const UsageDaySchema = z.object({
  /** `YYYY-MM-DD` in the report's time zone. */
  day: z.string(),
  provider: UsageReportProviderSchema,
  /** As the CLI reported it. Null for turns that did not say which model served them. */
  model: z.string().nullable(),
  /** Persona turns that reported usage. */
  responses: z.number(),
  /** Every input token, cache reads at face value. */
  inputTokens: z.number(),
  /** Reasoning included: every provider counts it inside output. */
  outputTokens: z.number(),
  /**
   * Input from turns that reported their cache split. Older turns and drivers that
   * report one input total have none, so cached and uncached shares are "of observed
   * input" rather than of all input.
   */
  observedInputTokens: z.number(),
  cachedInputTokens: z.number(),
  cacheWriteTokens: z.number(),
  uncachedInputTokens: z.number(),
  /**
   * What these tokens would cost at API rates: the provider's own figure where it
   * reports one (the Claude CLI does), else the model's list price. Unpriced turns add
   * nothing here and are counted below instead.
   */
  costUsd: z.number(),
  providerReportedResponses: z.number(),
  modelPricedResponses: z.number(),
  unpricedResponses: z.number(),
  /** Input plus output of the unpriced responses. */
  unpricedTokens: z.number(),
  /** What the cached input would have cost at the uncached rate, minus its cache-read cost. */
  cacheSavingsUsd: z.number(),
})
export type UsageDay = z.infer<typeof UsageDaySchema>

export const UsageReportSchema = z.object({
  windowDays: UsageWindowDaysSchema,
  timeZone: z.string(),
  /** First and last day of the window, inclusive, as `YYYY-MM-DD`. */
  since: z.string(),
  until: z.string(),
  rows: z.array(UsageDaySchema),
  /** Distinct chats with a reported turn in the window, house-wide and per provider. */
  sessions: z.number(),
  /**
   * Where model list prices came from. `unavailable` means only provider-reported
   * cost is counted and every other turn is unpriced; `stale` is a cached table the
   * last refresh could not replace.
   */
  prices: z.enum(['current', 'stale', 'unavailable']),
})
export type UsageReport = z.infer<typeof UsageReportSchema>

// ---------------------------------------------------------------------------
// Thread events — the canonical, durable transcript owned by Manor.
// Streaming deltas are NOT thread events; they exist only on the wire.
// ---------------------------------------------------------------------------

const eventBase = {
  id: z.string(),
  ts: z.number(),
}

// SVG is renderable but not multimodal: browsers load it in `<img>` under a
// secure static mode (no scripts, no external fetches), while the provider CLIs
// only accept raster images. See materialiseImages in apps/server/src/turnContext.ts.
export const ImageAttachmentSchema = z.object({
  name: z.string().min(1).max(160),
  dataUrl: z.string().max(2_000_000).regex(/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/),
})
export type ImageAttachment = z.infer<typeof ImageAttachmentSchema>

/**
 * An image inside a transcript event. The store always holds `dataUrl`. Toward a
 * client the server swaps those bytes for `src`, a signed link to the same picture,
 * plus its pixel size when it could read one, so opening a chat does not carry every
 * picture in it and a picture still loading keeps its place. Clients render
 * `src ?? dataUrl` and never send an event image back as an attachment.
 */
export const EventImageSchema = z.object({
  name: ImageAttachmentSchema.shape.name,
  dataUrl: ImageAttachmentSchema.shape.dataUrl.optional(),
  src: z.string().min(1).max(2_000).optional(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
}).refine((image) => (image.dataUrl === undefined) !== (image.src === undefined), {
  message: 'an event image carries exactly one of dataUrl or src',
})
export type EventImage = z.infer<typeof EventImageSchema>
export const eventImageSource = (image: EventImage): string => image.src ?? image.dataUrl ?? ''

export const MAX_MESSAGE_ATTACHMENTS = 8
export const MAX_TEXT_FILE_BYTES = 200 * 1_024

/** UTF-8 length without a Node-only Buffer, so the same contract runs in both clients. */
function utf8ByteLength(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

/** Text-like MIME types browsers and iOS may report for notes, data and source code. */
const TEXT_FILE_MIME = /^(text\/[a-z0-9!#$&^_.+-]+|application\/(?:[a-z0-9!#$&^_.+-]+\+)?(?:json|xml)|application\/(?:x-)?(?:yaml|toml|javascript))$/i

export const FileAttachmentSchema = z.object({
  name: z.string().min(1).max(160),
  mime: z.string().min(1).max(120).regex(TEXT_FILE_MIME, 'must be a text-like MIME type'),
  content: z.string().refine((value) => utf8ByteLength(value) <= MAX_TEXT_FILE_BYTES, {
    message: `must be at most ${MAX_TEXT_FILE_BYTES} UTF-8 bytes`,
  }),
})
export type FileAttachment = z.infer<typeof FileAttachmentSchema>

export const PDF_MIME = 'application/pdf'
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const DocumentMimeSchema = z.enum([PDF_MIME, DOCX_MIME])
export type DocumentMime = z.infer<typeof DocumentMimeSchema>
/** Eight at this size stay under the WebSocket's 100 MiB frame once base64 grows them by a third. */
export const MAX_DOCUMENT_BYTES = 8 * 1_024 * 1_024
/** Pages a PDF may have before extraction refuses it; bounds `unreadablePages`. */
export const MAX_PDF_PAGES = 10_000

/**
 * A PDF or Word file as a client sends it: the original bytes, base64. The server
 * keeps those bytes and extracts text locally; the persona only ever reads the
 * `EventDocument` that comes out, never this.
 */
export const DocumentUploadSchema = z.object({
  name: z.string().min(1).max(160),
  mime: DocumentMimeSchema,
  data: z.string().min(1).max(Math.ceil(MAX_DOCUMENT_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be base64'),
})
export type DocumentUpload = z.infer<typeof DocumentUploadSchema>

/**
 * How much of a document local text extraction actually covered. `complete` means
 * every page gave text, `partial` names what is missing (pages without a text layer,
 * or text cut at the size cap), `unknown` means text came out but the file holds
 * content extraction cannot judge (embedded images, charts), and `failed` means no
 * usable text at all. None of these is visual understanding.
 */
export const DocumentExtractionSchema = z.object({
  status: z.enum(['complete', 'partial', 'unknown', 'failed']),
  /** PDF only. A Word file has no fixed pages. */
  pageCount: z.number().int().nonnegative().optional(),
  /** One-based PDF pages that gave no usable text: blank, scanned or image-only. */
  unreadablePages: z.array(z.number().int().positive()).max(MAX_PDF_PAGES).optional(),
  /** The text stopped at the size cap; `detail` says where. */
  truncated: z.boolean().optional(),
  /** One plain sentence on why the status is not `complete`. */
  detail: z.string().max(500).optional(),
})
export type DocumentExtraction = z.infer<typeof DocumentExtractionSchema>

/**
 * A document inside a stored user message. The original bytes live beside the
 * transcript, keyed by `id`, so opening a chat never parses megabytes of PDF; toward
 * a client the server adds `src`, a signed link to that original.
 */
export const EventDocumentSchema = z.object({
  id: z.string().min(1).max(120),
  name: DocumentUploadSchema.shape.name,
  mime: DocumentMimeSchema,
  size: z.number().int().nonnegative(),
  extraction: DocumentExtractionSchema,
  /** Extracted text with `[Page n]` markers for a PDF. Capped like a text file. */
  text: z.string().refine((value) => utf8ByteLength(value) <= MAX_TEXT_FILE_BYTES, {
    message: `must be at most ${MAX_TEXT_FILE_BYTES} UTF-8 bytes`,
  }),
  src: z.string().min(1).max(2_000).optional(),
})
export type EventDocument = z.infer<typeof EventDocumentSchema>

const messageAttachmentFields = {
  images: z.array(ImageAttachmentSchema).max(MAX_MESSAGE_ATTACHMENTS).optional(),
  files: z.array(FileAttachmentSchema).max(MAX_MESSAGE_ATTACHMENTS).optional(),
  documents: z.array(DocumentUploadSchema).max(MAX_MESSAGE_ATTACHMENTS).optional(),
}

const hasAtMostMessageAttachments = (value: { images?: readonly unknown[]; files?: readonly unknown[]; documents?: readonly unknown[] }) =>
  (value.images?.length ?? 0) + (value.files?.length ?? 0) + (value.documents?.length ?? 0) <= MAX_MESSAGE_ATTACHMENTS

export const MessageAttachmentsSchema = z.object(messageAttachmentFields).refine(hasAtMostMessageAttachments, {
  message: `images and files may contain at most ${MAX_MESSAGE_ATTACHMENTS} attachments combined`,
})

export const MAX_PAGE_CONTEXT_ATTACHMENTS = 3

/**
 * A deliberate quote from the live in-app browser. It is durable enough to explain
 * a later answer, but deliberately small: this is source material for a turn, not a
 * hidden copy of the page. HTML is never rendered back into Manor.
 */
export const PageContextAttachmentSchema = z.object({
  id: z.string().min(1).max(120),
  kind: z.enum(['text', 'element', 'artifact']),
  url: z.string().max(10_000).refine((value) => {
    try {
      const { protocol } = new URL(value)
      return protocol === 'http:' || protocol === 'https:'
    } catch {
      return false
    }
  }, 'must be an http or https website URL'),
  title: z.string().max(500),
  label: z.string().min(1).max(240),
  text: z.string().max(6_000),
  html: z.string().max(8_000),
  selector: z.string().max(2_000).optional(),
})
export type PageContextAttachment = z.infer<typeof PageContextAttachmentSchema>

/**
 * The one finished answer a user message explicitly responds to. The visible answer
 * is snapshotted with the send so the transcript and every driver keep reading the
 * same target even if the source turn is later compacted out of the verbatim tail.
 */
export const MessageReplySchema = z.object({
  turnId: z.string().min(1).max(120),
  agentId: z.string().min(1).max(120),
  text: z.string().min(1),
})
export type MessageReply = z.infer<typeof MessageReplySchema>

/** Selected visible text from one durable message in this same chat. */
export const MAX_MESSAGE_QUOTE_CHARS = 6_000
export const MessageQuoteSchema = z.object({
  eventId: z.string().min(1).max(120),
  text: z.string().max(MAX_MESSAGE_QUOTE_CHARS).refine((text) => text.trim().length > 0, 'quote must not be blank'),
  /** Absent for the user; resolved from the source event by the server on send. */
  agentId: z.string().min(1).max(120).optional(),
})
export type MessageQuote = z.infer<typeof MessageQuoteSchema>

/**
 * Selected text from a Knowledge note. Own field, not a `MessageQuote`: the
 * orchestrator refuses a quote whose `eventId` is not a chat event, and a vault
 * path is not one.
 */
export const NoteQuoteSchema = z.object({
  path: z.string().min(1).max(1_000),
  text: z.string().max(MAX_MESSAGE_QUOTE_CHARS).refine((text) => text.trim().length > 0, 'quote must not be blank'),
})
export type NoteQuote = z.infer<typeof NoteQuoteSchema>

/** More than a person places by hand, and a bound on what one message can carry. */
export const MAX_MESSAGE_QUOTES = 20

/**
 * One quote placed inside a message: selected words from a chat message, a Knowledge
 * note or a browser page. `[Quote #n]` in the text marks where it sits and names the
 * nth entry, so position needs no field of its own (see `quoteRefs`).
 */
export const InlineQuoteSchema = z.discriminatedUnion('kind', [
  MessageQuoteSchema.extend({ kind: z.literal('message') }),
  NoteQuoteSchema.extend({ kind: z.literal('note') }),
  z.object({ kind: z.literal('page'), context: PageContextAttachmentSchema }),
])
export type InlineQuote = z.infer<typeof InlineQuoteSchema>
export const InlineQuotesSchema = z.array(InlineQuoteSchema).max(MAX_MESSAGE_QUOTES)

/** Longest title a wake row carries; a driver cuts a task's own description to it. */
export const WAKE_TITLE_MAX = 200

/**
 * One piece of background work a wake reports as ended: a `delegate_task` child or a
 * provider's own background task. `toolCallId` is its launch row in the same chat,
 * `taskId` a child's thread.
 */
export const WakeItemSchema = z.object({
  toolCallId: z.string(),
  taskId: z.string().optional(),
  title: z.string().max(WAKE_TITLE_MAX),
  state: z.enum(['done', 'failed', 'stopped']),
  driver: DriverSchema.optional(),
  model: z.string().max(100).optional(),
})
export type WakeItem = z.infer<typeof WakeItemSchema>

/**
 * What the user's Confirm asked the lead to do, beside the request's own text, which stays
 * the model's. Clients draw it as a tasks card instead of that text: `checkout` commits
 * in the shared checkout, `worktree` commits on each branch unmerged, `merge` commits and
 * merges into `mergeInto`, `merge_withheld` commits but holds that merge back.
 */
export const ConfirmRequestSchema = z.object({
  variant: z.enum(['checkout', 'worktree', 'merge', 'merge_withheld']),
  // `source` is the linked folder, so a step finds its repo in the completion even when
  // every repo of the Session shares one branch; requests from before 2026-10-18 lack it.
  worktrees: z.array(z.object({ branch: z.string(), folder: z.string(), source: z.string().max(4_096).optional() })).max(50),
  mergeInto: z.string().optional(),
  // Manor commits this request itself (2026-10-21): no turn answers it, so its steps
  // follow Git alone. Without it the lead's turn commits, as before and on a fallback.
  manor: z.literal(true).optional(),
})
export type ConfirmRequest = z.infer<typeof ConfirmRequestSchema>

const UserMessageEventWireSchema = z.object({
  ...eventBase,
  type: z.literal('user_message'),
  // What the user reads. Empty when the whole message is Manor's instruction to the model.
  text: z.string(),
  // Wording Manor wrote for the model alone, read before `text`. No surface shows it:
  // not the transcript, a preview, a title, a search hit or a notification.
  instruction: z.string().optional(),
  // Agent ids mentioned via @name, in order of appearance.
  mentions: z.array(z.string()),
  // Imported skills selected for this originating message. Optional for transcripts
  // written before skills existed; absence and an empty list mean the same thing.
  skillIds: z.array(SkillIdSchema).optional(),
  images: z.array(EventImageSchema).max(MAX_MESSAGE_ATTACHMENTS).optional(),
  files: messageAttachmentFields.files,
  documents: z.array(EventDocumentSchema).max(MAX_MESSAGE_ATTACHMENTS).optional(),
  pageContexts: z.array(PageContextAttachmentSchema).max(MAX_PAGE_CONTEXT_ATTACHMENTS).optional(),
  replyTo: MessageReplySchema.optional(),
  quotes: InlineQuotesSchema.optional(),
  // Messages from before inline quotes, read only: nothing writes these two any more.
  quote: MessageQuoteSchema.optional(),
  noteQuote: NoteQuoteSchema.optional(),
  // An addition to the same running turn, rather than a new request.
  steersTurnId: z.string().optional(),
  // Session additions can interrupt a still-streaming message. Keep the boundary
  // when its completed text is stored later and the transcript is reopened.
  steerAfter: z.object({ messageId: z.string(), textOffset: z.number().int().nonnegative() }).optional(),
  // The user's message from their project thread, sent on by its `send_to_session`. Still theirs
  // own message here: it routes, runs and recovers like one they typed in this Session.
  forwardedFrom: z.object({ threadChatId: z.string(), eventId: z.string() }).optional(),
  // Set only on the commit request the user's Confirm posts in a Session.
  confirmRequest: ConfirmRequestSchema.optional(),
  // Set only on Manor's message to the lead when its own merge of a confirmed result
  // stopped. It belongs to that confirmation, so it never reopens the result.
  mergeTrouble: z.object({ handoffId: z.string(), kind: z.enum(['conflict', 'hook', 'rebase']) }).optional(),
  /** Durable acceptance of ordinary input. Started work is never replayed at boot. */
  dispatchState: z.enum(['pending', 'started', 'completed', 'uncertain']).optional(),
  // The newest event when this message stopped waiting. Log order stays arrival order;
  // the transcript draws the message after this event, where its own turn begins.
  queuedAfter: z.string().optional(),
  // Set only when the scheduler injected this message. Both fields are optional so
  // every row written before routines existed still parses, and absence is the
  // ordinary case: a message the user typed says nothing about where it came from.
  // The transcript renders this variant as a centred routine line rather than as a
  // The user bubble, which would put words in the user's mouth and ruin the chat as a record.
  // `subagent_task` is the brief a persona's delegate_task wrote into a child thread.
  // `background_wake` is Manor telling a persona that background work it started has
  // ended; `wakeItems` names what ended and the transcript draws one compact line.
  // `project_thread` is Manor waking a project thread (2026-10-10) for a session's
  // question, a report, a session's learnings, a DM brief or the seed; `threadReason`
  // says which, and the transcript draws one quiet line that opens onto the prompt.
  source: z.enum(['routine', 'work_handoff', 'agent_relay', 'subagent_task', 'background_wake', 'project_thread']).optional(),
  threadReason: z.enum(['question', 'report', 'result', 'brief', 'seed']).optional(),
  // The thread notes whose `threadPending` prompt this message carries into its turn.
  // A note named here is delivered and never rides along again, also after a restart.
  threadDelivered: z.array(z.string()).optional(),
  // Unbounded like the row's text: children run one after another add up past any
  // concurrency limit, and a refused row would drop the whole wake on the client.
  wakeItems: z.array(WakeItemSchema).optional(),
  // The routine's name as it stood when the turn fired, so a renamed or deleted
  // routine does not rewrite what the transcript says happened.
  routineName: z.string().optional(),
  // Stable identity for matching this prompt to its own result in a continuing DM.
  // Optional keeps transcripts written before DM routines valid.
  routineId: z.string().optional(),
  // The last successful fire before this one, as the source-watermark lower bound.
  // Null means this is the first successful window; absent keeps old transcripts valid.
  routineLastRunAt: z.number().nullable().optional(),
  // A one-time routine's scheduled moment, so a late fire can tell the persona it is late.
  routineDueAt: z.number().optional(),
  // Set only on the kickoff a Chat persona prepared for linked project work.
  // The kickoff is complete context; the source transcript never follows it.
  workHandoffId: z.string().optional(),
  workSourceChatId: z.string().optional(),
  workAuthorAgentId: z.string().optional(),
  // Display name at kickoff creation, independent of the target room roster.
  workAuthorAgentName: z.string().optional(),
  // Only a project thread kickoff names the project as its source.
  workProjectName: z.string().optional(),
  workFirstExecutorAgentId: z.string().optional(),
  workSupportingAgentIds: z.array(z.string()).optional(),
  workTargetLeadId: z.string().optional(),
  // Set only when another persona wrote this message into a standing pair thread.
  // The author is data rather than inferred from the room: either member may ask,
  // and the receiver needs the exact speaker in catch-up.
  authorAgentId: z.string().optional(),
  originChatId: z.string().optional(),
  originTurnId: z.string().optional(),
  relayId: z.string().optional(),
  relayDepth: z.number().int().nonnegative().optional(),
})
export const UserMessageEventSchema = UserMessageEventWireSchema.refine(hasAtMostMessageAttachments, {
  message: `images and files may contain at most ${MAX_MESSAGE_ATTACHMENTS} attachments combined`,
})

export const AgentMessageEventSchema = z.object({
  ...eventBase,
  type: z.literal('agent_message'),
  agentId: z.string(),
  turnId: z.string(),
  // One provider-visible assistant message inside a turn. Optional only for
  // transcripts written before message boundaries became first-class.
  messageId: z.string().optional(),
  text: z.string(),
  // A provider started this message but never reported its completion because the
  // turn was stopped or failed. Optional for every ordinary and historical message.
  // Kept on the message instead of inferred from the turn note, because the note is
  // turn-wide while a turn may have completed messages before this partial one.
  interrupted: z.boolean().optional(),
  // Images produced by the agent during this turn. Reusing the durable attachment
  // shape keeps them available after restarts and to later multimodal turns.
  images: z.array(EventImageSchema).max(4).optional(),
  usage: UsageSchema.optional(),
})

/**
 * Caps on the two heavy things a turn can produce. Both land in the canonical
 * transcript, which is read back in full on every chat open, so a single
 * pathological turn must not be able to make a thread expensive to load. Drivers
 * truncate to these before emitting; the schemas enforce them at the boundary.
 */
export const EDIT_SIDE_LIMIT = 8_000
export const MAX_EDITS_PER_CALL = 20
export const REASONING_LIMIT = 8_000

/**
 * One file change, normalised by the driver. Where the provider supplies contents,
 * `before` and `after` are the two sides of a hunk and an absent `after` is a delete.
 * Where it supplies only metadata, `kind` keeps the operation and both sides stay
 * absent. A whole-file write with no previous side still does not prove creation,
 * so novelty remains `created`'s job. No provider patch syntax reaches the UI.
 */
export const FileEditSchema = z.object({
  path: z.string().max(400),
  /** Absolute location when the driver knows how this tool resolves a relative path. */
  originPath: z.string().max(1_024).optional(),
  /** Exact Files-panel path for that location, when it is in a linked folder. */
  panelPath: z.string().max(1_024).optional(),
  before: z.string().max(EDIT_SIDE_LIMIT).optional(),
  after: z.string().max(EDIT_SIDE_LIMIT).optional(),
  // Some providers report only that a path was added, updated or deleted. Keep
  // that fact without inventing file contents just to make a diff-shaped object.
  kind: z.enum(['add', 'update', 'delete']).optional(),
  // True only when the driver established the file did not exist beforehand.
  // Absent means "not known to be new", which is not the same as "existed".
  created: z.boolean().optional(),
  // Set when a side was longer than the cap and lost its tail, so the UI can say
  // the diff is partial instead of quietly showing a wrong one.
  truncated: z.boolean().optional(),
  // How many lines of the old and new file sit above this hunk, so the diff gutter
  // can print the numbers you would find in the file. Absent when the source never
  // said where the hunk lives; the gutter then stays empty rather than counting from 1.
  offset: z.object({
    before: z.number().int().nonnegative(),
    after: z.number().int().nonnegative(),
  }).optional(),
})
export type FileEdit = z.infer<typeof FileEditSchema>

/** Actual worktree delta between the start and end of an isolated turn. */
export const TurnFileChangeSchema = z.object({
  path: z.string().max(1_024),
  oldPath: z.string().max(1_024).optional(),
  /** Exact Files-panel path for this checkout, assigned by the server. */
  panelPath: z.string().max(1_024).optional(),
  status: z.enum(['created', 'deleted', 'edited']),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  edits: z.array(FileEditSchema).max(MAX_EDITS_PER_CALL),
  /** A hunk or the file's patch was too large, so part of its diff is missing. */
  diffTruncated: z.boolean().optional(),
  /** The turn's diff budget ran out before this file, so it keeps its counts and no hunks. */
  diffSkipped: z.boolean().optional(),
})
export type TurnFileChange = z.infer<typeof TurnFileChangeSchema>

/** A subagent's final answer is capped; its launch brief is kept whole, the detail promises it exact. */
export const SUBAGENT_TEXT_MAX = 20_000

/**
 * What one subagent was started with, as its provider reported it. Every field is
 * optional because each is only set where the provider stated it for this call:
 * a parent's default model or effort is not evidence of what the helper ran on.
 */
export const SubagentLaunchSchema = z.object({
  // The card title: the brief's own description, or its first sentence.
  title: z.string().max(200).optional(),
  // The text the parent wrote. Skill or agent definitions the runtime loads on top
  // are not part of it and never reported here.
  prompt: z.string().optional(),
  model: z.string().max(100).optional(),
  effort: z.string().max(40).optional(),
  // The provider it ran on, which Manor stamps rather than the provider reporting it.
  // A provider's own helper always runs on the provider of the turn that launched it.
  driver: DriverSchema.optional(),
  // A Manor-run child: its own thread, and the role it was given beside the task.
  childChatId: z.string().optional(),
  role: z.string().max(2_000).optional(),
  // A child the parent started as a code reviewer. A Single goal Session that changed
  // code is reached only after one of these ended done since its last change.
  review: z.literal(true).optional(),
})
export type SubagentLaunch = z.infer<typeof SubagentLaunchSchema>

export const ToolUseEventSchema = z.object({
  ...eventBase,
  type: z.literal('tool_use'),
  agentId: z.string(),
  turnId: z.string(),
  // Provider call id when the driver exposes one. Older events and lightweight
  // drivers may omit it; the UI then treats the call as complete with its turn.
  toolCallId: z.string().optional(),
  parentToolCallId: z.string().optional(),
  tool: z.string(),
  agentType: z.string().max(100).optional(),
  // Only on a subagent launch.
  subagent: SubagentLaunchSchema.optional(),
  // Short human-readable summary, e.g. "4 files" or a search subject.
  detail: z.string().optional(),
  // Selected action subject, preserving combinations such as skill + file or query + location.
  subject: z.string().max(500).optional(),
  // Concrete files or paths the action touched. Kept separate from the shell
  // command so the UI never has to reverse engineer provider syntax.
  targets: z.array(z.string()).max(100).optional(),
  // Provider command when there was one. Secondary technical detail, never the
  // primary activity label and capped before it enters the canonical transcript.
  command: z.string().max(2_000).optional(),
  // File changes this call made, when the tool was an edit. Absent for every
  // read-only tool, so its presence is what tells the UI to offer a diff.
  edits: z.array(FileEditSchema).max(MAX_EDITS_PER_CALL).optional(),
  // The call started work the persona did not wait for. Its result arrives when that
  // work ends, not when the call returned, and it is never the turn's current step.
  background: z.literal(true).optional(),
})

/**
 * Background work a turn is waiting on once it answered, by kind. A helper agent is
 * an agent; a backgrounded shell or monitor is a command.
 */
export const BackgroundWaitSchema = z.object({
  agents: z.number().int().min(0),
  commands: z.number().int().min(0),
})
export type BackgroundWait = z.infer<typeof BackgroundWaitSchema>

/**
 * A running turn's context window as the CLI reports it between requests. Transient:
 * the turn's durable `turn_result` carries the final reading. Absent `contextTokens`
 * means no reading yet, unless `compacted` says the CLI compacted without naming the
 * new size; the meter then reads empty rather than the stale size from before.
 */
export const LiveContextSchema = z.object({
  contextTokens: z.number().int().min(0).optional(),
  contextWindow: z.number().int().positive().optional(),
  /** Where this session compacts, when the driver knows it exactly (Claude's `--autocompact`). */
  autoCompactTokens: z.number().int().positive().optional(),
  compacting: z.boolean(),
  compacted: z.literal(true).optional(),
})
export type LiveContext = z.infer<typeof LiveContextSchema>

/** One provider-neutral task in the latest plan a persona published. */
export const TodoItemSchema = z.object({
  text: z.string().min(1).max(500),
  status: z.enum(['pending', 'in_progress', 'completed']),
})
export type TodoItem = z.infer<typeof TodoItemSchema>

/**
 * A complete snapshot rather than a patch. Claude and Grok publish `todos`, while
 * Codex publishes a `todo_list`; replacing the list is the one semantic all three
 * actually share and cannot leave the client with a half-applied plan.
 */
export const TodoUpdateEventSchema = z.object({
  ...eventBase,
  type: z.literal('todo_update'),
  agentId: z.string(),
  turnId: z.string(),
  todos: z.array(TodoItemSchema).max(50),
})

export const UserInputOptionSchema = z.object({
  label: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
})
export type UserInputOption = z.infer<typeof UserInputOptionSchema>

/** Stable key the UI and the blocked MCP call both use to pair an answer. */
export const USER_INPUT_QUESTION_ID = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/
export const USER_INPUT_ANSWER_MAX = 2_000
export const USER_INPUT_OPTIONS_MAX = 4

/** The longest value one secret card takes: a PEM key fits, a pasted file does not. */
export const SECRET_VALUE_MAX = 16_000
/** The variable a command reads its one secret from. */
export const SECRET_ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/

/**
 * Where a secret card's one value goes, shown before the user enters anything. Only the
 * destination is here: the value itself never enters an event, so nothing about it
 * can reach the store, a prompt or a summary.
 */
export const SecretDestinationSchema = z.discriminatedUnion('target', [
  z.object({
    target: z.literal('command'),
    command: z.string().min(1).max(4_000),
    env: z.string().regex(SECRET_ENV_NAME),
  }),
  z.object({ target: z.literal('browser'), site: z.string().min(1).max(300) }),
])
export type SecretDestination = z.infer<typeof SecretDestinationSchema>

/** What the card says will happen to the value, before the user enters anything. Same words on every client. */
export const secretCardNote = (destination: SecretDestination): string => destination.target === 'command'
  ? `This command gets the value as $${destination.env}, once. Check it first: it decides what happens to the value. Manor hides the value from the output the agent reads, and keeps nothing.`
  : `Fills the password field on ${destination.site}, once. The agent never sees it, Manor keeps nothing, and agents cannot read this tab until it goes to a new address.`

/** A secret card that closed without an answer. */
export const SECRET_CLOSED_TEXT = 'Closed. The turn ended or Manor restarted, so no value is held.'

export const UserInputQuestionSchema = z.object({
  id: z.string().min(1).max(80).regex(USER_INPUT_QUESTION_ID, 'must be a snake_case identifier'),
  header: z.string().max(80).optional(),
  question: z.string().min(1).max(1_000),
  options: z.array(UserInputOptionSchema).min(2).max(USER_INPUT_OPTIONS_MAX),
  /** More than one option may be chosen. Absent is a single choice. */
  multi: z.boolean().optional(),
  /**
   * The offered options are the whole answer, so the UI leaves off its free line.
   * Manor's own permission cards set it: "Allow once" or "Deny" is the decision, and
   * a typed third answer there is not one the broker could act on. Server-owned, the
   * ask-user tool cannot set it.
   */
  optionsOnly: z.boolean().optional(),
  /**
   * Only the Mac can answer it, because what it approves happens there, such as a
   * saved login filled into the desktop browser. The phone shows the question without
   * its options. Server-owned like `optionsOnly`.
   */
  desktopOnly: z.boolean().optional(),
  /**
   * A secret card: the UI takes one masked value instead of options, and sends it with
   * `answer_secret_request`, never as an answer. Server-owned like `optionsOnly`. It
   * always comes with `optionsOnly` and `desktopOnly`, so a client too old to know this
   * field offers no free line and points at the Mac.
   */
  secret: SecretDestinationSchema.optional(),
})
export type UserInputQuestion = z.infer<typeof UserInputQuestionSchema>

/**
 * One question's answer. A string is the original single choice (and still what a
 * skip or a free line is). A list is multi-select. Stored events keep both so a
 * thread written before lists existed still reloads.
 */
export const UserInputAnswerValueSchema = z.union([
  z.string().min(1).max(USER_INPUT_ANSWER_MAX),
  z.array(z.string().min(1).max(USER_INPUT_ANSWER_MAX)).min(1),
])
export type UserInputAnswerValue = z.infer<typeof UserInputAnswerValueSchema>
export const UserInputAnswersSchema = z.record(z.string(), UserInputAnswerValueSchema)
export type UserInputAnswers = z.infer<typeof UserInputAnswersSchema>

export const userInputAnswerLines = (answer: UserInputAnswerValue): string[] =>
  typeof answer === 'string' ? [answer] : answer

export const userInputAnswerText = (answer: UserInputAnswerValue): string =>
  userInputAnswerLines(answer).join(', ')

/**
 * What the agent reads for a question that was passed over. The button says "Skip",
 * which is for the user; this line is for the model, and it has to say carry on without
 * me rather than stop, because an agent that halts leaves them with nothing.
 */
export const SKIPPED_ANSWER = 'Skipped. Decide this one yourself.'

/** Whether a question was passed over. A transcript says "Skipped" for it, never the model's line. */
export const isSkippedAnswer = (answer: UserInputAnswerValue): boolean =>
  userInputAnswerLines(answer).every((line) => line === SKIPPED_ANSWER)

/** One to three prompts, each with a unique snake_case id so one answer cannot stand for two questions. */
export const UserInputQuestionsSchema = z
  .array(UserInputQuestionSchema)
  .min(1)
  .max(3)
  .refine((questions) => new Set(questions.map((question) => question.id)).size === questions.length, {
    message: 'question ids must be unique',
  })

/** The agent is blocked on this durable question until a matching response lands. */
export const UserInputRequestEventSchema = z.object({
  ...eventBase,
  type: z.literal('user_input_request'),
  agentId: z.string(),
  turnId: z.string(),
  requestId: z.string(),
  questions: UserInputQuestionsSchema,
})

/**
 * The line a project thread quoted when it answered a Session's question itself, and
 * the file that holds it: `preferences.md` or a memory card one of its lines links to.
 */
export const PreferenceSourceSchema = z.object({
  file: z.string().min(1).max(200),
  quote: z.string().min(1).max(2_000),
})
export type PreferenceSource = z.infer<typeof PreferenceSourceSchema>

/**
 * What the user answered, append-only so the question remains an honest transcript.
 * `fromPreference` marks an answer Manor gave from the user's standing preferences instead,
 * so the asking agent never reads it as the user's own choice.
 */
export const UserInputResponseEventSchema = z.object({
  ...eventBase,
  type: z.literal('user_input_response'),
  agentId: z.string(),
  turnId: z.string(),
  requestId: z.string(),
  answers: UserInputAnswersSchema,
  fromPreference: PreferenceSourceSchema.optional(),
})

/**
 * Last-centimetre outbound: Gmail or Slack copy that sits in the transcript until
 * The user submits. Never auto-sent. Slack requires its non-display conversation id;
 * Gmail carries the selected mailbox instead.
 */
export const OutboundChannelSchema = z.enum(['gmail', 'slack'])
export type OutboundChannel = z.infer<typeof OutboundChannelSchema>
export const OutboundMailAccountSchema = z.enum(['personal'])
export type OutboundMailAccount = z.infer<typeof OutboundMailAccountSchema>
export const OUTBOUND_DRAFT_BODY_MAX = 20_000
export const OUTBOUND_DRAFT_TO_MAX = 400
export const OUTBOUND_DRAFT_SUBJECT_MAX = 200
export const OUTBOUND_SLACK_CHANNEL_ID_MAX = 32
export const OUTBOUND_SLACK_THREAD_TS_MAX = 32
export const OUTBOUND_SLACK_CHANNEL_ID_PATTERN = '^[A-Z][A-Z0-9]{5,31}$'
export const OUTBOUND_SLACK_THREAD_TS_PATTERN = '^\\d{8,16}\\.\\d{6}$'
const OUTBOUND_SLACK_CHANNEL_ID_REGEX = new RegExp(OUTBOUND_SLACK_CHANNEL_ID_PATTERN)
const OUTBOUND_SLACK_THREAD_TS_REGEX = new RegExp(OUTBOUND_SLACK_THREAD_TS_PATTERN)

export const isOutboundSlackChannelId = (value: string | undefined): value is string =>
  value !== undefined && OUTBOUND_SLACK_CHANNEL_ID_REGEX.test(value)

export const isOutboundSlackThreadTs = (value: string | undefined): value is string =>
  value !== undefined && OUTBOUND_SLACK_THREAD_TS_REGEX.test(value)

export const OutboundDraftThreadSchema = z.object({
  threadId: z.string().trim().min(1).max(240),
  previous: z.object({
    from: z.string().max(OUTBOUND_DRAFT_TO_MAX),
    at: z.string().datetime(),
    text: z.string().max(OUTBOUND_DRAFT_BODY_MAX),
  }).strict(),
  earlierCount: z.number().int().nonnegative().max(10_000),
  openUrl: z.string().url().max(2_000).optional(),
}).strict()
export type OutboundDraftThread = z.infer<typeof OutboundDraftThreadSchema>

export const OutboundThreadMessageSchema = z.object({
  id: z.string().min(1).max(240),
  from: z.string().max(OUTBOUND_DRAFT_TO_MAX),
  to: z.string().max(OUTBOUND_DRAFT_TO_MAX).optional(),
  at: z.string().datetime(),
  subject: z.string().max(OUTBOUND_DRAFT_SUBJECT_MAX).optional(),
  text: z.string().max(OUTBOUND_DRAFT_BODY_MAX),
})
export type OutboundThreadMessage = z.infer<typeof OutboundThreadMessageSchema>

const OutboundDraftBaseSchema = z.object({
  to: z.string().trim().min(1).max(OUTBOUND_DRAFT_TO_MAX),
  body: z.string().max(OUTBOUND_DRAFT_BODY_MAX).refine((body) => body.trim().length > 0),
  thread: OutboundDraftThreadSchema.optional(),
}).strict()

export const OutboundDraftContentSchema = z.discriminatedUnion('channel', [
  OutboundDraftBaseSchema.extend({
    channel: z.literal('gmail'),
    subject: z.string().max(OUTBOUND_DRAFT_SUBJECT_MAX).optional(),
    cc: z.string().max(OUTBOUND_DRAFT_TO_MAX).optional(),
    mailAccount: OutboundMailAccountSchema.optional(),
  }),
  OutboundDraftBaseSchema.extend({
    channel: z.literal('slack'),
    slackRichText: SlackRichTextSchema.optional(),
    slackChannelId: z.string().trim().min(1).max(OUTBOUND_SLACK_CHANNEL_ID_MAX).regex(OUTBOUND_SLACK_CHANNEL_ID_REGEX),
    slackThreadTs: z.string().trim().min(1).max(OUTBOUND_SLACK_THREAD_TS_MAX).regex(OUTBOUND_SLACK_THREAD_TS_REGEX).optional(),
  }),
])
export type OutboundDraftContent = z.infer<typeof OutboundDraftContentSchema>

/** Persisted shape stays loose enough to read Slack drafts made before routing was required. */
export const OutboundDraftFieldsSchema = z.object({
  draftId: z.string().min(1).max(120),
  channel: OutboundChannelSchema,
  to: z.string().trim().min(1).max(OUTBOUND_DRAFT_TO_MAX),
  subject: z.string().max(OUTBOUND_DRAFT_SUBJECT_MAX).optional(),
  cc: z.string().max(OUTBOUND_DRAFT_TO_MAX).optional(),
  /** The sending address as the server resolved it when the draft was prepared. Display only. */
  from: z.string().max(OUTBOUND_DRAFT_TO_MAX).optional(),
  body: z.string().max(OUTBOUND_DRAFT_BODY_MAX),
  mailAccount: OutboundMailAccountSchema.optional(),
  slackChannelId: z.string().trim().min(1).max(OUTBOUND_SLACK_CHANNEL_ID_MAX).optional(),
  slackThreadTs: z.string().trim().min(1).max(OUTBOUND_SLACK_THREAD_TS_MAX).optional(),
  slackRichText: SlackRichTextSchema.optional(),
  thread: OutboundDraftThreadSchema.optional(),
  /** False when this Manor cannot read the full thread, so the card offers no Show more. Server-filled. */
  fullThread: z.literal(false).optional(),
})
export type OutboundDraftFields = z.infer<typeof OutboundDraftFieldsSchema>

export const OutboundDraftEventSchema = z.object({
  ...eventBase,
  type: z.literal('outbound_draft'),
  agentId: z.string(),
  turnId: z.string(),
  ...OutboundDraftFieldsSchema.shape,
})

/** Largest file a persona may hand over with `deliver_file`; the original is kept in the store. */
export const MAX_DELIVERED_FILE_BYTES = 25 * 1_024 * 1_024

/** Screen widths a delivered HTML mockup is shown at, scaled to the chat: 1280px or 390px. Absent, a page fits the reply column. */
export const DELIVERED_VIEWPORTS = ['desktop', 'phone'] as const

/**
 * A file a persona made and handed to the user. The original bytes live beside the
 * transcript like a document attachment's, keyed by `id`; toward a client the server
 * adds `src`, a signed link that opens it (`?download=1` saves it instead).
 */
export const DeliveredFileSchema = z.object({
  id: z.string().min(1).max(120),
  name: z.string().min(1).max(160),
  mime: z.string().min(1).max(160),
  size: z.number().int().nonnegative(),
  src: z.string().min(1).max(2_000).optional(),
  /** Set for an HTML mockup of a specific screen (desktop 1280px, phone 390px); absent means a visual answer fitted to the chat. */
  viewport: z.enum(DELIVERED_VIEWPORTS).optional(),
})
export type DeliveredFile = z.infer<typeof DeliveredFileSchema>
export type DeliveredViewport = (typeof DELIVERED_VIEWPORTS)[number]

/** What a file in a DM's library is shown as: Media is image and video, Files is the rest. */
export const DM_FILE_KINDS = ['image', 'video', 'pdf', 'file'] as const
export type DmFileKind = (typeof DM_FILE_KINDS)[number]

/**
 * One file of a DM, for the Files page of its Agent settings: something the user attached
 * or the agent made (an image in a reply, a delivered file). Listed from the DM's own
 * transcript, so it holds no bytes; `src` is the same signed link the transcript carries.
 */
export const DmFileSchema = z.object({
  /** Stable inside the DM: the event that holds the file plus its slot there. */
  id: z.string().min(1).max(400),
  name: z.string().min(1).max(160),
  mime: z.string().min(1).max(160),
  kind: z.enum(DM_FILE_KINDS),
  size: z.number().int().nonnegative(),
  ts: z.number(),
  /** The agent that made it. Absent on a file the user attached. */
  agentId: z.string().optional(),
  /** The transcript message Show in chat lands on. Absent when the file's turn said nothing. */
  messageId: z.string().optional(),
  /** Absent when the bytes are gone; the file then lists as unavailable. */
  src: z.string().min(1).max(2_000).optional(),
  /** A delivered HTML page, which `?view=1` on its link draws sandboxed. */
  page: z.literal(true).optional(),
})
export type DmFile = z.infer<typeof DmFileSchema>

/** One `deliver_file` call that succeeded. Grouped under its turn, shown under the answer. */
export const FileDeliveryEventSchema = z.object({
  ...eventBase,
  type: z.literal('file_delivery'),
  agentId: z.string(),
  turnId: z.string(),
  file: DeliveredFileSchema,
})

/** Terminal state for Discard, plus submitted events written before durable claims existed. */
export const OutboundDraftClosedEventSchema = z.object({
  ...eventBase,
  type: z.literal('outbound_draft_closed'),
  agentId: z.string(),
  turnId: z.string(),
  draftId: z.string().min(1).max(120),
  outcome: z.enum(['submitted', 'discarded', 'snoozed', 'ignored']),
  until: z.number().int().positive().optional(),
  /**
   * How Submit left the machine. `recorded` is the test port: the edited body was
   * accepted without an external effect. `delivered` means a live port accepted it.
   */
  delivery: z.enum(['recorded', 'delivered']).optional(),
  channel: OutboundChannelSchema,
  to: z.string().min(1).max(OUTBOUND_DRAFT_TO_MAX),
  subject: z.string().max(OUTBOUND_DRAFT_SUBJECT_MAX).optional(),
  cc: z.string().max(OUTBOUND_DRAFT_TO_MAX).optional(),
  body: z.string().max(OUTBOUND_DRAFT_BODY_MAX).optional(),
  mailAccount: OutboundMailAccountSchema.optional(),
  slackChannelId: z.string().min(1).max(OUTBOUND_SLACK_CHANNEL_ID_MAX).optional(),
  slackThreadTs: z.string().min(1).max(OUTBOUND_SLACK_THREAD_TS_MAX).optional(),
  slackRichText: SlackRichTextSchema.optional(),
})

/**
 * Durable send claim and its resolution. `started` is written before external I/O;
 * until a later event proves failure or delivery, another Submit must never send.
 */
export const OutboundDraftSubmissionEventSchema = z.object({
  ...eventBase,
  type: z.literal('outbound_draft_submission'),
  agentId: z.string(),
  turnId: z.string(),
  draftId: z.string().min(1).max(120),
  submissionId: z.string().uuid(),
  status: z.enum(['started', 'failed', 'uncertain', 'delivered']),
  delivery: z.enum(['recorded', 'delivered']).optional(),
  message: z.string().optional(),
  channel: OutboundChannelSchema,
  to: z.string().min(1).max(OUTBOUND_DRAFT_TO_MAX),
  subject: z.string().max(OUTBOUND_DRAFT_SUBJECT_MAX).optional(),
  cc: z.string().max(OUTBOUND_DRAFT_TO_MAX).optional(),
  body: z.string().max(OUTBOUND_DRAFT_BODY_MAX),
  mailAccount: OutboundMailAccountSchema.optional(),
  slackChannelId: z.string().min(1).max(OUTBOUND_SLACK_CHANNEL_ID_MAX).optional(),
  slackThreadTs: z.string().min(1).max(OUTBOUND_SLACK_THREAD_TS_MAX).optional(),
  slackRichText: SlackRichTextSchema.optional(),
})

export const OutboundDraftReopenedEventSchema = z.object({
  ...eventBase,
  type: z.literal('outbound_draft_reopened'),
  agentId: z.string(),
  turnId: z.string(),
  draftId: z.string().min(1).max(120),
})

/**
 * The model's own trace, as its own transcript row rather than a field on a
 * message: reasoning arrives interleaved with tool calls, and only a row keeps
 * that order. Durable on purpose — reasoning that vanished on reload would be the
 * same "it was there a second ago" defect the live-turn work already fixed.
 */
export const ReasoningEventSchema = z.object({
  ...eventBase,
  type: z.literal('reasoning'),
  agentId: z.string(),
  turnId: z.string(),
  parentToolCallId: z.string().optional(),
  text: z.string().max(REASONING_LIMIT),
})

export const ToolResultEventSchema = z.object({
  ...eventBase,
  type: z.literal('tool_result'),
  agentId: z.string(),
  turnId: z.string(),
  toolCallId: z.string(),
  parentToolCallId: z.string().optional(),
  outcome: z.enum(['success', 'error', 'stopped']),
  // Some providers reveal the final search subject only on completion.
  subject: z.string().max(500).optional(),
  tool: z.string().optional(),
  // A subagent's final answer. Other tools never carry their output into the transcript.
  output: z.string().max(SUBAGENT_TEXT_MAX).optional(),
  // First line of a failed call's output, redacted, for the trace row; never present on success.
  error: z.string().max(300).optional(),
  // Usage reported by a Manor-run helper, separate from its parent's provider usage.
  usage: UsageSchema.optional(),
  reportedModel: z.string().max(100).optional(),
  reportedEffort: z.string().max(40).optional(),
  // A provider may reveal only the attempted targets at start and establish the
  // successful edits at completion. Failed results leave this absent.
  edits: z.array(FileEditSchema).max(MAX_EDITS_PER_CALL).optional(),
})

/** One memory source observed by Manor, independent of the model's later judgment. */
export const MemoryReadSchema = z.object({
  source: z.enum(['injected', 'on_demand']),
  path: z.string().min(1).max(400),
  // Exact ranges are optional because not every provider exposes them. Omitting a
  // range is honest; manufacturing one from a path-only tool event is not.
  fromLine: z.number().int().positive().optional(),
  toLine: z.number().int().positive().optional(),
}).superRefine((read, context) => {
  if ((read.fromLine === undefined) !== (read.toLine === undefined)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'fromLine and toLine must be provided together',
    })
    return
  }
  if (read.fromLine === undefined || read.toLine === undefined || read.toLine >= read.fromLine) return
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'toLine must be at or after fromLine',
    path: ['toLine'],
  })
})
export type MemoryRead = z.infer<typeof MemoryReadSchema>

/** One short, model-derived claim about how a source informed the visible answer. */
export const MemoryUseItemSchema = z.object({
  text: z.string().min(1).max(500),
  sourcePath: z.string().min(1).max(400),
})
export type MemoryUseItem = z.infer<typeof MemoryUseItemSchema>

/** Durable trace ceiling; a pathological tool-heavy turn must still be able to finish. */
export const MAX_MEMORY_TRACE_READS = 100

/**
 * The observed reads stay separate from the disposable model's interpretation.
 * `none` is a real conclusion, while `unavailable` says no conclusion was reached;
 * an absent trace remains the legacy or Memory-disabled state.
 */
export const MemoryTraceSchema = z.object({
  reads: z.array(MemoryReadSchema).max(MAX_MEMORY_TRACE_READS),
  summary: z.discriminatedUnion('status', [
    z.object({
      status: z.literal('used'),
      derivation: z.literal('model'),
      items: z.array(MemoryUseItemSchema).min(1).max(5),
    }),
    z.object({
      status: z.literal('none'),
      derivation: z.literal('model'),
    }),
    z.object({
      status: z.literal('not_read'),
      derivation: z.literal('none'),
    }),
    z.object({
      status: z.literal('unavailable'),
      derivation: z.literal('model'),
    }),
  ]),
}).superRefine((trace, context) => {
  const hasReads = trace.reads.length > 0
  if ((trace.summary.status === 'not_read') === hasReads) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: trace.summary.status === 'not_read'
        ? 'not_read requires an empty reads list'
        : `${trace.summary.status} requires at least one observed read`,
      path: ['summary', 'status'],
    })
  }
  if (trace.summary.status !== 'used') return
  const observed = new Set(trace.reads.map((read) => read.path))
  trace.summary.items.forEach((item, index) => {
    if (observed.has(item.sourcePath)) return
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'sourcePath must match an observed read',
      path: ['summary', 'items', index, 'sourcePath'],
    })
  })
})
export type MemoryTrace = z.infer<typeof MemoryTraceSchema>

/** One line-level change to a memory file, as the footer's memory diff shows it. */
export const MemoryChangeLineSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('added'), text: z.string().max(2_000) }),
  z.object({ kind: z.literal('removed'), text: z.string().max(2_000) }),
  z.object({ kind: z.literal('replaced'), before: z.string().max(2_000), after: z.string().max(2_000) }),
])
export type MemoryChangeLine = z.infer<typeof MemoryChangeLineSchema>

export const MAX_MEMORY_CHANGE_LINES = 60
export const MAX_MEMORY_CHANGE_FILES = 20

/**
 * What a turn changed in the user's memory folder checkout, per file. Written by the persona
 * during the turn or by Manor's daily-log writer after the persona chain. Paths here
 * are memory, so the changed-files banner leaves them out unless the change was cut.
 */
export const MemoryChangeSchema = z.object({
  path: z.string().min(1).max(1_024),
  lines: z.array(MemoryChangeLineSchema).max(MAX_MEMORY_CHANGE_LINES),
  /** Cut to fit the caps; the card says so. A persona's own cut edit also stays in the banner. */
  truncated: z.literal(true).optional(),
})
export type MemoryChange = z.infer<typeof MemoryChangeSchema>

/** The largest notes file a turn keeps a copy of for Undo; past it the chat line is not offered. */
export const NOTES_UNDO_MAX = 20_000

/**
 * A persona's own standing notes changed in this turn (`memory/agents/<id>.md`). The
 * chat shows "Updated its notes" with View and Undo. Undo puts `before` back only
 * while the file still hashes to `afterHash`; a later change refuses it.
 */
export const NotesUpdateSchema = z.object({
  /** Note lines added and removed, headings and the capacity line left out. */
  added: z.number().int().min(0),
  removed: z.number().int().min(0),
  /** The file as the turn found it; null when it did not exist, so Undo removes it. */
  before: z.string().max(NOTES_UNDO_MAX).nullable(),
  /** SHA-256 of the file as the turn left it; null when the turn removed it. */
  afterHash: z.string().max(128).nullable(),
  undone: z.literal(true).optional(),
})
export type NotesUpdate = z.infer<typeof NotesUpdateSchema>

/** The longest line a memory-off agent may offer for its instructions. */
export const INSTRUCTIONS_OFFER_MAX = 500

/**
 * Where one context figure came from, so a reader can tell a reading from a guess.
 *
 * `unknown` carries no number on purpose. A driver that reports nothing must not be
 * rendered as zero, and must not be handed an estimate wearing a measurement's label.
 */
export const ContextFigureSchema = z.discriminatedUnion('source', [
  /** An exact number, not a guess: named by the provider, or by the argv Manor itself
   *  passed in (which is how `autoCompactAt` is known on Claude). */
  z.object({ source: z.literal('measured'), tokens: z.number().int().nonnegative() }),
  /** Derived by Manor, from supplied text or from a catalog constant. */
  z.object({ source: z.literal('estimated'), tokens: z.number().int().nonnegative() }),
  /** Nothing to report. Not zero. */
  z.object({ source: z.literal('unknown') }),
])
export type ContextFigure = z.infer<typeof ContextFigureSchema>

/**
 * What one turn knows about the window it ran in.
 *
 * The four counts at the top are Manor's own estimate of the blocks it supplied, at
 * the measured characters per token of the turn's model; they are not a
 * reconstruction of the CLI request and never were. The
 * three figures below carry provenance, because the same field is a provider reading
 * on one driver and a catalog constant on another: Codex names a real
 * `model_context_window`, Claude and Cursor report fill but no window, and Grok
 * reports neither. Absent on turns written before this existed.
 */
export const ContextEstimateSchema = z.object({
  instructions: z.number().int().nonnegative(),
  memory: z.number().int().nonnegative(),
  skills: z.number().int().nonnegative(),
  /**
   * What attached MCP tools occupy in the window, as the driver loads them: listed
   * names on Claude, Grok and Cursor, plus Manor's own inline schemas on Claude and
   * Grok's search gateway, and zero on Codex, whose code mode lists nothing. Never the
   * full schema size. Fetched schemas count as conversation.
   */
  mcpCatalog: z.number().int().nonnegative(),
  unmeasuredMcpServers: z.number().int().nonnegative(),
  /** Window fill at the turn's final request, mirroring `contextTokens`. */
  used: ContextFigureSchema.optional(),
  /** The window those tokens filled: the CLI's own figure, else `contextWindowFor`. */
  window: ContextFigureSchema.optional(),
  /**
   * Where the session gets compacted. Measured on Claude, where Manor passes the
   * exact `--autocompact` value, so the threshold is known rather than guessed.
   * Unknown elsewhere: those drivers compact on rules they do not publish, and
   * Manor's own `LIVE_COMPACT_CONTEXT_FRACTION` is a fraction of the window above.
   */
  autoCompactAt: ContextFigureSchema.optional(),
})
export type ContextEstimate = z.infer<typeof ContextEstimateSchema>

/**
 * Hashes of the system prompt and the tool configuration Manor offered on one turn,
 * to investigate a warm prompt-cache rebuild. A changed hash points at a changed
 * prefix. Identical hashes point at expiry or eviction, unless a registered
 * connector's definitions changed without changing size. Diagnostics only, never shown.
 */
export const PromptFingerprintSchema = z.object({
  system: z.string(),
  tools: z.string(),
  model: z.string().optional(),
  sessionId: z.string().optional(),
  /**
   * On a resumed session, what moved since that session's previous turn: `model`,
   * `builtin`, `tools:<server>` or `system:<section heading>`. Absent when nothing did,
   * on a fresh session, and after a server restart (no earlier turn to compare with).
   */
  changed: z.array(z.string().max(120)).max(40).optional(),
})
export type PromptFingerprint = z.infer<typeof PromptFingerprintSchema>

export const TurnResultEventSchema = z.object({
  ...eventBase,
  type: z.literal('turn_result'),
  agentId: z.string(),
  turnId: z.string(),
  /**
   * The provider this turn ran on, so each of a persona's provider sessions can find
   * the last turn it saw itself and catch up from there. Absent on turns written
   * before this existed and on turns no provider answered (a literal reminder, an
   * expired fire); readers treat absent as seen by every provider, as before.
   */
  driver: DriverSchema.optional(),
  // Usage arrives after the last assistant message. Keeping it on the turn result
  // lets completed message segments be persisted in their real event order.
  usage: UsageSchema.optional(),
  /** Absent for older turns and folders Git cannot read; an empty list is a measured no-change turn. */
  fileChanges: z.array(TurnFileChangeSchema).max(500).optional(),
  /** Only edits under these roots are replaced by the measured file changes. */
  fileChangeRoots: z.array(z.string().max(1_024)).max(20).optional(),
  /**
   * Changed paths without a diff: reported edits under those roots that Git ignores, so
   * their tool reports stand, and files changed in a walked folder Git cannot snapshot.
   */
  fileChangeUnmeasured: z.array(z.string().max(1_024)).max(500).optional(),
  /**
   * A git checkout was linked but its delta could not be measured (snapshot or diff
   * failed, or over 500 files). Not "no change": the goal Session review gate treats
   * the turn as having changed code.
   */
  fileChangesFailed: z.literal(true).optional(),
  /**
   * How full the persona's context window was when it last spoke: the prompt of
   * the final request of this turn, not the sum of every request in it. Absent on
   * drivers that report no per-request usage and on transcripts written before
   * this existed.
   */
  contextTokens: z.number().optional(),
  /**
   * The CLI's own context window for that reading. Codex takes
   * `model_context_window` from the same rollout `token_count` as `contextTokens`.
   * Absent on Claude print CLI, Cursor, Grok, and older events; readers then use
   * `contextWindowFor`.
   */
  contextWindow: z.number().optional(),
  contextEstimate: ContextEstimateSchema.optional(),
  /** Absent on turns written before it existed. */
  promptFingerprint: PromptFingerprintSchema.optional(),
  /**
   * The model the CLI says actually served this turn, in the provider's own words.
   * Not the configured or pinned value: those say what was asked for, and this says
   * what answered, which is the only one worth showing next to an answer.
   *
   * It exists because a persona cannot be asked. Manor replaces the whole system
   * prompt, so nothing in a turn tells the model what it is, and asked directly it
   * confabulates a plausible name (measured 2026-08-12: a turn served by
   * `claude-opus-5` called itself Sonnet 4.5). Absent on transcripts written before
   * this existed, and on any driver that reports no model.
   */
  reportedModel: z.string().optional(),
  /**
   * Provider evidence that this turn used Fast rather than merely requesting it.
   * Cursor proves it by completing a catalogue-advertised `-fast` model invocation.
   * Absent means unobserved, not Standard, so callers must never infer the reverse
   * state from this field.
   */
  observedSpeed: z.literal('fast').optional(),
  /**
   * Whether a successful continuing-DM routine published a reply or deliberately
   * stayed silent. Absent on manual turns, project-run routines and older events.
   */
  routineOutcome: z.enum(['quiet', 'publish']).optional(),
  /**
   * A published routine run that did not cover its whole window, declared by the
   * persona or left unclassified. The scheduler keeps the previous watermark so the
   * next run reads the same window again. A flag beside `publish` rather than a third
   * enum value, so clients built before it still parse the event.
   */
  routineIncomplete: z.literal(true).optional(),
  /**
   * A one-time routine whose "only useful until" passed while it waited its turn in
   * the chat: no model ran, and the scheduler ends it `expired` rather than failed.
   */
  routineExpired: z.literal(true).optional(),
  /** What memory was observed and what a separate cheap model inferred from it. */
  memoryTrace: MemoryTraceSchema.optional(),
  /**
   * Memory files this turn changed. The daily-log writer runs after the persona
   * chain and adds its lines to the chain's last turn by replacing this event, so
   * the field can arrive after the turn already rendered.
   */
  memoryChanges: z.array(MemoryChangeSchema).max(MAX_MEMORY_CHANGE_FILES).optional(),
  /** The persona's own notes changed in this turn; see `NotesUpdateSchema`. */
  notesUpdate: NotesUpdateSchema.optional(),
  /**
   * A memory-off persona heard a lasting rule it cannot keep and offered it as a line
   * for its instructions. The chat shows "Add to instructions"; only the user edits them.
   */
  instructionsOffer: z.object({ line: z.string().min(1).max(INSTRUCTIONS_OFFER_MAX) }).optional(),
})

/**
 * How far a goal owner proved one done criterion, weakest first: said so, pointed at a
 * real `file:line`, walked the failure path and showed it cannot happen, ran code that
 * would fail loud, observed it in the running app. Shown beside Confirm, never a gate.
 */
export const GOAL_CLAIM_LEVELS = ['stated', 'pointed', 'traced', 'ran', 'reproduced'] as const
export const GoalClaimSchema = z.object({
  claim: z.string().trim().min(1).max(300),
  level: z.enum(GOAL_CLAIM_LEVELS),
  // The pointer that backs it: `file:line`, test name and result, command, screenshot path.
  ref: z.string().trim().max(500).optional(),
}).refine((claim) => claim.level === 'stated' || (claim.ref !== undefined && claim.ref.length > 0), {
  message: 'Every claim above stated needs a ref.',
  path: ['ref'],
})
export type GoalClaim = z.infer<typeof GoalClaimSchema>
export const GoalClaimsSchema = z.array(GoalClaimSchema).min(1).max(20)

/** The longest conflict-fix diff a card carries; the Session holds the rest. */
export const MERGE_FIX_DIFF_MAX = 60_000
/** How many merge failures Manor sends the lead per confirmation before it stops for the user. */
export const MERGE_REPAIRS_MAX = 3

/**
 * Where Manor's own merge of a confirmed worktree Session stands (2026-10-19). The lead
 * only commits; Manor rebases and fast-forwards, one merge per linked folder at a time.
 * - `queued`: waits behind `after`, the Session directly ahead, with `ahead` in front.
 * - `merging`: Manor rebases, runs the pre-commit hook when the branch moved, and merges.
 * - `fixing`: a conflict, a failing hook or another refusal went to the lead as `trouble`.
 * - `approve`: the lead resolved a conflict by more than keeping both sides' lines; `fix`
 *   is that resolution against Git's own merge, and it lands only after the user approves it.
 * - `blocked`: Manor stopped with the completion's message; Git rechecks may still find it
 *   landed, but never replace that reason with their own.
 * `trouble`'s commits, `approved` and `verified` are the server's Git baseline.
 */
export const WorkMergeSchema = z.object({
  stage: z.enum(['queued', 'merging', 'fixing', 'approve', 'blocked']),
  after: z.string().max(300).optional(),
  ahead: z.number().int().nonnegative().optional(),
  // `repo` is the worktree the failure happened in, `tip` its branch as the failure left
  // it, `base` the commit a conflicting rebase started from.
  trouble: z.object({
    kind: z.enum(['conflict', 'hook', 'rebase']),
    text: z.string().max(4_000),
    repo: z.string(),
    tip: z.string(),
    base: z.string().optional(),
    eventId: z.string().optional(),
  }).optional(),
  fix: z.object({
    repo: z.string(),
    tip: z.string(),
    files: z.array(z.string()).max(500),
    diff: z.string().max(MERGE_FIX_DIFF_MAX),
    truncated: z.boolean().optional(),
  }).optional(),
  // Per worktree: the conflict-fix tip the user approved, and the tip the pre-commit hook last passed.
  approved: z.record(z.string(), z.string()).optional(),
  verified: z.record(z.string(), z.string()).optional(),
  // Per worktree, the first conflict the lead was sent (Git's base, the tip before the fix).
  // `again` marks a later conflict: from then on every fix shows all it would land.
  conflicts: z.record(z.string(), z.object({ base: z.string(), tip: z.string(), again: z.boolean().optional() })).optional(),
  // Failures sent to the lead for this confirmation, at most MERGE_REPAIRS_MAX.
  repairs: z.number().int().nonnegative().optional(),
})
export type WorkMerge = z.infer<typeof WorkMergeSchema>

/** Approval and observed completion, including its server-owned Git baseline. */
export const WorkCompletionSchema = z.object({
  status: z.enum(['ready', 'pending', 'complete', 'blocked']),
  operation: z.enum(['none', 'commit', 'merge']),
  message: z.string().optional(),
  requestEventId: z.string().optional(),
  completedAt: z.number().optional(),
  // Server-observed baseline. Clients show only the operation and status.
  repos: z.array(z.object({
    path: z.string(), branch: z.string(), before: z.string(), tree: z.string(),
    files: z.array(z.string()),
    sourcePath: z.string().optional(), sourceHead: z.string().optional(), mergeInto: z.string().optional(),
  })),
  commits: z.array(z.object({ path: z.string(), hash: z.string() })).optional(),
  // Repo paths whose commit Git already shows on the Session's own branch, and whose
  // merge it shows on the target, while the request runs or after it failed. Confirm's
  // card ticks each step from these, in order, and fails the first one still open.
  committed: z.array(z.string()).optional(),
  merged: z.array(z.string()).optional(),
  // The requests the user's Retry posted after a block, oldest first; the newest is the
  // attempt that runs. `requestEventId` stays Confirm's own request, which bounds what
  // was approved. Retry reuses that approval, so it reopens nothing.
  retries: z.array(z.string()).optional(),
  // On a blocked completion: why Retry is not offered, in one line the card shows
  // (the approved files changed since Confirm). Absent means Retry is offered.
  retryRefused: z.string().max(300).optional(),
  merge: WorkMergeSchema.optional(),
})
export type WorkCompletion = z.infer<typeof WorkCompletionSchema>

/**
 * The user's code reviewer (2026-09-30): a goal Session that changed code is ready only
 * after this persona passed the current diff. Clients name him on a ready result.
 */
export const CODE_REVIEWER_ID = 'argus'
/** Prose a research or writing Session leaves behind; every other changed file is code, `.mdx` included. */
export const isProseFile = (file: string): boolean => /\.(md|txt)$/i.test(file)

/** The user-facing outcome; evidence and implementation details stay in the Session. */
/** The two files a project thread owns, in the project's structured memory folder. */
export const PROJECT_THREAD_FILES = ['preferences.md', 'notes.md'] as const
export const ProjectThreadFileSchema = z.enum(PROJECT_THREAD_FILES)
export type ProjectThreadFile = z.infer<typeof ProjectThreadFileSchema>
export const isProjectThreadFile = (file: string): file is ProjectThreadFile =>
  (PROJECT_THREAD_FILES as readonly string[]).includes(file)

/** A memory card beside the thread's two files: a flat Markdown file in the same folder. */
export const PROJECT_CARD_FILE = /^[a-z0-9][a-z0-9_-]*\.md$/

// A write to a project thread's own file, or a dated line on (or a new) memory card in
// its folder. `restore` is Manor undoing a write by someone else. `by` names the writer
// for display only; nothing matches on it.
export const ProjectFileWriteSchema = z.object({
  file: z.union([ProjectThreadFileSchema, z.string().max(200).regex(PROJECT_CARD_FILE)]),
  action: z.enum(['add', 'replace', 'remove', 'restore', 'create']),
  line: z.string().max(2_000).optional(),
  old: z.string().max(2_000).optional(),
  by: z.string().max(200),
  // The thread turn that wrote it. Clients fold the write into that turn's reply as a
  // footnote; a restore has none and stands as its own line.
  turnId: z.string().max(200).optional(),
})
export type ProjectFileWrite = z.infer<typeof ProjectFileWriteSchema>

const LOST_CONNECTION_TAIL = "'s turn lost its connection to the server, most likely a restart. Whatever it was doing may still have landed, so check the result rather than assume it did not run."

/** The note a restart leaves on a turn, or on an accepted request, it cut off mid-flight. */
export const lostConnectionNote = (name: string): string => `${name}${LOST_CONNECTION_TAIL}`

/**
 * What a Session says when code changed after its result and it works again. The Work
 * chat note and the card read the same line. Single has no persona to name, so it passes none.
 */
export const workReopenedLine = (lead: string | undefined): string =>
  `Changed after it was ready. ${lead === undefined ? 'A new version is being prepared.' : `${lead} is preparing a new version.`}`

/** A DM shows nothing for a turn that broke off, this note included (2026-10-12). */
export const isLostConnectionNote = (text: string): boolean => text.endsWith(LOST_CONNECTION_TAIL)

/** The short label a project file write wears in the transcript, e.g. "Saved to preferences.md". */
export function projectFileWriteLabel(write: Pick<ProjectFileWrite, 'action' | 'file'>, projectName?: string): string {
  if (projectName !== undefined) {
    switch (write.action) {
      case 'add': return `${projectName} saved 1 line to ${write.file}`
      case 'replace': return `${projectName} updated 1 line in ${write.file}`
      case 'remove': return `${projectName} removed 1 line from ${write.file}`
      case 'restore': return `${projectName} restored ${write.file}`
      case 'create': return `${projectName} created ${write.file}`
    }
  }
  switch (write.action) {
    case 'add': return `Saved to ${write.file}`
    case 'replace': return `Updated in ${write.file}`
    case 'remove': return `Removed from ${write.file}`
    case 'restore': return `Restored ${write.file}`
    case 'create': return `Created ${write.file}`
  }
}

/** The line a project file write touched, or for a restore who wrote outside the thread. */
export function projectFileWriteDetail(write: ProjectFileWrite): string | undefined {
  if (write.action === 'restore') return `${write.by} wrote to it outside the thread.`
  return write.action === 'remove' ? write.old : write.line ?? write.old
}

/** One thing a session learned for its project thread to fold in (2026-10-10). */
export const GoalLearningSchema = z.object({
  kind: z.enum(['preference', 'note']),
  text: z.string().trim().min(1).max(300),
  // The user's own words, for a preference.
  quote: z.string().trim().min(1).max(300).optional(),
})
export type GoalLearning = z.infer<typeof GoalLearningSchema>

/**
 * A screenshot the lead named on `goal_reached`, copied into the Session's own store so
 * the result card can show it after the evidence folder is gone. Toward a client the
 * server adds `src`, a signed link, the way it does for transcript images.
 */
export const GoalEvidenceSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(160),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  src: z.string().min(1).max(2_000).optional(),
})
export type GoalEvidence = z.infer<typeof GoalEvidenceSchema>
export const MAX_GOAL_EVIDENCE = 6

/**
 * How long a new report may be (2026-10-11): one or two short sentences and one line of
 * limitation. Stored reports keep the older, longer bounds so earlier results still parse.
 */
export const GOAL_RESULT_MAX = 280
export const GOAL_LIMITATIONS_MAX = 160

/**
 * The result card's lines (2026-11-07): at most three short points, each what changed or
 * what the user can now do. `result` stays the one-sentence conclusion that notifications and
 * the folded line read; a report without points shows the sentences of `result` instead.
 */
export const MAX_GOAL_POINTS = 3
export const GOAL_POINT_MAX = 100

/**
 * A decision a report leaves to the user (2026-10-14): the choice, its options and the one
 * the lead recommends. The card shows the first `GOAL_CHOICES_SHOWN`. `question` (2026-11-16)
 * says in plain words what is going on and what the user decides; the card shows it in
 * place of `title`, which stays the short key Follow up writes as `Title: option`.
 */
export const GOAL_CHOICE_QUESTION_MAX = 160
export const GoalChoiceSchema = z.object({
  title: z.string().trim().min(1).max(80),
  question: z.string().trim().min(1).max(GOAL_CHOICE_QUESTION_MAX).optional(),
  options: z.array(z.string().trim().min(1).max(80)).min(2).max(4),
  recommended: z.string().trim().min(1).max(80).optional(),
})
export type GoalChoice = z.infer<typeof GoalChoiceSchema>
export const MAX_GOAL_CHOICES = 10
export const GOAL_CHOICES_SHOWN = 3

/**
 * The commit message a lead hands in with `goal_reached` (2026-10-21): Confirm on a
 * worktree Session commits the approved files with it, without a model turn. It belongs
 * to the result it came with, so a reopened result drops it with the report.
 */
export const GOAL_COMMIT_SUBJECT_MAX = 100
export const GOAL_COMMIT_BODY_MAX = 3_000
export const GoalCommitSchema = z.object({
  subject: z.string().trim().min(1).max(GOAL_COMMIT_SUBJECT_MAX).regex(/^[^\n]*$/),
  body: z.string().trim().min(1).max(GOAL_COMMIT_BODY_MAX).optional(),
})
export type GoalCommit = z.infer<typeof GoalCommitSchema>

export const GoalReportSchema = z.object({
  result: z.string().trim().min(1).max(600),
  limitations: z.string().trim().min(1).max(300).optional(),
  // Optional: the card falls back to the sentences of `result` without them.
  points: z.array(z.string().trim().min(1).max(GOAL_POINT_MAX)).min(1).max(MAX_GOAL_POINTS).optional(),
  // Optional: a report without open choices shows just its conclusion.
  choices: z.array(GoalChoiceSchema).max(MAX_GOAL_CHOICES).optional(),
  // In a project with a thread, what the thread should consider for its two files.
  learnings: z.array(GoalLearningSchema).max(10).optional(),
  evidence: z.array(GoalEvidenceSchema).max(MAX_GOAL_EVIDENCE).optional(),
  // Not on the card: the message Confirm commits this result with.
  commit: GoalCommitSchema.optional(),
})
export type GoalReport = z.infer<typeof GoalReportSchema>

export const SystemNoteEventSchema = z.object({
  ...eventBase,
  type: z.literal('system_note'),
  kind: z.enum(['error', 'aborted', 'info']),
  text: z.string(),
  agentId: z.string().optional(),
  turnId: z.string().optional(),
  workHandoffId: z.string().optional(),
  workHandoffVersion: z.number().int().nonnegative().optional(),
  workHandoffPhase: z.enum(['created', 'settled', 'reopened']).optional(),
  // On a `reopened` receipt: Manor reopened the result because code changed after it
  // was ready, not because the user asked for changes. The card says so in one line.
  workChangedAfterReady: z.literal(true).optional(),
  // The goal Session note in which the lead marked the goal reached, naming its
  // handoff. Clients do not show it: Confirm lives in the bar and the diff. Not
  // `workHandoffId`: clients fold every note carrying that into the source DM's card.
  workGoalHandoffId: z.string().optional(),
  // The `/clear` marker. Models read nothing before it except `keepEventIds`, an open
  // goal's kickoff. Read through `contextEvents`; the transcript itself stays whole.
  contextBoundary: z.object({ keepEventIds: z.array(z.string()) }).optional(),
  // Bookkeeping about the turn named by `turnId` and `agentId` (a cap, background work
  // stopped, a problem it carried on from). Clients show it only inside that turn's
  // trace, never as a line in the thread.
  trace: z.literal(true).optional(),
  // The user message this note is about (a mention of someone absent, an addition whose
  // delivery is unknown). Clients show it under that message instead of as its own line.
  hintFor: z.string().optional(),
  // The owner's done criteria and how far each was proven, on that same goal note.
  goalClaims: GoalClaimsSchema.optional(),
  goalReport: GoalReportSchema.optional(),
  goalCompletion: WorkCompletionSchema.optional(),
  // Files a stopped or failed turn changed, on its terminal note. Such a turn writes no
  // `turn_result`, and the goal Session review gate must still see its edits.
  changedFiles: z.array(z.string().max(1_024)).max(1_000).optional(),
  // A stopped or failed turn's checkout could not be measured; see the same field on `turn_result`.
  fileChangesFailed: z.literal(true).optional(),
  // A write to a project thread's own file. Clients show it as a small card labelled
  // "Saved to preferences.md" with the line under it; `text` is the plain fallback.
  projectFileWrite: ProjectFileWriteSchema.optional(),
  // In a project thread, a question a session it started is blocked on. Answering sends
  // `answer_user_input` with the session's chat id; the directory's `awaitingInput`
  // says whether it still waits.
  sessionQuestion: z.object({
    sessionChatId: z.string(),
    requestId: z.string(),
    agentId: z.string(),
    title: z.string().max(200),
    questions: UserInputQuestionsSchema,
  }).optional(),
  // How a forwarded question was answered, by the user on the card or by the thread from a
  // preferences line it quotes.
  sessionAnswer: z.object({
    sessionChatId: z.string(),
    requestId: z.string(),
    answers: UserInputAnswersSchema,
    // Notes from before 2026-11-10 carry another word for the user, so anything else reads as `user`.
    by: z.enum(['user', 'thread']).catch('user'),
    preference: z.string().max(2_000).optional(),
  }).optional(),
  // In a project thread: The user's message named by `hintFor` went on to one of its
  // Sessions. Clients draw "Sent to <title>" under the user's bubble and a link to the Session
  // under the reply of the thread turn that sent it.
  sessionForward: z.object({
    sessionChatId: z.string(),
    title: z.string().max(200),
    turnId: z.string(),
    agentId: z.string(),
  }).optional(),
  // A preference or note reported to the thread by someone who may not write its files.
  projectReport: z.object({
    from: z.string().max(200),
    kind: z.enum(['preference', 'note']),
    text: z.string().max(2_000),
    quote: z.string().max(2_000).optional(),
    sourceChatId: z.string().optional(),
  }).optional(),
  // In a project thread: the prompt this note waits to give the thread's next turn
  // (2026-10-13); for a report, its one line under the shared report prompt. Only a
  // `sessionQuestion` note wakes the thread, the rest ride along with whatever turn
  // runs next. A `user_message` naming this note in `threadDelivered` carried it.
  threadPending: z.string().max(20_000).optional(),
})

/** A durable breadcrumb in either participant's DM for one private agent exchange. */
export const AgentRelayEventSchema = z.object({
  ...eventBase,
  type: z.literal('agent_relay'),
  agentId: z.string(),
  peerAgentId: z.string(),
  pairChatId: z.string(),
  turnId: z.string(),
  relayId: z.string(),
  phase: z.enum(['sent', 'received', 'failed']),
  preview: z.string().max(240).optional(),
})

const ThreadEventWireSchema = z.discriminatedUnion('type', [
  UserMessageEventWireSchema,
  AgentMessageEventSchema,
  ReasoningEventSchema,
  ToolUseEventSchema,
  TodoUpdateEventSchema,
  UserInputRequestEventSchema,
  UserInputResponseEventSchema,
  OutboundDraftEventSchema,
  OutboundDraftClosedEventSchema,
  OutboundDraftSubmissionEventSchema,
  OutboundDraftReopenedEventSchema,
  FileDeliveryEventSchema,
  ConnectRequestEventSchema,
  ConnectStatusEventSchema,
  ToolResultEventSchema,
  TurnResultEventSchema,
  SystemNoteEventSchema,
  AgentRelayEventSchema,
])
export const ThreadEventSchema = ThreadEventWireSchema.superRefine((event, context) => {
  if (event.type !== 'user_message' || hasAtMostMessageAttachments(event)) return
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: `images and files may contain at most ${MAX_MESSAGE_ATTACHMENTS} attachments combined`,
  })
})
export type ThreadEvent = z.infer<typeof ThreadEventSchema>

/**
 * Where a chat's rewrites stand on this server. Events are appended and, rarely,
 * rewritten in place under the same id. `rev` counts those rewrites, and `epoch`
 * names the server run that counted them, because the count lives in memory.
 */
export const EventSyncSchema = z.object({ epoch: z.string().min(1).max(64), rev: z.number().int().nonnegative() })
export type EventSync = z.infer<typeof EventSyncSchema>

// ---------------------------------------------------------------------------
// Projects and chats — the sidebar. A project is a container, a room in the
// house; a chat is one conversation inside it.
// ---------------------------------------------------------------------------

/**
 * Folders one project may link. Generous enough for a knowledge-work room that
 * spans a repo, a notes vault and an archive, low enough that the repo block and
 * the argv it becomes stay readable. The refusal names the number, so raising it
 * is one constant.
 */
export const MAX_PROJECT_FOLDERS = 8

/**
 * A small, stable catalogue rather than provider icon names on the wire. The web
 * client maps these semantic ids to HugeIcons; adding another renderer does not
 * make the stored project data depend on one icon package.
 */
export const PROJECT_ICONS = [
  'folder',
  'home',
  'briefcase',
  'book',
  'idea',
  'code',
  'calendar',
  'plane',
  'heart',
  'money',
  'camera',
  'rocket',
  'archive',
  'attachment',
  'backpack',
  'bank',
  'bicycle',
  'birthday',
  'bookmark',
  'brain',
  'building',
  'calculator',
  'call',
  'car',
  'chat',
  'checklist',
  'clock',
  'cloud',
  'coffee',
  'compass',
  'computer',
  'contacts',
  'crown',
  'dashboard',
  'database',
  'document',
  'download',
  'edit',
  'factory',
  'fire',
  'flag',
  'flower',
  'game',
  'gift',
  'globe',
  'gym',
  'key',
  'lab',
  'language',
  'laptop',
  'library',
  'link',
  'location',
  'lock',
  'mail',
  'map',
  'medal',
  'meeting',
  'microphone',
  'microscope',
  'mountain',
  'music',
  'news',
  'paint',
  'phone',
  'plant',
  'puzzle',
  'restaurant',
  'robot',
  'school',
  'search',
  'send',
  'settings',
  'shield',
  'shopping',
  'star',
  'store',
  'sun',
  'target',
  'task',
  'team',
  'telescope',
  'tools',
  'train',
  'truck',
  'umbrella',
  'upload',
  'user',
  'video',
  'wallet',
  'watch',
  'wifi',
  'wrench',
  'analytics',
  'beach',
  'cat',
  'health',
  'food',
  'nature',
  'award',
] as const
export const ProjectIconSchema = z.enum(PROJECT_ICONS)
export type ProjectIcon = z.infer<typeof ProjectIconSchema>

export const DEFAULT_PROJECT_ICON: ProjectIcon = 'folder'
export const DEFAULT_PROJECT_COLOR = '#8A8F98'
export const ProjectColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/)

/**
 * How far a room's structured memory retrieval reaches. `project` ranks the room's
 * own index, the root feedback refs and projects named literally in the question.
 * `knowledge` ranks every structured index, one ranker call per index, for the
 * planning and cross-project room. Decided on 2026-09-17: an explicit room
 * setting, never inferred from the room's name or its linked folders.
 */
export const ProjectMemoryScopeSchema = z.enum(['project', 'knowledge'])
export type ProjectMemoryScope = z.infer<typeof ProjectMemoryScopeSchema>

/**
 * The room a Session, a run or handed-over work is in when it has no project: the
 * memory system itself. It is not a project the user made and never a stored row, so
 * no project list holds it and nothing renames or deletes it. The server answers for
 * this id with the memory folder and the widest memory reach; clients say "No project".
 */
export const HOME_PROJECT_ID = 'home'
/** What the server calls that room where a name is needed, such as a work proposal. */
export const HOME_PROJECT_NAME = 'No project'

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: ProjectIconSchema.default(DEFAULT_PROJECT_ICON),
  color: ProjectColorSchema.default(DEFAULT_PROJECT_COLOR),
  memoryScope: ProjectMemoryScopeSchema.default('project'),
  // Absolute paths to folders on the machine Manor runs on; empty for the ordinary
  // case. Decided on 2026-08-06: a linked folder is the real working copy and
  // personas get full access to it, not a read-only copy. Every chat in the project
  // gets them as additional working directories; the chat's own scratch cwd stays
  // what it was. Always an array, so "no folder" has exactly one representation.
  repoPaths: z.array(z.string()).default([]),
  // The project's one curated thread (decided 2026-10-10). The sidebar lists a project
  // whose thread is live. Hiding it archives the thread and keeps this link, so adding
  // the project back restores the same conversation (2026-11-12). Optional rather than a
  // chat kind, because an older phone drops a directory whose enum it does not know but
  // strips a field it does not know.
  threadChatId: z.string().optional(),
  // A folder the user took off the new-Session picker (2026-11-13). Only a folder, a
  // project without a thread, carries it. Its Sessions keep the folder as their room,
  // and adding the same folder again lists it once more.
  unlisted: z.literal(true).optional(),
})
export type Project = z.infer<typeof ProjectSchema>

/**
 * A folder is a project row that never got a thread (2026-11-13): a place to start
 * Sessions in, with no thread, context, notes or preferences, never listed under
 * Projects. A hidden project keeps its archived thread's id, so the two stay apart.
 * Giving a folder a thread (`create_project_thread`) makes it a project.
 */
export const isFolder = (project: Pick<Project, 'threadChatId'>): boolean => project.threadChatId === undefined


/** The thread a project chat belongs to as its curator, or undefined. */
export const projectThreadOf = (projects: readonly Project[], chat: { id: string; projectId: string | null }): Project | undefined =>
  chat.projectId === null ? undefined : projects.find((project) => project.id === chat.projectId && project.threadChatId === chat.id)

/** A session the project thread started: its handoff's source is that project's thread. */
export const threadStartedHandoff = (
  projects: readonly Project[],
  handoffs: readonly WorkHandoff[],
  chatId: string,
): WorkHandoff | undefined => handoffs.find((handoff) => handoff.workChatId === chatId &&
  projects.some((project) => project.id === handoff.projectId && project.threadChatId !== undefined && project.threadChatId === handoff.sourceChatId))

// ---------------------------------------------------------------------------
// Subagents
// ---------------------------------------------------------------------------

/** Concurrent children one parent chat may have running at once, upper bound for the setting. */
export const SUBAGENT_MAX_CONCURRENT_LIMIT = 8
/** A child is depth 1; with delegation allowed it may start depth 2 children, never deeper. */
export const SUBAGENT_MAX_DEPTH = 2

export const SubagentStateSchema = z.enum(['running', 'done', 'failed', 'cancelled'])
export type SubagentState = z.infer<typeof SubagentStateSchema>

/**
 * What Manor allows `delegate_task` to start, set once in Settings. A persona entry
 * can only narrow the global lists: the effective set is their intersection, and a
 * model can only run at the levels its own catalog row honours. A request outside
 * that set is refused with the reason, never quietly lowered.
 */
export const SubagentPolicySchema = z.object({
  models: z.array(z.string().min(1).max(100)).max(200),
  efforts: z.array(EffortSchema).max(EffortSchema.options.length),
  maxConcurrent: z.number().int().min(1).max(SUBAGENT_MAX_CONCURRENT_LIMIT),
  allowNested: z.boolean(),
  personas: z.record(z.string(), z.object({
    models: z.array(z.string().min(1).max(100)).max(200).optional(),
    efforts: z.array(EffortSchema).max(EffortSchema.options.length).optional(),
  })),
}).superRefine((policy, context) => {
  const unknown = [...policy.models, ...Object.values(policy.personas).flatMap((entry) => entry.models ?? [])]
    .find((model) => !isCatalogModel(model))
  if (unknown !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `${unknown} is not a model Manor runs`, path: ['models'] })
  }
})
export type SubagentPolicy = z.infer<typeof SubagentPolicySchema>

/** What a save carries on the wire: loose, so a bad policy gets its reason back instead of a dropped frame. */
export const SubagentPolicyDraftSchema = z.object({
  models: z.array(z.string()),
  efforts: z.array(z.string()),
  maxConcurrent: z.number(),
  allowNested: z.boolean(),
  personas: z.record(z.string(), z.object({ models: z.array(z.string()).optional(), efforts: z.array(z.string()).optional() })),
})

/** Every catalog model, the levels most work needs, three at a time, no grandchildren. */
export const DEFAULT_SUBAGENT_POLICY: SubagentPolicy = {
  models: (['claude', 'codex', 'grok', 'cursor'] as const).flatMap((driver) => MODELS[driver].map((option) => option.value)),
  efforts: ['low', 'medium', 'high'],
  maxConcurrent: 3,
  allowNested: false,
  personas: {},
}

/**
 * The user as the app shows them: the rail's face and the popover's header. Display only;
 * the label agents read in their transcripts stays the server's own.
 */
export const UserProfileSchema = z.object({
  name: z.string().trim().min(1, 'A name is needed.').max(80),
  /** A shrunk picture as a data URL, like an agent's. Absent means the bundled photo. */
  avatar: z.string().max(400_000).optional(),
})
export type UserProfile = z.infer<typeof UserProfileSchema>

/** What the app shows until the user has given a name. It also means "no name yet" wherever a name is asked for. */
export const DEFAULT_USER_PROFILE: UserProfile = { name: 'You' }

const DAY_MS = 24 * 60 * 60 * 1000

/** Days as milliseconds, for the house settings that count in days. */
export const daysToMs = (days: number) => days * DAY_MS

/**
 * Household settings the user changes in Settings, kept as one record so a new knob is a
 * key with a default here, not a new message, store method and record. Every default
 * is the behaviour Manor had before the knob existed, so an install that never saved
 * the settings keeps that behaviour, and a record saved before a key existed reads the
 * key's default. Counts are days; null means never where a key allows it.
 */
/** An absolute folder path, or one under the home folder written with a leading `~`. */
const FolderSettingSchema = z.string().trim().max(1024)
  .refine((value) => value.startsWith('/') || value === '~' || value.startsWith('~/'), 'Give the full path of a folder.')
  .nullable().default(null)

/** What the Knowledge note AI runs on until the user picks something else in Settings. */
export const NOTE_AI_DEFAULTS = { model: 'claude-sonnet-5-5', effort: 'medium' } as const satisfies {
  model: string
  effort: Effort
}

/**
 * The longest note the composer edits whole. The edited note comes back as one model
 * reply, so the bound is what a reply carries with room to spare, not what the vault
 * stores. A selection in a longer note still works: only the passage comes back.
 */
export const NOTE_AI_MAX_CHARS = 40_000

export const HouseSettingsSchema = z.object({
  /** A project chat quiet this long is settled. Null leaves every chat where it is. */
  autoSettleDays: z.number().int().min(1).max(90).nullable().default(2),
  /**
   * An archived chat stays restorable this long, then it is deleted. No null: the
   * archive is a waiting room, not a second inbox.
   */
  archiveRetentionDays: z.number().int().min(3).max(90).default(10),
  /** Picture copies agents read from a chat's working folder. Null keeps them. */
  attachmentRetentionDays: z.number().int().min(1).max(365).nullable().default(7),
  /** Nightly database copies. Null keeps every copy. */
  backupRetentionDays: z.number().int().min(1).max(365).nullable().default(14),
  /**
   * Where memory lives, when the user picked a folder in Settings. Null is the default
   * folder in the data directory. Read when the server starts; the environment
   * variable of the same purpose wins over it.
   */
  memoryDir: FolderSettingSchema,
  /** Where the Knowledge notes live, under the same rules as the memory folder. */
  knowledgeDir: FolderSettingSchema,
  /** The model and effort behind a note's comments and its composer. No tools, no persona. */
  noteAiModel: z.string().trim().min(1).max(120).default(NOTE_AI_DEFAULTS.model),
  noteAiEffort: EffortSchema.default(NOTE_AI_DEFAULTS.effort),
})
export type HouseSettings = z.infer<typeof HouseSettingsSchema>

export const DEFAULT_HOUSE_SETTINGS: HouseSettings = HouseSettingsSchema.parse({})

/**
 * The standing context files Settings edits, all in the memory folder. Claude Code,
 * Codex and Grok load the same files, so this list is closed rather than a path field.
 */
export const CONTEXT_FILE_NAMES = ['soul.md', 'rules.md', 'style.md', 'thinking.md', 'user-core.md'] as const
export const ContextFileNameSchema = z.enum(CONTEXT_FILE_NAMES)
export type ContextFileName = z.infer<typeof ContextFileNameSchema>

export const ContextFileSchema = z.object({
  name: ContextFileNameSchema,
  content: z.string(),
  /** The disk version this content is. A save names the one it started from. */
  hash: z.string(),
  updatedAt: z.string(),
})
export type ContextFile = z.infer<typeof ContextFileSchema>

/** Why the files may be unreadable: relay mode has no local checkout to edit. */
export const ContextFilesSchema = z.object({
  root: z.string().nullable(),
  files: z.array(ContextFileSchema),
})
export type ContextFiles = z.infer<typeof ContextFilesSchema>

/** What the Mac is running, for About, Providers and Memory & vault. Read-only. */
/**
 * How a folder shown in Settings relates to its setting. `pinned` means an environment
 * variable decides it, so the app cannot change it. `pending` is the folder the next
 * start will use when that differs from the one in use now.
 */
const folderState = {
  pinned: z.boolean().default(false),
  pending: z.string().nullable().default(null),
}

export const SystemInfoSchema = z.object({
  version: z.string(),
  commit: z.string().nullable(),
  startedAt: z.string(),
  providers: z.array(z.object({
    driver: DriverSchema,
    command: z.string(),
    version: z.string().nullable(),
  })),
  memory: z.object({ path: z.string().nullable(), ...folderState }),
  vault: z.object({ path: z.string().nullable(), ...folderState }),
  logs: z.array(z.object({ label: z.string(), path: z.string() })),
})
export type SystemInfo = z.infer<typeof SystemInfoSchema>

const isCatalogModel = (model: string): boolean => {
  const driver = driverForModel(model)
  return driver !== undefined && driver !== 'mock' && MODELS[driver].some((option) => option.value === model)
}

/** One model a persona's subagents may run, with the levels left after every narrowing. */
export interface SubagentChoice {
  driver: DriverName
  model: string
  label: string
  efforts: Effort[]
}

/** The effective set for one persona, in catalog order; a model with no level left is not a choice. */
export function subagentChoices(policy: SubagentPolicy, agentId: string): SubagentChoice[] {
  const own = policy.personas[agentId]
  const efforts = policy.efforts.filter((effort) => own?.efforts === undefined || own.efforts.includes(effort))
  return (['claude', 'codex', 'grok', 'cursor'] as const).flatMap((driver) => MODELS[driver]
    .filter((option) => policy.models.includes(option.value) && (own?.models === undefined || own.models.includes(option.value)))
    .map((option) => ({
      driver,
      model: option.value,
      label: option.label,
      efforts: effortsFor(driver, option.value).map((level) => level.value).filter((level) => efforts.includes(level)),
    }))
    .filter((choice) => choice.efforts.length > 0))
}

/** Allowed, with the provider that runs it, or refused with a reason the calling agent can act on. */
export function checkSubagentChoice(
  policy: SubagentPolicy,
  agentId: string,
  model: string,
  effort: string,
): { ok: true; driver: DriverName; effort: Effort } | { ok: false; reason: string } {
  if (!isCatalogModel(model)) return { ok: false, reason: `${model} is not a model Manor runs.` }
  const driver = driverForModel(model)!
  if (!policy.models.includes(model)) return { ok: false, reason: `${model} is not allowed for subagents in Settings.` }
  const own = policy.personas[agentId]
  if (own?.models !== undefined && !own.models.includes(model)) {
    return { ok: false, reason: `${model} is not allowed for this agent's subagents.` }
  }
  const level = EffortSchema.safeParse(effort)
  if (!level.success) return { ok: false, reason: `${effort} is not an effort level; use low, medium, high, xhigh or max.` }
  const supported = effortsFor(driver, model).map((option) => option.value)
  if (!supported.includes(level.data)) {
    return { ok: false, reason: `${model} does not support ${effort} effort; it takes ${supported.join(', ')}.` }
  }
  if (!policy.efforts.includes(level.data)) return { ok: false, reason: `${effort} effort is not allowed for subagents in Settings.` }
  if (own?.efforts !== undefined && !own.efforts.includes(level.data)) {
    return { ok: false, reason: `${effort} effort is not allowed for this agent's subagents.` }
  }
  return { ok: true, driver, effort: level.data }
}

/**
 * The child half of a `subagent` chat: who started it, on what, and how it ended.
 * The chat's own `parentChatId` and `title` carry the rest.
 */
export const SubagentChildSchema = z.object({
  // The persona whose turn delegated, and that turn. Only that persona may collect
  // the result or cancel it from a later turn.
  agentId: z.string(),
  turnId: z.string(),
  // The launch row in the parent transcript, which opens this child's view.
  toolCallId: z.string(),
  driver: DriverSchema,
  model: z.string().max(100),
  effort: EffortSchema,
  role: z.string().max(2_000).optional(),
  review: z.literal(true).optional(),
  state: SubagentStateSchema,
  // Why it failed or was cancelled, in a sentence the user and the parent can both read.
  reason: z.string().max(500).optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  depth: z.number().int().min(1).max(SUBAGENT_MAX_DEPTH),
})
export type SubagentChild = z.infer<typeof SubagentChildSchema>

/** One child as the sidebar needs it, without opening its thread. */
export const SubagentSummarySchema = SubagentChildSchema.extend({
  // The child thread's chat id, which is also the task id the parent collects with.
  id: z.string(),
  parentChatId: z.string(),
  title: z.string(),
  // Its oldest open question. The user answers it in the parent, never in the child's view.
  ask: z.object({ requestId: z.string(), questions: UserInputQuestionsSchema }).optional(),
})
export type SubagentSummary = z.infer<typeof SubagentSummarySchema>

/**
 * A helper a provider runs inside its own turn: Claude's Task, Codex's spawn_agent,
 * Cursor's and Grok's own. It has no thread, model or effort Manor chose, so it is not
 * a `SubagentSummary`; its record is the launch row in the transcript of the chat
 * whose turn started it, and the sidebar lists it only while it runs.
 */
export const NativeSubagentSchema = SubagentSummarySchema.pick({
  parentChatId: true,
  agentId: true,
  turnId: true,
  toolCallId: true,
  driver: true,
  title: true,
  startedAt: true,
})
export type NativeSubagent = z.infer<typeof NativeSubagentSchema>

/**
 * Where a chat lives. `project` is the original kind and still the default: it sits in
 * a project and derives who is in it from the transcript. `dm` and `group` are home
 * scope — no project, and an invited membership carried on the chat itself. `run` is
 * one firing of a routine: a project chat in every respect except that it is listed
 * under its routine rather than in the sidebar tree. `browser` is a session beside the
 * Browser surface: home scope like a dm, open to the house like a project chat, and its
 * browser tools act on the app-owned tab set (`BROWSER_HOME_SESSION_ID`), not its own.
 * `subagent` is one delegated task's child thread: read-only, hanging off the chat that
 * started it, and never in the directory's chat list (the sidebar reads its summary).
 */
export const ChatKindSchema = z.enum(['project', 'dm', 'group', 'run', 'side', 'pair', 'browser', 'subagent'])
export type ChatKind = z.infer<typeof ChatKindSchema>

/** How long an archived project thread remains restorable before hard deletion. */
export const ARCHIVE_RETENTION_MS = daysToMs(DEFAULT_HOUSE_SETTINGS.archiveRetentionDays)

/**
 * Whether every persona in the house may speak here.
 *
 * A project chat has no membership and derives who is in it from the transcript, and a
 * run is a project chat in this respect: it is one firing of a routine inside a room,
 * not an invited conversation. A dm, a group and a side chat carry their invited set
 * instead, and nobody outside it ever gets a turn — not by mention, not by delegation.
 * Named once because the routing filter, the household block in the prompt and both
 * stores' idea of who is in a chat all have to agree.
 */
export const isOpenRoom = (chat: { kind: ChatKind; mode?: ChatMode }): boolean =>
  chat.mode !== 'single' && (chat.kind === 'project' || chat.kind === 'run' || chat.kind === 'browser')

/**
 * Whether this room has exactly one fixed addressee, so nothing in a message routes.
 *
 * A DM is one by definition and a side chat is one by construction: it holds a single
 * voice answering questions about the chat it hangs off. Typed `@Name` text is read as
 * text in both, because treating it as routing is what would turn either back into a
 * group through an older client or a pasted message.
 */
export const isSoloRoom = (chat: { kind: ChatKind; mode?: ChatMode }): boolean =>
  chat.mode === 'single' || chat.kind === 'dm' || chat.kind === 'side'

/** A standing, user-readable channel whose only writers are its two personas. */
export const isPairRoom = (chat: { kind: ChatKind }): boolean => chat.kind === 'pair'

/**
 * The side chat's speaker, as the transcript and the panel both need it.
 *
 * A constant rather than a roster row (decided 2026-08-17, superseding the hidden
 * `aside` persona): the panel is a model with an effort, not a member of the
 * household, so there is nothing to configure per persona and nothing to keep out of
 * the mention menu. The id is what `agent_message.agentId` carries in a panel's
 * transcript; it resolves against no roster, which is why the name and colour live
 * here where the client can read them too.
 */
export const SIDE_CHAT_VOICE = { id: 'aside', name: 'Side chat', color: '#7C8DA6' } as const

/** What a side chat runs on until somebody picks something else. */
export const SIDE_CHAT_DEFAULTS = { model: 'claude-sonnet-5-5', effort: 'medium' } as const satisfies {
  model: string
  effort: Effort
}

/**
 * The voice that speaks in a child thread. A constant like the side chat's, because a
 * child is a model with an effort working for a persona, not a member of the house.
 */
export const SUBAGENT_VOICE = { id: 'subagent', name: 'Subagent', color: SIDE_CHAT_VOICE.color } as const

/**
 * How this chat sees the project's linked folders. `mode` is derived from the
 * mapping: empty is `current`, any row is `worktree`. Not a column on `chats`.
 */
export const ChatCheckoutSchema = z.object({
  mode: z.enum(['current', 'worktree']),
  branch: z.string().nullable(),
})
export type ChatCheckout = z.infer<typeof ChatCheckoutSchema>

/** The resting state, and what an older client that never sent a checkout meant. */
export const CURRENT_CHECKOUT: ChatCheckout = { mode: 'current', branch: null }

/** Empty mapping is current checkout. Any row is isolated, on that row's branch. */
export function checkoutFromMapping(rows: readonly { branch: string }[]): ChatCheckout {
  const first = rows[0]
  return first === undefined ? CURRENT_CHECKOUT : { mode: 'worktree', branch: first.branch }
}

/**
 * What `create_chat` and `set_chat_checkout` ask for. Worktree may name a branch;
 * omitted means the auto name on create, or resume-the-leftover on switch.
 */
export const CheckoutRequestSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('current') }),
  z.object({ mode: z.literal('worktree'), branch: z.string().min(1).max(200).optional() }),
])
export type CheckoutRequest = z.infer<typeof CheckoutRequestSchema>

/**
 * One local branch the checkout menu may name. Unavailable is a refusal git would
 * make (already checked out elsewhere, or missing from a live worktree), so the
 * menu greys it instead of offering it. `home` is the linked folders' own checkout:
 * git will not check that name out a second time, so from isolation the legal pick
 * is returning to current checkout, not a greyed dead end.
 */
export const CheckoutBranchSchema = z.object({
  name: z.string(),
  available: z.boolean(),
  reason: z.string().optional(),
  home: z.boolean().optional(),
})
export type CheckoutBranch = z.infer<typeof CheckoutBranchSchema>

/** How many files one Session diff carries; past it the diff says it is partial. */
export const MAX_SESSION_DIFF_FILES = 1_000

/** A file this Session would land, or one it left uncommitted, with Git's own counts. */
export const SessionFileStatSchema = z.object({
  path: z.string().max(1_024),
  oldPath: z.string().max(1_024).optional(),
  status: z.enum(['created', 'deleted', 'edited']),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
})
export type SessionFileStat = z.infer<typeof SessionFileStatSchema>

/**
 * One git folder of a Session's checkout: the branch it is on, where a worktree merges,
 * how far it is ahead of its remote and which of this Session's files are uncommitted.
 * `root` is the absolute folder and the handle Commit and Push name it by.
 */
export const SessionRepoSchema = z.object({
  root: z.string(),
  label: z.string(),
  branch: z.string().nullable(),
  // A worktree Session's merge target: the branch its linked folder is on.
  mergeTarget: z.string().optional(),
  // `origin/main` for a tracked branch; the bare remote name when Push would create it there.
  pushTarget: z.string().optional(),
  // Commits Push would send. Zero hides Push.
  ahead: z.number().int().nonnegative(),
  uncommitted: z.array(SessionFileStatSchema).max(MAX_SESSION_DIFF_FILES),
  // The repository the branch pushes to, `owner/repo` on a known host and the folder's
  // name otherwise, with its web page where there is one. Never carries credentials.
  remote: z.object({ name: z.string().max(300), url: z.string().url().max(2_000).optional() }).optional(),
})
export type SessionRepo = z.infer<typeof SessionRepoSchema>

/** One hunk as Git wrote it: each line keeps its ` `, `+` or `-` prefix. */
export const SessionDiffHunkSchema = z.object({
  oldStart: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  lines: z.array(z.string()),
})
export type SessionDiffHunk = z.infer<typeof SessionDiffHunkSchema>

export const SessionDiffFileSchema = SessionFileStatSchema.extend({
  root: z.string(),
  // What the Files panel and an `@` reference open; absent for a file the panel cannot show.
  panelPath: z.string().max(1_024).optional(),
  binary: z.literal(true).optional(),
  hunks: z.array(SessionDiffHunkSchema),
  // The size limits cut this file's hunks, or left them out.
  truncated: z.literal(true).optional(),
  // Changed in the Session but not part of the result waiting for Confirm, which leaves
  // it out. Clients list these under Not included.
  excluded: z.literal(true).optional(),
})
export type SessionDiffFile = z.infer<typeof SessionDiffFileSchema>

export const ChatSchema = z.object({
  id: z.string(),
  // Null for a home-scope chat. A DM and a group belong to the household rather than
  // to a room, so they have no folders and no project memory layer.
  projectId: z.string().nullable(),
  kind: ChatKindSchema.default('project'),
  // Absent on historical rows and older servers means house. Only project chats
  // may select single; the mode has no mutation command.
  mode: ChatModeSchema.optional(),
  // Captured once for accepted, unfinished Sessions by the placement migration.
  // No client command can grant or expand this exception.
  legacySessionAgentIds: z.array(z.string()).optional(),
  // Selected provider for a single chat, derived from its runtime pin on listing.
  // Available without opening the transcript; absent for house chats or a missing pin.
  singleDriver: DriverSchema.optional(),
  // The rest of that pin (model, effort, speed), so a hover can name the model a
  // single chat runs on without opening it. Same derivation, same absence rules.
  singleOverride: ChatOverrideSchema.optional(),
  // The routine this chat is a run of, null for every chat a person started. The
  // ownership runs one way only: deleting a routine takes its runs, deleting one run
  // thread says nothing about the routine that wrote it.
  routineId: z.string().nullable().default(null),
  // The chat a side chat or a subagent's child thread hangs off, null for every other
  // kind. One way only, the way a run points at its routine: a side chat reads its
  // parent's transcript as context and never writes a word back into it.
  parentChatId: z.string().nullable().default(null),
  // Only on a `subagent` chat: who started the child, on what, and how it ended.
  subagent: SubagentChildSchema.optional(),
  // The invited personas of a dm (one), group (two or more), or pair (exactly two);
  // empty for a project
  // chat, which keeps deriving its participants from what the transcript shows, and
  // for a side chat, which holds a model rather than a member.
  memberIds: z.array(z.string()).default([]),
  // What answers in a side chat, null everywhere else and null for one that has never
  // been set (`SIDE_CHAT_DEFAULTS` applies then, so moving the default moves every
  // panel that never chose). The provider is derived from the model, because a side
  // chat is a model and an effort and nothing else picks one.
  sideModel: z.string().nullable().default(null),
  sideEffort: EffortSchema.nullable().default(null),
  // The last thing said in this chat, one line, cut short, for the sidebar. Derived on
  // every listing rather than stored, so it cannot disagree with the transcript.
  lastMessagePreview: z.string().nullable().default(null),
  title: z.string(),
  // Epoch ms of the moment this thread was created. Unlike `lastMessageAt`, this
  // never moves when somebody follows up, so routine histories can keep execution
  // order and dates stable after a conversation continues inside an older run.
  createdAt: z.number(),
  // Epoch ms of the last event in this chat, creation time for one that has none.
  // The sidebar orders on it, newest first, so picking up an old conversation puts
  // it back on top. Same unit as `ThreadEvent.ts`, so the client can bump it from a
  // live event without waiting for the server to resend the directory.
  lastMessageAt: z.number(),
  // Epoch ms of the moment this chat was settled, null while it still wants
  // attention. Only the inbox reads it, and only the user writes it: a settled chat
  // that receives a new turn stays settled, so the list is one the user empties rather
  // than one Manor refills.
  settledAt: z.number().nullable(),
  // Epoch ms of the moment this chat was archived, null while it belongs in the
  // ordinary lists. Archiving keeps the transcript and runtime rows intact; it is
  // only a reversible navigation state.
  archivedAt: z.number().nullable(),
  // The personas that have spoken or worked in this chat, most recent first. Derived
  // from the transcript rather than stored, so it is right for a chat whose driver
  // never handed back a session. Defaulted, because an older server that does not
  // send it should leave a chat without avatars rather than without a sidebar row.
  // For a dm or a group it is `memberIds` instead: invited beats spoken, so a group's
  // avatars are complete from the moment it is made rather than filling in per reply.
  agentIds: z.array(z.string()).default([]),
  // Derived from `chat_worktrees`. Empty mapping is current checkout. The branch on
  // a worktree row is stored; on current checkout it is the live branch of the first
  // git folder, display only, or null when that has not been read yet.
  checkout: ChatCheckoutSchema.default({ mode: 'current', branch: null }),
})
export type Chat = z.infer<typeof ChatSchema>

/**
 * The persona a project thread proposes as a Session's lead, and the engineer the Auto
 * pin treats as one half of the Session pair, on the install that has it.
 */
export const SESSION_DEFAULT_AGENT_ID = 'wren'

/**
 * Who stands in for a Session's missing lead where the chief of staff does not fit:
 * the Session persona (placement `session`) this chat seats. The install's default
 * Session agent (`SESSION_DEFAULT_AGENT_ID`) wins when it qualifies, any other install
 * gets the first in roster order. Server routing and the composer label both read it.
 */
export function sessionFallbackAgent<T extends AgentConfig>(
  agents: readonly T[],
  chat: Pick<Chat, 'kind' | 'mode' | 'legacySessionAgentIds'>,
): T | undefined {
  const seated = agents.filter((agent) => agent.placement === 'session' && agentFitsChat(agent, chat))
  return seated.find((agent) => agent.id === SESSION_DEFAULT_AGENT_ID) ?? seated[0]
}

/** Placement only; callers still enforce membership and summon authority. */
export function agentFitsChat(agent: AgentConfig, chat: Pick<Chat, 'kind' | 'mode' | 'legacySessionAgentIds'>): boolean {
  if (chat.mode === 'single' || chat.kind === 'side' || chat.kind === 'subagent') return false
  if (chat.kind === 'project') {
    if (chat.legacySessionAgentIds !== undefined) return chat.legacySessionAgentIds.includes(agent.id)
    return agent.placement !== 'chat'
  }
  return agent.placement !== 'session'
}

export const WorkHandoffStateSchema = z.enum(['active', 'settled', 'deleted'])
export type WorkHandoffState = z.infer<typeof WorkHandoffStateSchema>

/**
 * A picture or text file a proposal carries from the conversation it came from
 * (2026-10-14): an image on a message, a text file the user attached, or a file a persona
 * delivered. Only the pointer travels with the handoff; the bytes stay in that chat
 * until Manor copies them onto the thread's brief and the Session's kickoff.
 */
export const WorkAttachmentSchema = z.object({
  name: z.string().min(1).max(160),
  kind: z.enum(['image', 'file']),
  chatId: z.string(),
  eventId: z.string(),
  /** The image or file's place on its message; absent for a delivered file. */
  index: z.number().int().nonnegative().optional(),
})
export type WorkAttachment = z.infer<typeof WorkAttachmentSchema>

/** Durable provenance between an endless Chat and one bounded project Work thread. */
export const WorkHandoffSchema = z.object({
  id: z.string(),
  sourceChatId: z.string(),
  sourceTurnId: z.string(),
  assignmentKey: z.string().optional(),
  // Mode-neutral task; the executable kickoff is composed only at Accept.
  task: z.string().optional(),
  // One sentence naming the goal, for the proposal card; older proposals fall back to task.
  summary: z.string().optional(),
  // Legacy proposals stored a prewritten kickoff.
  kickoff: z.string().optional(),
  authorAgentId: z.string().optional(),
  workChatId: z.string().nullable(),
  projectId: z.string(),
  projectName: z.string(),
  title: z.string(),
  leadAgentId: z.string(),
  leadAgentName: z.string(),
  firstExecutor: z.object({ agentId: z.string().min(1), agentName: z.string().min(1) }).optional(),
  supportingAgentIds: z.array(z.string()),
  supportingAgentNames: z.array(z.string()),
  // The Single runtime a project thread proposed for this card, with its one-line reason
  // (2026-10-11). The card opens on it; the user's choice at Accept still wins.
  proposedRuntime: z.object({ runtime: SingleRuntimeSchema, reason: z.string() }).optional(),
  // What the author attached with `start_work`; the card names them before Accept.
  attachments: z.array(WorkAttachmentSchema).max(MAX_MESSAGE_ATTACHMENTS).optional(),
  state: WorkHandoffStateSchema,
  result: z.string().nullable(),
  resultAt: z.number().nullable(),
  version: z.number().int().nonnegative(),
  // The proposal's own number, shown as v2, v3: a later `start_work` with the same
  // assignmentKey while this one waited for Accept replaced it. Absent is the first.
  // Not `version`, which counts every lifecycle write of one handoff.
  revision: z.number().int().positive().optional(),
  // The proposal that replaced this one before Accept. Such a handoff is settled and
  // refuses Accept and Reject; clients point at the replacement instead.
  supersededById: z.string().optional(),
  createdAt: z.number(),
  // Null until Accept. Settled remains Reject; this is not a fourth handoff state.
  acceptedAt: z.number().nullable().default(null),
  // Each shared-checkout repo's branch at Accept. A result or Confirm on another branch
  // is refused, so Manor's commit lands where the Session started. Absent for worktrees.
  startBranches: z.array(z.object({ path: z.string(), branch: z.string() })).optional(),
  // The current result. A new user message after Confirm reopens the goal.
  goalReachedAt: z.number().optional(),
  goalReport: GoalReportSchema.optional(),
  goalChangedFiles: z.array(z.string()).optional(),
  // Acceptance authorizes the lead's commit request; it does not prove it succeeded or settle.
  goalConfirmedAt: z.number().optional(),
  goalCompletion: WorkCompletionSchema.optional(),
  // Prior confirmed rounds, including Git's commit/merge record. Reopening only clears current state.
  goalConfirmations: z.array(z.object({
    confirmedAt: z.number(), version: z.number().int().nonnegative(),
    completion: WorkCompletionSchema.optional(),
  })).optional(),
  // When the user took a confirmed Session back out of Settled (2026-10-12). A confirmed
  // result counts as settled on its own, so without this it would snap back on the
  // next snapshot. Settling again clears it.
  unsettledAt: z.number().optional(),
  // A DM brief for a project with a thread is handed to that thread at Accept instead of
  // creating the session (2026-10-10): `forwardedAt` stamps the hand-over and
  // `threadHandoffId` names the session card the thread then started; that card carries
  // `brief-<id>` as its assignmentKey. `forwardAccept` keeps the choices the user made at
  // that Accept, so the thread's card starts with them even after a restart; the
  // approved prompt is the brief's own `task`.
  forwardedAt: z.number().optional(),
  forwardAccept: z.object({
    mode: ChatModeSchema.optional(),
    runtime: SingleRuntimeSchema.optional(),
    checkout: CheckoutRequestSchema.optional(),
  }).optional(),
  threadHandoffId: z.string().optional(),
})
export type WorkHandoff = z.infer<typeof WorkHandoffSchema>

/**
 * Whether a proposal names a Session persona to lead it. A project thread that names
 * nobody, on an install without a default Session persona, stores an empty lead: the
 * card can run as Single only, since Multiple has nobody to start.
 */
export const workHandoffHasLead = (handoff: Pick<WorkHandoff, 'leadAgentId'>): boolean => handoff.leadAgentId !== ''

// ---------------------------------------------------------------------------
// Routines — a chat turn that fires on a schedule (decided 2026-08-12,
// `.claude/plans/2026-08-12-routines.md`).
//
// A routine is a row, not a subsystem: when it is due the server injects an ordinary
// user message addressed to `agentId`. A project target gets a new run chat; a direct
// message target continues its existing chat and session. Both use the same turn path.
//
// A run is its own thread and the routine owns it (changed 2026-08-16,
// `.claude/plans/2026-08-16-routine-runs.md`). The routine named one chat until then
// and every run appended to it, which stacked a year of a daily routine into one
// context window.
// ---------------------------------------------------------------------------

/** What a firing routine does; see `Routine.action`. */
export const RoutineActionSchema = z.enum(['run', 'remind'])
export type RoutineAction = z.infer<typeof RoutineActionSchema>

/** How a one-time routine ended; see `Routine.endState`. */
export const RoutineEndStateSchema = z.enum(['done', 'failed', 'expired', 'cancelled'])
export type RoutineEndState = z.infer<typeof RoutineEndStateSchema>

/**
 * How far past `runAt` a one-time fire may land and still read as on time. The tick
 * is thirty seconds, so anything past this was a Mac asleep or a server down.
 */
export const ROUTINE_LATE_AFTER_MS = 2 * 60 * 1000

/** The compact run history is deliberately bounded rather than paginated. */
export const ROUTINE_HISTORY_LIMIT = 20

/**
 * How many unread runs one routine keeps. Past this the oldest count as read: a
 * backlog that long is not read one row at a time, and every unread run is also
 * sent with the history, so the cap bounds that payload too.
 */
export const ROUTINE_UNREAD_LIMIT = 50

/** How much of a run's result travels with the history; the thread keeps the rest. */
export const ROUTINE_RESULT_MAX_CHARS = 8000

const RoutineShapeSchema = z.object({
  id: z.string(),
  // The room this routine's runs are created in, or null for a continuing DM target.
  projectId: z.string().nullable(),
  // The continuing direct message this routine appends to, instead of creating a run
  // thread. Single-agent routines may leave both targets null.
  chatId: z.string().nullable().default(null),
  // The addressed persona, or SINGLE_CHAT_VOICE.id for a single-agent run.
  // Single runs require model and effort; the provider is derived from the model.
  agentId: z.string(),
  // What the row is called in the Routines view and in the transcript line the
  // turn is announced with. Not the prompt: "Morning brief" reads, the prompt does not.
  name: z.string(),
  // One sentence for the management surfaces. Separate from the prompt: the prompt
  // tells the persona what to do, while this tells the user why the routine exists.
  description: z.string().max(500).default(''),
  // The text injected as the user message. It is the whole instruction; a routine
  // turn has nobody in the room to ask a follow-up question of.
  prompt: z.string(),
  // A cron string, plus the zone it means. The presets in the UI are a client-side
  // writer of this one field: two representations of one schedule would be two
  // things to keep in agreement, and the cron escape hatch would have nowhere to live.
  // Empty for a one-time routine, which schedules by `runAt` instead.
  cron: z.string(),
  // IANA name, so the next fire survives the October change. A 07:00 routine that
  // silently becomes 06:00 for half the year is the failure this field prevents.
  timezone: z.string().default('Europe/Amsterdam'),
  /**
   * The one moment a one-time routine fires, null for a recurring one. A one-time
   * routine fires at most once: the claim clears `nextRunAt`, and the run's end is
   * written to `endState` rather than left for a model to switch off.
   */
  runAt: z.number().nullable().default(null),
  /**
   * One-time only: the last moment a late fire is still worth running. A Mac that
   * slept through `runAt` fires on wake; past this the routine ends `expired` with a
   * visible line instead. Null means a late fire always runs once.
   */
  lateUntil: z.number().nullable().default(null),
  /**
   * `run` starts an ordinary persona turn. `remind` posts the prompt verbatim as the
   * persona's message without a model call, for a literal reminder in a DM.
   */
  action: RoutineActionSchema.default('run'),
  enabled: z.boolean().default(true),
  /**
   * Whether a finished run wants the user.
   *
   * False, the default, means the run's chat is born settled: it exists and is
   * readable under the routine, and never enters the inbox. True means it lands
   * unread like any other work. A switch rather than something read off the run's own
   * prose — "Needs your call" in an answer is intent inferred from text, and a routine
   * that can say so about itself needs no inference.
   */
  notify: z.boolean().default(false),
  /**
   * The model and the reasoning effort this routine's runs pin, null for the
   * persona's own.
   *
   * Deliberately the same pin `chat_overrides` already holds rather than a second
   * kind: the scheduler writes these onto each run thread as an ordinary override, so
   * a routine turn is composed by exactly the path a hand-pinned chat is. Null by
   * default, because pinning a routine to today's model on creation would quietly
   * outlive the next roster change.
   */
  model: z.string().nullable().default(null),
  effort: EffortSchema.nullable().default(null),
  // Epoch ms, like every other time on the wire. Null while the routine is
  // disabled: a disabled row with a future fire time would read as armed.
  nextRunAt: z.number().nullable(),
  lastRunAt: z.number().nullable(),
  // When the grace window dropped a run instead of firing it. Stamped rather than
  // left silent, because an invisible skip reads as a run that happened.
  lastSkippedAt: z.number().nullable(),
  // Runs with no `turn_result` from the target persona, in a row. Three disables
  // the routine; one success resets it to zero.
  consecutiveFailures: z.number(),
  // Why Manor turned this routine off itself, in words the row can show. Null when
  // the routine is off because the user turned it off, which needs no explanation.
  disabledReason: z.string().nullable(),
  /**
   * When the run that is in flight was claimed, null when nothing is running.
   *
   * This is the lease, not a status field the UI happens to read: the claim takes a
   * row only while this is empty or older than `ROUTINE_LEASE_MS`, which is what
   * stops two "Run now" clicks — or a hand run landing on a tick — from starting the
   * same routine twice. Rolling `nextRunAt` forward cannot do that job on its own,
   * because the second claim reads the rolled value and takes it just as happily.
   */
  runningSince: z.number().nullable(),
  /**
   * How full the target persona's context window was at the end of the last run.
   * Read off that turn's `turn_result`; null when the run reported none, which is
   * what a driver without per-request usage leaves behind.
   */
  lastContextTokens: z.number().nullable(),
  /**
   * How a one-time routine ended, null while it is still pending and always null for
   * a recurring one. Written by the scheduler, or by a cancel, never by a draft.
   */
  endState: RoutineEndStateSchema.nullable().default(null),
  endedAt: z.number().nullable().default(null),
  /**
   * Finished runs that wait for the user, newest first, and only on a routine with
   * `notify` on: a failure, or a published result (an incomplete one included). A quiet
   * run, one that declared no outcome, and a run in flight never land here.
   * Written by the scheduler when a run ends and cleared by `mark_routine_runs_read`,
   * so the rail and the list read attention without loading any history. The ids
   * are `RoutineRun.id`s; `routine_runs` always carries every one of them.
   */
  unreadRunIds: z.array(z.string()).max(ROUTINE_UNREAD_LIMIT).default([]),
  createdAt: z.number(),
})

const checkRoutineTarget = (
  routine: { projectId: string | null; chatId: string | null; agentId: string },
  context: z.RefinementCtx,
): void => {
  if (routine.agentId === SINGLE_CHAT_VOICE.id ? routine.chatId === null :
    (routine.projectId === null) !== (routine.chatId === null)) return
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: 'a routine needs exactly one target: a project or a direct message',
    path: ['projectId'],
  })
}

export const RoutineSchema = RoutineShapeSchema.superRefine(checkRoutineTarget)
export type Routine = z.infer<typeof RoutineSchema>

/**
 * One fire of a routine, from either kind of target.
 *
 * A project routine's fire is its own run thread, so `id` and `chatId` are that
 * chat. A DM fire has no chat of its own: `id` is the routine's `user_message` in
 * the DM and `chatId` the DM. Completion comes from the target persona's
 * `turn_result`, and an ended segment without one is failed. The current lease
 * supplies `running`, including the moment before the prompt exists, when `chatId`
 * of a project fire is still null.
 */
export const RoutineRunSchema = z.object({
  id: z.string(),
  chatId: z.string().nullable(),
  startedAt: z.number(),
  state: z.enum(['running', 'done', 'failed']),
  /**
   * Whether a finished run published a result or deliberately stayed quiet. Absent
   * on runs that ended before the outcome existed, which is not the same as a run
   * that spoke.
   */
  outcome: z.enum(['quiet', 'publish']).optional(),
  /**
   * What the run said, or why it failed, as plain text: the target persona's
   * messages and any error line inside the run. Null when it said nothing, which is
   * what a quiet DM fire leaves. Cut at `ROUTINE_RESULT_MAX_CHARS`, with `truncated`.
   */
  result: z.string().nullable(),
  truncated: z.literal(true).optional(),
})
export type RoutineRun = z.infer<typeof RoutineRunSchema>

/**
 * How long a claim is believed before another server may take the row anyway.
 *
 * A process killed mid-turn cannot clear its own lease, so without an expiry the
 * routine would be locked out of every future run by a turn that is not happening.
 * Long enough that a routine whose CLI is merely slow is not stolen, short enough
 * that a process killed mid-turn does not lock the row all day. The overall turn
 * timeout no longer ends a live run at 20 minutes, so this lease is also the bound
 * on a chatty unattended runaway. The only thing worse than a lease that expires
 * late is one that expires while the turn it guards is still talking.
 */
export const ROUTINE_LEASE_MS = 45 * 60 * 1000

/**
 * When a routine's thread is long enough to say so out loud, as a fraction of the
 * persona's context window. Manor cannot see the subscription cap, so it measures
 * rather than guards: crossing this posts one note in the chat and nothing else.
 */
export const ROUTINE_CONTEXT_WARN_FRACTION = 2 / 3

const WALL_CLOCK = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/

/** How far `timezone` is ahead of UTC at `at`, in ms. */
function zoneOffsetAt(at: number, timezone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(at))
  const field = (type: string) => Number(parts.find((part) => part.type === type)?.value)
  const asUtc = Date.UTC(field('year'), field('month') - 1, field('day'), field('hour'), field('minute'), field('second'))
  return asUtc - Math.floor(at / 1000) * 1000
}

/** A wall-clock moment read in a zone: one exact instant, or why there is none. */
export type WallClockReading = { ok: true; at: number } | { ok: false; reason: string }

const HOUR_MS = 60 * 60 * 1000

/**
 * Reads wall-clock time (`2026-09-28T10:00`) in an IANA zone. Shared by the persona
 * tool and the form, so a one-time routine means the same moment whichever wrote it.
 *
 * Refuses rather than guesses: a date that does not exist (30 February), a time the
 * clocks jump over in spring, and a time they pass twice in autumn. Each is a
 * question for the user, and a guessed hour is a reminder at the wrong time.
 */
export function readWallClock(wall: string, timezone: string): WallClockReading {
  const text = wall.trim()
  const match = WALL_CLOCK.exec(text)
  if (match === null) return { ok: false, reason: `${JSON.stringify(wall)} is not a date and time like 2026-09-28T10:00.` }
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? '0')) as [number, number, number, number, number, number]
  const utc = Date.UTC(year, month - 1, day, hour, minute, second)
  const back = new Date(utc)
  // Date.UTC rolls 30 February into March and 25:00 into tomorrow; a round trip
  // that does not come back to the same fields was never a real moment.
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day ||
    back.getUTCHours() !== hour || back.getUTCMinutes() !== minute) {
    return { ok: false, reason: `${text} is not a real date and time.` }
  }
  // Every offset the zone uses within a day either side; a candidate is a real
  // reading only if the zone agrees it has that offset at that instant.
  const offsets = new Set([-24, 0, 24].map((hours) => zoneOffsetAt(utc + hours * HOUR_MS, timezone)))
  const readings = [...new Set([...offsets].map((offset) => utc - offset))]
    .filter((at) => zoneOffsetAt(at, timezone) === utc - at)
  if (readings.length === 0) {
    return { ok: false, reason: `${text} does not exist in ${timezone}: the clocks jump forward past it. Pick another time.` }
  }
  if (readings.length > 1) {
    return { ok: false, reason: `${text} happens twice in ${timezone} as the clocks go back. Pick another time, or give it with its UTC offset.` }
  }
  return { ok: true, at: readings[0]! }
}

/** The inverse, as a `datetime-local` input takes it: `2026-09-28T10:00`. */
export function epochToWallClock(at: number, timezone: string): string {
  const local = new Date(at + zoneOffsetAt(at, timezone))
  return local.toISOString().slice(0, 16)
}

/**
 * Wire-only request for the persona's singleton DM when that row has not been made
 * yet. The service resolves it before a routine reaches a store, so persisted
 * `routines.chat_id` always contains the real chat id.
 */
export const routineDmTarget = (agentId: string): string => `dm:${agentId}`
export const isRoutineDmTarget = (target: string, agentId: string): boolean =>
  target === routineDmTarget(agentId)

/**
 * A routine on its way in. No id yet when it is being created, and none of the
 * fields the scheduler owns: `nextRunAt` follows from the cron, and the run history
 * is a record of what happened rather than something a form may assert.
 */
export const RoutineDraftSchema = RoutineShapeSchema.omit({
  id: true,
  nextRunAt: true,
  lastRunAt: true,
  lastSkippedAt: true,
  consecutiveFailures: true,
  disabledReason: true,
  runningSince: true,
  lastContextTokens: true,
  endState: true,
  endedAt: true,
  unreadRunIds: true,
  createdAt: true,
}).extend({
  id: z.string().optional(),
  // Optional rather than defaulted, so every caller written before one-time routines
  // still types; absent means recurring, as an older client means it.
  runAt: z.number().nullable().optional(),
  lateUntil: z.number().nullable().optional(),
  action: RoutineActionSchema.optional(),
}).superRefine(checkRoutineTarget)
// Optional only at the client boundary so an older open Manor window can still save
// after the server learns descriptions. Parsing fills the empty string immediately.
export type RoutineDraft = Omit<z.infer<typeof RoutineDraftSchema>, 'description'> & {
  description?: string
}

/** A preview is for inspection, not a second way to transfer a repository. */
export const MAX_REPO_FILE_BYTES = 500_000

export const RepoFileAppSchema = z.enum(['cursor', 'vscode', 'windsurf', 'terminal', 'iterm', 'xcode', 'finder'])
export type RepoFileApp = z.infer<typeof RepoFileAppSchema>

/**
 * The four honest outcomes of asking Manor to preview one linked-repo file.
 * `content` is UTF-8 text only; binary bytes never cross the wire.
 */
export const RepoFileResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    content: z.string().max(MAX_REPO_FILE_BYTES),
    // Content hash, set by both readers. It is the precondition a later write sends
    // back as `baseRevision`, which is what stops a save from landing on top of a
    // file Obsidian, a persona or an editor rewrote while this one was open. Still
    // optional in the schema, because a reader that has nothing to write back is a
    // legitimate future one and an absent hash means exactly "cannot be saved".
    revision: z.string().optional(),
  }),
  z.object({
    status: z.literal('too_large'),
    size: z.number().int().nonnegative(),
    maxSize: z.number().int().positive(),
  }),
  z.object({ status: z.literal('binary'), size: z.number().int().nonnegative() }),
  z.object({ status: z.literal('unavailable'), message: z.string().max(240) }),
])
export type RepoFileResult = z.infer<typeof RepoFileResultSchema>

/**
 * What one save did, to a vault note or to a linked-folder file. `stale` is the
 * interesting branch: it hands back the file as it now stands on disk, so the client
 * can offer to keep either side instead of discarding what the user typed and asking
 * them to look it up again.
 */
export const FileWriteResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('saved'), revision: z.string() }),
  z.object({ status: z.literal('stale'), revision: z.string(), content: z.string() }),
  z.object({ status: z.literal('rejected'), message: z.string().max(240) }),
])
export type FileWriteResult = z.infer<typeof FileWriteResultSchema>

/**
 * A website URL the local app host may hand to a desktop browser.
 *
 * The protocol check is total on purpose. A failed string check leaves zod's parse
 * dirty rather than aborted, so the refinement still runs on input `.url()` already
 * rejected, and an unguarded `new URL()` there throws straight out of `safeParse` —
 * which is the server's only boundary guard against a malformed frame.
 */
const ExternalWebsiteUrlSchema = z
  .string()
  .max(10_000)
  .refine((value) => {
    try {
      const { protocol } = new URL(value)
      return protocol === 'http:' || protocol === 'https:'
    } catch {
      return false
    }
  }, 'must be an http or https website URL')

// ---------------------------------------------------------------------------
// mymind Artifacts
// ---------------------------------------------------------------------------

export const MyMindArtifactKindSchema = z.enum(['image', 'article', 'note', 'product', 'other'])
export type MyMindArtifactKind = z.infer<typeof MyMindArtifactKindSchema>

/** A read-only, browser-safe projection of one object in mymind. */
export const MyMindArtifactSchema = z.object({
  id: z.string().min(1).max(160),
  title: z.string().min(1).max(500),
  kind: MyMindArtifactKindSchema,
  summary: z.string().max(12_000).optional(),
  content: z.string().max(120_000).optional(),
  note: z.string().max(12_000).optional(),
  url: ExternalWebsiteUrlSchema.optional(),
  imageUrl: z.union([
    ExternalWebsiteUrlSchema,
    z.string().max(512).startsWith('/internal/mymind-thumbnail/'),
  ]).optional(),
  imageWidth: z.number().positive().optional(),
  imageHeight: z.number().positive().optional(),
  tags: z.array(z.string().max(240)).max(200),
  spaces: z.array(z.string().max(160)).max(100),
  created: z.string(),
  bumped: z.string(),
})
export type MyMindArtifact = z.infer<typeof MyMindArtifactSchema>

export const MyMindSpaceSchema = z.object({
  id: z.string().min(1).max(160),
  name: z.string().min(1).max(240),
  color: z.string().optional(),
})
export type MyMindSpace = z.infer<typeof MyMindSpaceSchema>

/** Machine-local state for Manor's managed, read-only mymind connection. */
export const MyMindConnectionStatusSchema = z.object({
  available: z.boolean(),
  env: z.array(z.object({ key: z.string(), present: z.boolean() })),
  problem: z.string().nullable(),
  check: z
    .object({
      checkedAt: z.string(),
      result: z.enum(['verified', 'failed']),
    })
    .nullable(),
})
export type MyMindConnectionStatus = z.infer<typeof MyMindConnectionStatusSchema>

// ---------------------------------------------------------------------------
// Apple Reminders
// ---------------------------------------------------------------------------

const REMINDER_TEXT_MAX = 500
const REMINDER_NOTES_MAX = 10_000
const ReminderDaySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/**
 * Europe/Amsterdam wall time without an offset. A day alone is an all-day reminder;
 * a time makes it timed. Manor never converts these, so DST stays the Mac's problem.
 */
export const ReminderDueSchema = z.object({
  day: ReminderDaySchema,
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
})
export type ReminderDue = z.infer<typeof ReminderDueSchema>

export const ReminderPrioritySchema = z.enum(['none', 'low', 'medium', 'high'])
export type ReminderPriority = z.infer<typeof ReminderPrioritySchema>

/**
 * The repeats the details panel can set. `custom` is read-only: a rule Reminders.app
 * made that Manor shows as its label and can clear, but never rewrites.
 */
export const ReminderRepeatSchema = z.object({
  frequency: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
  interval: z.number().int().min(1).max(999),
  custom: z.string().max(200).optional(),
})
export type ReminderRepeat = z.infer<typeof ReminderRepeatSchema>

/** Someone a reminder on a shared list can be assigned to. Ids are per list. */
export const ReminderPersonSchema = z.object({
  id: z.string(),
  name: z.string(),
  me: z.boolean(),
})
export type ReminderPerson = z.infer<typeof ReminderPersonSchema>

/**
 * One reminder, open or completed. Ids (reminder, list, section) are Apple's
 * CloudKit identifiers, which EventKit and RemCTL share, so they survive a switch to
 * the plain source. Section, assignee, flag, tags and subtasks exist only when the
 * snapshot's `source` is `remctl`.
 */
export const ReminderSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  listId: z.string(),
  notes: z.string().optional(),
  completed: z.boolean(),
  completedAt: z.string().optional(),
  due: ReminderDueSchema.optional(),
  flagged: z.boolean(),
  priority: ReminderPrioritySchema,
  url: z.string().optional(),
  tags: z.array(z.string()),
  repeat: ReminderRepeatSchema.optional(),
  sectionId: z.string().optional(),
  assignee: ReminderPersonSchema.optional(),
  parentId: z.string().optional(),
  createdAt: z.string().optional(),
})
export type Reminder = z.infer<typeof ReminderSchema>

export const ReminderListSchema = z.object({
  id: z.string(),
  title: z.string(),
  /** `#RRGGBB`, the list's own Reminders colour. Runtime data like persona accents. */
  color: z.string().optional(),
  groupId: z.string().optional(),
  shared: z.boolean(),
  open: z.number().int().min(0),
  sections: z.array(z.object({ id: z.string(), title: z.string() })),
  sharees: z.array(ReminderPersonSchema),
})
export type ReminderList = z.infer<typeof ReminderListSchema>

/**
 * The fields a write may set. `null` clears; an absent key leaves the field alone.
 * Section and link have no `null`: RemCTL can move a reminder into a section and add
 * a link, but only Reminders.app can take either away again.
 */
export const ReminderChangesSchema = z.object({
  title: z.string().trim().min(1).max(REMINDER_TEXT_MAX).optional(),
  notes: z.string().max(REMINDER_NOTES_MAX).nullable().optional(),
  listId: z.string().min(1).optional(),
  sectionId: z.string().min(1).optional(),
  due: ReminderDueSchema.nullable().optional(),
  flagged: z.boolean().optional(),
  priority: ReminderPrioritySchema.optional(),
  url: z.string().trim().url().max(2_000).optional(),
  tags: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  repeat: ReminderRepeatSchema.omit({ custom: true }).nullable().optional(),
  assigneeId: z.string().min(1).nullable().optional(),
})
export type ReminderChanges = z.infer<typeof ReminderChangesSchema>

export const ReminderWriteSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('create'),
    listId: z.string().min(1),
    title: z.string().trim().min(1).max(REMINDER_TEXT_MAX),
    /** Creates a subtask under this reminder instead of a top-level reminder. */
    parentId: z.string().min(1).optional(),
    changes: ReminderChangesSchema.omit({ title: true, listId: true }).optional(),
  }),
  z.object({ kind: z.literal('update'), id: z.string().min(1), changes: ReminderChangesSchema }),
  z.object({ kind: z.literal('complete'), id: z.string().min(1) }),
  z.object({ kind: z.literal('uncomplete'), id: z.string().min(1) }),
  z.object({ kind: z.literal('delete'), id: z.string().min(1) }),
])
export type ReminderWrite = z.infer<typeof ReminderWriteSchema>

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** Long enough for a pasted sentence, short enough that one keystroke stays one cheap query. */
export const SEARCH_QUERY_MAX = 200

/**
 * One message whose words matched. `phrase` says the query's words stood together in
 * that order, which ranks above the same words scattered through a long reply.
 * `agentId` absent means the user wrote it. `snippet` is a short excerpt around the
 * match; the client marks the matched words itself, the same way for every source.
 */
export const SearchMessageHitSchema = z.object({
  chatId: z.string(),
  eventId: z.string(),
  agentId: z.string().optional(),
  ts: z.number(),
  snippet: z.string(),
  phrase: z.boolean(),
})
export type SearchMessageHit = z.infer<typeof SearchMessageHitSchema>

/**
 * One vault note whose title or body matched. `title` is the file name without
 * `.md`; `snippet` is present when the body matched, `phrase` as for messages, and
 * `modifiedAt` breaks ties by recency.
 */
export const SearchNoteHitSchema = z.object({
  path: z.string(),
  title: z.string(),
  snippet: z.string().optional(),
  phrase: z.boolean(),
  modifiedAt: z.number(),
})
export type SearchNoteHit = z.infer<typeof SearchNoteHitSchema>

// ---------------------------------------------------------------------------
// WebSocket protocol
// ---------------------------------------------------------------------------

const RequestIdSchema = z.string().min(1).max(120)
const optionalRequestId = { requestId: RequestIdSchema.optional() }

const ClientMessageWireSchema = z.discriminatedUnion('type', [
  // Native clients register the opaque Expo address the server may notify while
  // every Manor surface is closed. Registration is idempotent, and unregistering
  // is the reverse state used when a device signs out or rotates its token.
  z.object({
    type: z.literal('register_push_token'),
    token: z.string().regex(/^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]{1,200}\]$/),
    ...optionalRequestId,
  }),
  z.object({
    type: z.literal('unregister_push_token'),
    token: z.string().regex(/^(Expo|Exponent)PushToken\[[A-Za-z0-9_-]{1,200}\]$/),
    ...optionalRequestId,
  }),
  // Ask for a chat's snapshot; the server replies with `snapshot` for it.
  z.object({
    type: z.literal('open_chat'),
    chatId: z.string(),
    /**
     * The last event this client holds of a thread it was sent whole, and how many
     * events that copy holds. Events reach every socket as they are written, so on
     * the same socket the reply only needs what follows `after`; a copy from an
     * earlier socket names its `sync` as well. When the server's
     * thread up to `after` is not exactly `count` long, something was written without
     * a broadcast and the whole thread comes back instead.
     */
    after: z.string().optional(),
    count: z.number().int().nonnegative().optional(),
    /**
     * The rewrite position the last snapshot of this chat carried. With it the copy
     * may come from an earlier socket: the reply then also names what was rewritten
     * since, which that copy missed while it was away.
     */
    sync: EventSyncSchema.optional(),
  }),
  z.object({
    type: z.literal('send_message'),
    chatId: z.string(),
    text: z.string(),
    ...messageAttachmentFields,
    pageContexts: z.array(PageContextAttachmentSchema).max(MAX_PAGE_CONTEXT_ATTACHMENTS).optional(),
    replyTo: MessageReplySchema.optional(),
    quotes: InlineQuotesSchema.optional(),
    /** What an older phone build still sends; see `placeQuotesAfterText`. */
    quote: MessageQuoteSchema.optional(),
    noteQuote: NoteQuoteSchema.optional(),
  }),
  z.object({ type: z.literal('stop'), turnId: z.string() }),
  z.object({ type: z.literal('stop_subagent'), chatId: z.string(), toolCallId: z.string() }),
  // Stops every background child a chat's turns started and any pending wake.
  z.object({ type: z.literal('stop_background'), chatId: z.string() }),
  z.object({
    type: z.literal('answer_user_input'),
    chatId: z.string(),
    requestId: z.string(),
    answers: UserInputAnswersSchema,
  }),
  // A secret card's answer. A value goes straight to its destination in server memory;
  // no value declines. Log nothing of this frame.
  z.object({
    type: z.literal('answer_secret_request'),
    chatId: z.string(),
    requestId: z.string(),
    value: z.string().min(1).max(SECRET_VALUE_MAX).optional(),
  }),
  // In a project thread: The user replaces an answer the thread gave from preferences. It
  // reaches the Session as their own message, also after the Session moved on. `answers`
  // holds only the questions the user changed.
  z.object({
    type: z.literal('change_session_answer'),
    chatId: z.string(),
    requestId: z.string(),
    answers: UserInputAnswersSchema,
  }),
  z.object({
    type: z.literal('submit_outbound_draft'),
    slackRichText: SlackRichTextSchema.optional(),
    chatId: z.string(),
    draftId: z.string().min(1).max(120),
    body: z.string().max(OUTBOUND_DRAFT_BODY_MAX),
    subject: z.string().max(OUTBOUND_DRAFT_SUBJECT_MAX).optional(),
    cc: z.string().max(OUTBOUND_DRAFT_TO_MAX).optional(),
  }),
  OpenConnectCardMessageSchema,
  z.object({
    type: z.literal('discard_outbound_draft'),
    chatId: z.string(),
    draftId: z.string().min(1).max(120),
  }),
  z.object({
    type: z.literal('snooze_outbound_draft'),
    chatId: z.string(),
    draftId: z.string().min(1).max(120),
    until: z.number().int().positive(),
  }),
  z.object({
    type: z.literal('ignore_outbound_draft'),
    chatId: z.string(),
    draftId: z.string().min(1).max(120),
  }),
  z.object({
    type: z.literal('restore_outbound_draft'),
    chatId: z.string(),
    draftId: z.string().min(1).max(120),
  }),
  z.object({
    type: z.literal('outbound_thread_read'),
    chatId: z.string(),
    draftId: z.string().min(1).max(120),
    requestId: RequestIdSchema,
  }),
  // Folders stay optional and stay plural. A client track or a life-admin project
  // has none, and a create flow that implies one would pull the whole app toward
  // code; a project that spans a repo and a vault needs more than one.
  z.object({
    type: z.literal('create_project'),
    ...optionalRequestId,
    name: z.string(),
    repoPaths: z.array(z.string()).default([]),
    // Optional on input so an older client still creates a valid, neutral project.
    icon: ProjectIconSchema.optional(),
    color: ProjectColorSchema.optional(),
    memoryScope: ProjectMemoryScopeSchema.optional(),
    // What the new project's thread runs on at first. Absent is the house default.
    threadRuntime: ChatOverrideSchema.optional(),
  }),
  // A folder to start Sessions in, without a project thread (2026-11-13). Answered
  // like `create_project` with `project_created`; the same folder added again answers
  // with the folder it already is and lists it again. One path, checked like a project's.
  z.object({ type: z.literal('add_folder'), ...optionalRequestId, path: z.string() }),
  // Takes a folder off the new-Session picker. Its Sessions keep it as their room and
  // nothing is deleted. A project, a row with a thread, is refused.
  z.object({ type: z.literal('remove_folder'), ...optionalRequestId, projectId: z.string() }),
  // Browsing happens on the server's filesystem, not the viewer's. A browser cannot
  // hand out an absolute path (neither showDirectoryPicker nor webkitdirectory
  // exposes one), and on the VPS the viewer's machine is the wrong one anyway.
  // Absent `path` means start at the server user's home directory.
  z.object({ type: z.literal('list_dirs'), path: z.string().optional() }),
  // The Usage view asking for its own data. Reply-only and unsolicited-never: it is
  // a whole-house aggregate, so pushing it after every turn would send a document
  // nobody is looking at, and the view is opened deliberately.
  // `timeZone` is the client's IANA zone, so days break at its midnight; absent
  // means the server's own.
  z.object({
    type: z.literal('get_usage_report'),
    windowDays: UsageWindowDaysSchema.default(30),
    timeZone: z.string().max(64).optional(),
  }),
  // Ask every provider for a fresh subscription reading now. The answer is the
  // ordinary `provider_usage` broadcast; a provider read moments ago is not asked
  // again and the current reading is sent instead.
  z.object({ type: z.literal('refresh_provider_usage') }),
  // Run the provider's own updater. Omitted `provider` means every entry that can
  // update ("Update all"). Progress comes back as `provider_updates` broadcasts.
  z.object({ type: z.literal('update_providers'), provider: ProviderUpdateSchema.shape.provider.optional() }),
  // Ask every provider CLI again whether it is installed and signed in. The answer
  // is the ordinary `provider_connections` broadcast.
  z.object({ type: z.literal('check_providers') }),
  // Start, or stop waiting for, the provider's own sign-in. It opens the browser on the Mac.
  z.object({ type: z.literal('sign_in_provider'), provider: ProviderConnectionSchema.shape.provider }),
  z.object({ type: z.literal('cancel_provider_sign_in'), provider: ProviderConnectionSchema.shape.provider }),
  // Run the provider's own installer for a CLI that is missing. The cancel above stops it too.
  z.object({ type: z.literal('install_provider'), provider: ProviderConnectionSchema.shape.provider }),
  // The Auto settings dialog asking for the rule file; the reply goes to that socket.
  z.object({ type: z.literal('get_auto_rules'), ...optionalRequestId }),
  // Full replacement of the rule file. Validated semantically by the service so a
  // refused save comes back with its reason instead of vanishing at the wire.
  z.object({ type: z.literal('save_auto_rules'), rules: AutoRulesDraftSchema, ...optionalRequestId }),
  // Settings asking for what subagents may run; the reply goes to that socket.
  z.object({ type: z.literal('get_subagent_policy'), ...optionalRequestId }),
  // Full replacement, checked by the service so a refused save comes back with its reason.
  z.object({ type: z.literal('save_subagent_policy'), policy: SubagentPolicyDraftSchema, ...optionalRequestId }),
  // Full replacement of the profile; checked by the service so a refusal names its reason.
  z.object({ type: z.literal('save_profile'), profile: z.object({ name: z.string(), avatar: z.string().optional() }), ...optionalRequestId }),
  // Full replacement of the house settings, checked by the service so a refusal names its
  // reason instead of vanishing at the wire. A key an older client leaves out reads its default.
  z.object({ type: z.literal('save_house_settings'), settings: z.record(z.string(), z.unknown()), ...optionalRequestId }),
  // Settings opening Context files, and its poll while open; the reply goes to that socket.
  z.object({ type: z.literal('get_context_files'), ...optionalRequestId }),
  // Refused when the file on disk is no longer `baseHash`, so an outside edit is never
  // overwritten unseen. Overwriting on purpose means saving against the newer hash.
  z.object({
    type: z.literal('save_context_file'),
    name: ContextFileNameSchema,
    content: z.string().max(200_000),
    baseHash: z.string(),
    ...optionalRequestId,
  }),
  // About, Providers and Memory & vault asking what the Mac runs; reply-only.
  z.object({ type: z.literal('get_system_info'), ...optionalRequestId }),
  // Show one of the listed log files in Finder. Paths outside that list are refused.
  z.object({ type: z.literal('reveal_log'), path: z.string(), ...optionalRequestId }),
  /** Shows the memory or Knowledge folder in Finder on the Mac the server runs on. */
  z.object({ type: z.literal('reveal_folder'), folder: z.enum(['memory', 'knowledge']), ...optionalRequestId }),
  // The files in this project's linked folders, for the composer's `@` menu. Asked
  // per project rather than pushed with the directory: a roster is small and a file
  // tree is not, so a project nobody has opened never pays for its listing.
  z.object({ type: z.literal('get_project_memory'), projectId: z.string(), ...optionalRequestId }),
  z.object({ type: z.literal('get_chat_summary'), chatId: z.string(), ...optionalRequestId }),
  /** An agent's standing notes as its turns receive them, for its Agent settings Notes page. */
  z.object({ type: z.literal('get_agent_notes'), agentId: z.string(), ...optionalRequestId }),
  /** Every file of one DM, newest first, for the Files page of its Agent settings. */
  z.object({ type: z.literal('get_dm_files'), chatId: z.string(), ...optionalRequestId }),
  /** Puts an agent's notes back as a turn found them, only while nothing changed them since. */
  z.object({ type: z.literal('undo_notes_update'), chatId: z.string(), turnId: z.string(), ...optionalRequestId }),
  z.object({
    type: z.literal('list_repo_files'),
    projectId: z.string(),
    // Present, resolve through this chat's remap. Absent, the project's own paths
    // (new-chat draft). The listing then keys the client cache by chat when it must.
    chatId: z.string().optional(),
  }),
  // Read one path from that listing. The server resolves the human-sized
  // `<folder-name>/<path>` pointer against the project's current linked folders;
  // the client never receives or sends an absolute server path.
  z.object({
    type: z.literal('read_repo_file'),
    projectId: z.string(),
    path: z.string().min(1).max(10_000),
    chatId: z.string().optional(),
  }),
  z.object({
    type: z.literal('open_repo_file'),
    projectId: z.string(),
    path: z.string().min(1).max(10_000),
    chatId: z.string().optional(),
    app: RepoFileAppSchema,
  }),
  // Save one file back to a linked folder. `baseRevision` is required and not
  // nullable, which is the protocol saying this edits and never creates: the server
  // only accepts a path its own listing offered, and a path that does not exist yet
  // was never in one. Creating files in a repo belongs to a persona with a shell,
  // not to a file browser.
  z.object({
    type: z.literal('write_repo_file'),
    projectId: z.string(),
    path: z.string().min(1).max(10_000),
    content: z.string().max(MAX_REPO_FILE_BYTES),
    baseRevision: z.string(),
    chatId: z.string().optional(),
  }),
  // The vault is one configured folder, not a list, because Manor has one user with
  // one second brain. Paths are relative to its root, `/`-separated, no folder-name
  // prefix: with a single root a prefix would be noise on every path.
  z.object({ type: z.literal('list_vault') }),
  z.object({ type: z.literal('create_vault_folder'), path: z.string().min(1).max(1_000) }),
  z.object({ type: z.literal('rename_vault_file'), requestId: z.string().min(1).max(120), path: z.string().min(1).max(1_000), newPath: z.string().min(1).max(1_000), baseRevision: z.string() }),
  z.object({ type: z.literal('read_vault_file'), path: z.string().min(1).max(1_000) }),
  // Moves one note or folder to Manor's trash, never a hard delete. The server decides
  // whether the path is a note or a folder, and refuses the root and anything hidden.
  z.object({ type: z.literal('delete_vault_entry'), requestId: z.string().min(1).max(120), path: z.string().min(1).max(1_000) }),
  // Moves one note or folder into another folder, keeping its name. `folder` is relative
  // to the root, `''` for the top level. A name already taken there is refused.
  z.object({ type: z.literal('move_vault_entry'), requestId: z.string().min(1).max(120), path: z.string().min(1).max(1_000), folder: z.string().max(1_000) }),
  z.object({
    type: z.literal('write_vault_file'),
    path: z.string().min(1).max(1_000),
    content: z.string().max(MAX_REPO_FILE_BYTES),
    // The revision the editor read. `null` means "create this note, refuse if it
    // already exists", so creating and updating are one message rather than two
    // that could disagree about which one a given path needs.
    baseRevision: z.string().nullable(),
  }),
  // One AI edit of the note the editor holds, as text: the server never opens the
  // file for it and never writes one. With `selection` the answer replaces that range
  // of `note`; without, the answer is the whole edited note.
  z.object({
    type: z.literal('edit_vault_note'),
    requestId: z.string().min(1).max(120),
    note: z.string().max(MAX_REPO_FILE_BYTES),
    selection: z.object({ from: z.number().int().nonnegative(), to: z.number().int().nonnegative() }).optional(),
    instruction: z.string().trim().min(1).max(2_000),
  }),
  // Stop: the job ends and no answer follows.
  z.object({ type: z.literal('cancel_vault_note_edit'), requestId: z.string().min(1).max(120) }),
  z.object({
    type: z.literal('list_mymind_objects'),
    query: z.string().max(1_000).default(''),
    requestId: z.string().min(1).max(120),
    cancelRequestId: z.string().min(1).max(120).optional(),
  }),
  z.object({ type: z.literal('load_more_mymind_objects'), requestId: z.string().min(1).max(120) }),
  z.object({ type: z.literal('verify_mymind') }),
  // The ⌘K palette's server half: message content and vault note bodies, which never
  // ship to the client whole. Chat titles and reminders are matched on the client from
  // lists it already holds. Reply-only, answered with `search_results`.
  z.object({ type: z.literal('search'), requestId: RequestIdSchema, query: z.string().min(1).max(SEARCH_QUERY_MAX) }),
  // Apple Reminders on the Mac host. A load answers the asker with `reminders_state`;
  // every write is followed by a broadcast of the fresh state, so an open door in
  // another window never shows a reminder that is already gone.
  z.object({ type: z.literal('reminders_load') }),
  z.object({ type: z.literal('reminders_load_completed'), offset: z.number().int().min(0).max(100_000) }),
  z.object({ type: z.literal('reminders_write'), requestId: RequestIdSchema, action: ReminderWriteSchema }),
  z.object({
    type: z.literal('create_chat'),
    ...optionalRequestId,
    mode: ChatModeSchema.optional(),
    // Absent for a home-scope chat. A `dm` or a `group` names its members instead, and
    // the server refuses any combination the database would refuse anyway.
    projectId: z.string().optional(),
    kind: ChatKindSchema.optional(),
    memberIds: z.array(z.string()).optional(),
    title: z.string().optional(),
    // The sidebar may hold a local new-chat concept without a row. Its first send
    // creates the row and carries the opening message in one server-owned action,
    // so a disconnect between two client messages cannot strand an empty chat.
    openingMessage: z
      .object({
        text: z.string(),
        ...messageAttachmentFields,
        pageContexts: z.array(PageContextAttachmentSchema).max(MAX_PAGE_CONTEXT_ATTACHMENTS).optional(),
        quotes: InlineQuotesSchema.optional(),
      })
      .optional(),
    // Model/effort pins chosen on the new-chat stage, before the chat had an id to
    // pin them to. They ride along with the create rather than following it, so the
    // opening message cannot run a turn on a model the user already changed.
    overrides: z.record(z.string(), ChatOverrideSchema).optional(),
    // Isolation chosen on the new-chat stage. Absent is current checkout, the default.
    // Worktree is created after the row exists and before the opening turn; failure
    // refuses the whole create.
    checkout: CheckoutRequestSchema.optional(),
  }),
  // Isolate this chat, or switch it back to the shared checkout. Refused while a
  // turn in that chat is queued or running. A project with no git roots refuses
  // `mode: 'worktree'` even if an older client asks.
  z.object({
    type: z.literal('set_chat_checkout'),
    chatId: z.string(),
    checkout: CheckoutRequestSchema,
  }),
  // Remove the directory at this chat's deterministic path. Allowed after switch
  // to current, when a leftover still sits there. Dirty needs `{ force: true }`.
  // Always leaves the git branch. Refuses only when there is nothing to discard.
  z.object({
    type: z.literal('discard_chat_worktree'),
    chatId: z.string(),
    force: z.boolean().optional(),
  }),
  // Dirty state, leftover, and the branch list, asked with the composer. Reply-only.
  // A chat id is the live row. A project id is the new-chat stage, which has no
  // chat yet and still needs the shared checkout's branch and the list to pick from.
  z.object({
    type: z.literal('checkout_status'),
    chatId: z.string().optional(),
    projectId: z.string().optional(),
  }),
  // The Session panel's Changes and Branch, reply-only. See `session_repo` below.
  z.object({ type: z.literal('session_repo'), chatId: z.string() }),
  // The whole-Session diff: what Confirm or Commit would land. Reply-only.
  z.object({ type: z.literal('session_diff'), chatId: z.string(), ignoreWhitespace: z.boolean().optional() }),
  // Commits exactly these uncommitted Session files of one folder. Refused while a result
  // waits for Confirm, while a turn runs and for any path that is not this Session's.
  // An empty message asks Manor to write one from the diff.
  z.object({
    type: z.literal('commit_session'), chatId: z.string(), root: z.string(),
    files: z.array(z.string().min(1).max(1_024)).min(1).max(MAX_SESSION_DIFF_FILES),
    message: z.string().max(5_000), ...optionalRequestId,
  }),
  // Pushes the folder's current branch to its remote. Never forced; refused with nothing ahead.
  z.object({ type: z.literal('push_session'), chatId: z.string(), root: z.string(), ...optionalRequestId }),
  // Opens one of this Session's folders in an application on the Manor host.
  z.object({ type: z.literal('open_session_folder'), chatId: z.string(), root: z.string(), app: RepoFileAppSchema }),
  // What the panel's own selector sends. Model and effort together, because they are
  // one control: an effort a provider does not honour is decided per model.
  z.object({
    type: z.literal('set_side_runtime'),
    chatId: z.string(),
    model: z.string().min(1).max(120),
    effort: EffortSchema,
  }),
  // Opens the side chat of one chat, creating it on first use. Idempotent by
  // construction: one side chat per parent, so a second click on the rail item lands
  // on the same thread rather than making another. `fresh` clears it: the old thread
  // is deleted and a new one opened on the same model and effort.
  z.object({ type: z.literal('open_side_chat'), chatId: z.string(), fresh: z.boolean().optional() }),
  // The way out ships with the way in. Deletes cascade (a project takes its
  // chats, a chat takes its events and sessions) and are irreversible, so the
  // client confirms before sending.
  z.object({ type: z.literal('delete_project'), projectId: z.string(), ...optionalRequestId }),
  z.object({ type: z.literal('delete_chat'), chatId: z.string() }),
  // Archive and restore are one idempotent write with the desired state named.
  // Project chats only: home conversations are endless threads and have no project
  // archive to live in.
  z.object({ type: z.literal('set_chat_archived'), chatId: z.string(), archived: z.boolean() }),
  // Put a chat down, or pick it back up. The whole state is sent rather than a
  // toggle, so two clients settling the same chat cannot flip it back and forth.
  z.object({ type: z.literal('set_chat_settled'), chatId: z.string(), settled: z.boolean() }),
  // Proposal actions use the handoff id. chatId supports clients holding a legacy pending target.
  z.object({ type: z.literal('reject_work_handoff'), handoffId: z.string(), requestId: RequestIdSchema.optional() }),
  // The user agrees the lead reached the goal. Idempotent: a second confirm keeps the first time.
  // `mergeInto` is the branch the button showed for a worktree Session: approving the merge
  // into it. The server refuses when the linked folders are no longer on that branch.
  z.object({
    type: z.literal('confirm_work_goal'), handoffId: z.string(), mergeInto: z.string().min(1).max(255).optional(),
    version: z.number().int().nonnegative().optional(),
    ...optionalRequestId,
  }),
  // Retry on a Merge blocked or Commit blocked card: the same approval tries again,
  // refused when the approved files changed since Confirm.
  z.object({ type: z.literal('retry_work_completion'), handoffId: z.string(), ...optionalRequestId }),
  // The user approves the lead's conflict fix shown on the card; `tip` is the commit they saw.
  z.object({ type: z.literal('approve_merge_fix'), handoffId: z.string(), tip: z.string().min(1).max(64), ...optionalRequestId }),
  z.object({
    type: z.literal('revise_work_goal'), handoffId: z.string(), version: z.number().int().nonnegative(),
    text: z.string().trim().min(1).max(40_000), ...optionalRequestId,
  }),
  z.object({
    type: z.literal('accept_work_handoff'), handoffId: z.string().optional(), chatId: z.string().optional(),
    checkout: CheckoutRequestSchema.optional(),
    // The user's edit of the proposed task, same bounds as `start_work`. Only a proposal
    // whose session does not exist yet can take one; the kickoff is built from it.
    task: z.string().trim().min(1).max(40_000).optional(),
    mode: ChatModeSchema.optional(), runtime: SingleRuntimeSchema.optional(), ...optionalRequestId,
  }),
  // The way out of a group ships with the way in. The whole desired membership, not an
  // add or a remove, so two clients editing one group cannot compose into a set neither
  // of them asked for. Groups only: a DM's single member is what the DM is.
  // Removing a persona mid-turn does not cancel the turn it is already running.
  z.object({ type: z.literal('set_chat_members'), chatId: z.string(), memberIds: z.array(z.string()) }),
  // The complete desired order, not a from/to patch. The server checks that every
  // current project appears exactly once before it writes anything, so a stale client
  // cannot accidentally hide a project it did not know existed.
  z.object({ type: z.literal('reorder_projects'), projectIds: z.array(z.string()) }),
  // One message for the whole project, because it is one form: name, appearance and
  // folders as they should be, not a diff. Linking, restyling and renaming are the
  // same write, so a client cannot leave a project half-edited.
  // Paths are absolute on the server's machine; the server checks every one of them
  // and refuses the whole update with a `notice` when one cannot be used.
  z.object({
    type: z.literal('update_project'),
    ...optionalRequestId,
    projectId: z.string(),
    name: z.string(),
    repoPaths: z.array(z.string()),
    // An older client edits the fields it knows without resetting appearance or scope.
    icon: ProjectIconSchema.optional(),
    color: ProjectColorSchema.optional(),
    memoryScope: ProjectMemoryScopeSchema.optional(),
  }),
  // Add a project to the sidebar with its curated thread, or hide it again (2026-10-14:
  // listed = has a thread). The ack names the thread in `workChatId`. Hiding archives
  // the thread and keeps the project and its files.
  z.object({ type: z.literal('create_project_thread'), ...optionalRequestId, projectId: z.string() }),
  z.object({ type: z.literal('remove_project_thread'), ...optionalRequestId, projectId: z.string() }),
  // Create when the draft has no id, update when it has one. One message because it
  // is one form; the server checks the draft and answers a bad one with a `notice`.
  // `interview` only on a create of a chat agent: its DM opens with the interview that
  // writes its instructions once.
  z.object({ type: z.literal('save_agent'), agent: AgentDraftSchema, interview: z.literal(true).optional(), ...optionalRequestId }),
  z.object({ type: z.literal('delete_agent'), agentId: z.string(), ...optionalRequestId }),
  // The server probes before it saves, so a registry row always describes a server
  // that actually started on this machine with these env keys present.
  z.object({ type: z.literal('save_mcp_server'), server: McpServerDraftSchema, ...optionalRequestId }),
  z.object({ type: z.literal('verify_mcp_server'), serverId: z.string(), ...optionalRequestId }),
  z.object({ type: z.literal('delete_mcp_server'), serverId: z.string(), ...optionalRequestId }),
  // Discovery is server-local. Import names an opaque candidate rather than a path,
  // so a client cannot turn this into a filesystem reader.
  z.object({ type: z.literal('list_skill_candidates') }),
  z.object({ type: z.literal('list_workflow_suggestions') }),
  ListComposioAppsMessageSchema,
  ConnectComposioAppMessageSchema,
  DisconnectComposioAppMessageSchema,
  SetComposioKeyMessageSchema,
  RemoveComposioKeyMessageSchema,
  z.object({ type: z.literal('import_skill'), candidateId: z.string(), ...optionalRequestId }),
  z.object({ type: z.literal('delete_skill'), skillId: SkillIdSchema, ...optionalRequestId }),
  // A user-clicked website link, never model-initiated. The server only advertises
  // this action when its host can open Dia; other clients keep the anchor's normal
  // browser behaviour instead of sending a request that cannot land.
  z.object({ type: z.literal('open_external_url'), url: ExternalWebsiteUrlSchema }),
  // Electron announces this capability over the ordinary app socket. Browser tool
  // results may only come from the socket that announced itself as the host.
  // `computerStop` says this shell can register the Escape stop computer use needs.
  z.object({ type: z.literal('browser_host_ready'), computerStop: z.literal(true).optional() }),
  // The Mac is in use: unlocked, awake and not idle. The desktop host repeats it as a
  // heartbeat while true and says false the moment it stops; the server holds phone
  // pushes only while the latest `true` is fresh, so silence never swallows one.
  z.object({ type: z.literal('desktop_presence'), active: z.boolean() }),
  z.object({
    type: z.literal('browser_tool_result'),
    requestId: z.string(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().optional(),
  }),
  // The host's answer to `computer_stop_armed: true`: whether Escape is registered.
  // The first computer action of a turn waits for `ok: true`.
  z.object({ type: z.literal('computer_stop_ack'), armId: z.number().int(), ok: z.boolean() }),
  // Pin a model and/or effort for one agent in one chat, for the rest of that
  // chat's life. Replace-not-merge: the override sent is the whole override, so
  // the client never has to know what the server currently holds.
  z.object({
    type: z.literal('set_chat_override'),
    ...optionalRequestId,
    chatId: z.string(),
    agentId: z.string(),
    override: ChatOverrideSchema,
  }),
  // Create when the draft has no id, update when it has one, exactly like
  // `save_agent`: one form, one message, and a draft the server refuses with a
  // `notice` rather than half-writing.
  z.object({ type: z.literal('save_routine'), routine: RoutineDraftSchema, ...optionalRequestId }),
  z.object({ type: z.literal('delete_routine'), routineId: z.string(), ...optionalRequestId }),
  // The whole desired state, not a toggle, for the same reason `set_chat_settled`
  // is: two clients flipping one routine must not be able to compose into a state
  // neither of them asked for. Enabling is also what recomputes `nextRunAt`, which
  // is why it is its own message and not a `save_routine` the UI has to assemble.
  z.object({ type: z.literal('set_routine_enabled'), routineId: z.string(), enabled: z.boolean() }),
  // Asked lazily, because a history reads transcripts: the run threads of a project
  // routine, or the DM a continuing routine speaks in.
  z.object({ type: z.literal('get_routine_runs'), routineId: z.string() }),
  // Read means shown. The client sends this once a run's result is on screen, and
  // the server drops those ids from `Routine.unreadRunIds`. Unknown ids are ignored.
  z.object({ type: z.literal('mark_routine_runs_read'), routineId: z.string(), runIds: z.array(z.string()) }),
  z.object({ type: z.literal('mark_all_routine_runs_read') }),
  // Fire this routine now, outside its schedule. Exists so a routine can be judged
  // before a scheduler is trusted with it, and it leaves `nextRunAt` alone: a hand
  // run is not the scheduled run and must not consume it.
  z.object({ type: z.literal('run_routine_now'), routineId: z.string(), ...optionalRequestId }),
])
export const ClientMessageSchema = ClientMessageWireSchema.superRefine((message, context) => {
  const attachments = message.type === 'send_message'
    ? message
    : message.type === 'create_chat'
      ? message.openingMessage
      : undefined
  if (attachments === undefined || hasAtMostMessageAttachments(attachments)) return
  context.addIssue({
    code: z.ZodIssueCode.custom,
    message: `images and files may contain at most ${MAX_MESSAGE_ATTACHMENTS} attachments combined`,
    path: message.type === 'create_chat' ? ['openingMessage'] : [],
  })
})
export type ClientMessage = z.infer<typeof ClientMessageSchema>

export const TurnStateSchema = z.enum(['running', 'done', 'aborted', 'error'])
export type TurnState = z.infer<typeof TurnStateSchema>

export const BrowserToolNameSchema = z.enum([
  'browser_navigate',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_press',
  'browser_scroll',
  'browser_screenshot',
  'browser_tabs',
  'browser_fill_login',
])
export const BROWSER_TOOL_NAMES = BrowserToolNameSchema.options
export type BrowserToolName = z.infer<typeof BrowserToolNameSchema>

/**
 * One keyed list of a `directory_patch`: the items that differ from the listing the
 * socket last received, and the id sequence only when it changed. Without `order`
 * the base sequence stands with each changed item swapped in at its own place.
 */
const directoryListPatch = <T extends z.ZodTypeAny>(item: T) => z.object({
  changed: z.array(item),
  order: z.array(z.string()).optional(),
})

export const ServerMessageSchema = z.discriminatedUnion('type', [
  // Explicit success for a mutating request. Broadcast state remains canonical,
  // but it is no longer overloaded as proof that the request finished.
  z.object({ type: z.literal('ack'), requestId: RequestIdSchema, workChatId: z.string().optional() }),
  // Sent on connect and whenever the project/chat lists change.
  z.object({
    type: z.literal('directory'),
    projects: z.array(ProjectSchema),
    chats: z.array(ChatSchema),
    workHandoffs: z.array(WorkHandoffSchema).default([]),
    /**
     * Request ids a chat is blocked on right now, from the live broker. Not stored
     * on the chat: a process that died is not waiting, and a listing that remembered
     * otherwise would show Waiting on a turn nobody can still answer. Optional so a
     * listing from before this field existed still parses.
     */
    awaitingInput: z.record(z.string(), z.array(z.string())).optional(),
    /** Current turn ids by chat, used to clear stale running state after reconnect. */
    runningTurns: z.record(z.string(), z.array(z.string())).optional(),
    /**
     * Delegated children: every running one, plus the three most recent finished ones
     * per parent chat. The sidebar draws the running ones, the Subagents panel reads the
     * rest. Child threads never appear in `chats`, so an older client that does not know
     * the kind keeps its list.
     */
    subagents: z.array(SubagentSummarySchema).optional(),
    /**
     * Provider-run helpers that are running now. A list of their own, because a client
     * built before them would reject the whole listing over a summary without a model.
     */
    nativeSubagents: z.array(NativeSubagentSchema).optional(),
    /**
     * Chats whose turn ended while background work it started (a helper or a shell)
     * still runs in its persona's live session. Such a chat still reads as working.
     */
    backgroundChatIds: z.array(z.string()).optional(),
  }),
  // A `directory` as the change from the last one this socket received, sent only to
  // a client that opened it with `directory=patch`. The client turns it back into a
  // whole `directory` with `applyDirectoryPatch`, so reducers only ever see that one.
  z.object({
    type: z.literal('directory_patch'),
    projects: directoryListPatch(ProjectSchema),
    chats: directoryListPatch(ChatSchema),
    workHandoffs: directoryListPatch(WorkHandoffSchema),
    /** Absent when the listing it stands for has no `subagents`. */
    subagents: directoryListPatch(SubagentSummarySchema).optional(),
    awaitingInput: z.record(z.string(), z.array(z.string())).optional(),
    runningTurns: z.record(z.string(), z.array(z.string())).optional(),
    nativeSubagents: z.array(NativeSubagentSchema).optional(),
    backgroundChatIds: z.array(z.string()).optional(),
  }),
  // The household. Sent on connect and after every agent change, so an edited
  // persona reaches every open client at once. Manor has ONE roster shared by every
  // chat, so it deliberately does not ride along in `snapshot`: two copies of one
  // list is how a stale label gets on screen.
  z.object({ type: z.literal('roster'), agents: z.array(AgentConfigSchema) }),
  // Every routine in the house. Sent on connect and after every mutation, the way
  // `roster` is: routines are household state rather than chat state, so they
  // deliberately do not ride along in `snapshot`, and the whole list travels rather
  // than a delta because it is one short list for one user.
  z.object({ type: z.literal('routines'), routines: z.array(RoutineSchema) }),
  // Reply-only history for one routine: the newest `ROUTINE_HISTORY_LIMIT` runs plus
  // any older one still unread, newest first. `chatId` is the routine's DM target as
  // it stood, null for a project routine, so a panel can discard a late answer if the
  // routine was edited onto another destination meanwhile.
  z.object({
    type: z.literal('routine_runs'),
    routineId: z.string(),
    chatId: z.string().nullable(),
    runs: z.array(RoutineRunSchema).max(ROUTINE_HISTORY_LIMIT + ROUTINE_UNREAD_LIMIT),
  }),
  z.object({ type: z.literal('mcp_servers'), servers: z.array(McpServerConfigSchema) }),
  z.object({ type: z.literal('mcp_host_statuses'), statuses: z.array(McpHostStatusSchema) }),
  z.object({ type: z.literal('skills'), skills: z.array(SkillConfigSchema) }),
  z.object({ type: z.literal('skill_candidates'), skills: z.array(SkillCandidateSchema) }),
  z.object({
    type: z.literal('workflow_suggestions'),
    available: z.boolean(),
    suggestions: z.array(WorkflowSuggestionSchema),
  }),
  ComposioCatalogMessageSchema,
  ComposioAccountsMessageSchema,
  ComposioKeyMessageSchema,
  // Host ergonomics rather than workspace state. Null is the normal VPS state and
  // tells the client to leave external anchors entirely to its own browser.
  z.object({
    type: z.literal('host_capabilities'),
    externalBrowser: z.literal('dia').nullable(),
    repoFileApps: z.array(RepoFileAppSchema).optional(),
    /** RemCTL or remindctl is installed on this host, so the Reminders door can work. */
    reminders: z.boolean().optional(),
    /**
     * This host can choose a runtime for a first turn, so Auto mode exists here.
     * False on an install without the classifier key: the client then draws no Auto
     * switch and names the persona's own model. Absent is an older server, which had it.
     */
    auto: z.boolean().optional(),
    /**
     * The folders of the home room (`HOME_PROJECT_ID`), which is the memory folder. A
     * host fact rather than directory state: no project list holds that room, and a
     * client still needs its folders to offer files in a Session without a project.
     */
    homeFolders: z.array(z.string()).optional(),
  }),
  // Transport-only messages. The web renderer consumes these and forwards them to
  // the sandboxed Electron browser host; they never enter workspace state.
  z.object({
    type: z.literal('browser_tool_request'),
    requestId: z.string(),
    chatId: z.string(),
    // Who is driving. The panel names the persona while its action runs, so a page
    // that moves on its own is never anonymous. Carried per request rather than as
    // its own event: the request and its result already bracket exactly the moment
    // the status is true for.
    actor: z.object({ id: z.string(), name: z.string() }),
    // The turn whose MCP call this is. Stopping that turn cancels the action even while
    // another turn keeps the same tabs busy. Absent on the server's own context reads.
    turnId: z.string().optional(),
    tool: BrowserToolNameSchema,
    arguments: z.record(z.string(), z.unknown()),
  }),
  z.object({ type: z.literal('browser_session_close'), chatId: z.string() }),
  // To the desktop host on (re)connect: Browser-session turns already running, hidden
  // ones included. `running` is announced once, so a reconnect would otherwise leave
  // their tabs unheld while the agents keep working.
  z.object({
    type: z.literal('browser_session_turns'),
    turnIds: z.array(z.string()),
  }),
  // To the desktop host only: while armed, Escape is Manor's and stops the turn
  // that holds the desktop lease.
  // `armId` names an arm request; the host echoes it in `computer_stop_ack`. Escape
  // and a reload post `stopToken` to `stopUrl` from the shell itself, so the stop
  // never depends on this page or socket still being alive.
  z.object({
    type: z.literal('computer_stop_armed'),
    armed: z.boolean(),
    armId: z.number().int().optional(),
    stopToken: z.string().optional(),
    stopUrl: z.string().optional(),
  }),
  // Subscription headroom for the whole house. Sent on connect and after every
  // probe. Like `roster` it stays out of `snapshot`: it is not chat state, and a
  // second copy riding along per chat is how a stale percentage gets on screen.
  // A provider with no probe capability contributes no entry at all.
  z.object({ type: z.literal('provider_usage'), perProvider: z.array(ProviderUsageSchema) }),
  // Provider CLIs behind their newest release, house-wide. Sent on connect, after
  // every hourly check and on every updater state change. Empty means nothing to say.
  z.object({ type: z.literal('provider_updates'), updates: z.array(ProviderUpdateSchema) }),
  // Which provider CLIs are installed and signed in. Sent on connect and on every change.
  z.object({ type: z.literal('provider_connections'), providers: z.array(ProviderConnectionSchema) }),
  // Reply to get_usage_report, to the asking socket only. Not a broadcast: it is a
  // snapshot of a moment somebody asked about, and a second tab redrawing its Usage
  // view because a turn ended elsewhere is movement nobody asked for.
  z.object({ type: z.literal('usage_report'), report: UsageReportSchema }),
  // Reply to get_auto_rules, and broadcast after a saved rule file so every open
  // dialog shows what Auto will actually pick from.
  z.object({ type: z.literal('auto_rules'), rules: AutoRulesSchema, ...optionalRequestId }),
  // The subagent policy: the reply to `get_subagent_policy`, and broadcast after a save.
  z.object({ type: z.literal('subagent_policy'), policy: SubagentPolicySchema, ...optionalRequestId }),
  // Sent on connect and broadcast after a save. An older phone drops the unknown type.
  z.object({ type: z.literal('profile'), profile: UserProfileSchema }),
  // Sent on connect and broadcast after a save, like the profile.
  z.object({ type: z.literal('house_settings'), settings: HouseSettingsSchema }),
  // Reply to get_context_files, and after a save or a refused stale save, to that socket.
  z.object({ type: z.literal('context_files'), ...ContextFilesSchema.shape, ...optionalRequestId }),
  z.object({ type: z.literal('system_info'), info: SystemInfoSchema, ...optionalRequestId }),
  MyMindConnectionStatusSchema.extend({ type: z.literal('mymind_status') }),
  z.object({
    type: z.literal('mymind_objects'),
    requestId: z.string(),
    query: z.string(),
    append: z.boolean(),
    result: z.discriminatedUnion('status', [
      z.object({
        status: z.literal('ready'),
        objects: z.array(MyMindArtifactSchema),
        spaces: z.array(MyMindSpaceSchema),
        hasMore: z.boolean(),
      }),
      z.object({ status: z.literal('error'), message: z.string() }),
    ]),
  }),
  // Reply to open_chat: the full durable thread plus usage totals.
  z.object({
    type: z.literal('snapshot'),
    chatId: z.string(),
    events: z.array(ThreadEventSchema),
    /**
     * Echoes `open_chat.after` when `events` are only what follows that event. The
     * client keeps its own copy and appends them; absent means `events` are whole.
     */
    after: z.string().optional(),
    /** With `after`: events the client already holds that were rewritten since its `sync`. */
    replaced: z.array(ThreadEventSchema).optional(),
    /** Where this chat's rewrites stand. The client hands it back on its next `open_chat`. */
    sync: EventSyncSchema.optional(),
    usage: z.record(z.string(), UsageSchema),
    // The turn this chat has in flight right now, when it has one. `running` is
    // announced once and never repeated, so without this a client that reconnects
    // mid-turn would show an idle chat while the CLI keeps working.
    activeTurn: z
      .object({
        turnId: z.string(),
        agentId: z.string(),
        startedAt: z.number(),
        // Text that has crossed the provider seam but not its durable message
        // boundary yet. Optional keeps snapshots from older servers valid.
        messages: z.array(z.object({ messageId: z.string(), text: z.string() })).optional(),
        // Present while the turn answered and only waits on its background work.
        background: BackgroundWaitSchema.optional(),
        // The latest `turn_context` of this turn, when the driver reported one.
        context: LiveContextSchema.optional(),
      })
      .optional(),
    // The chat's session-only runtime overrides, keyed by agent id. Part of the
    // snapshot because they are chat state the same way the transcript is: a
    // client that opens the chat must see the model it actually runs on.
    overrides: z.record(z.string(), ChatOverrideSchema).optional(),
    // A child thread's own stored row, so the Subagents panel can describe a child the
    // sidebar's recent list no longer carries.
    subagent: SubagentSummarySchema.optional(),
  }),
  // Answer to create_project, sent only to the creating socket. A broadcast
  // directory can contain somebody else's concurrent create, so the creator
  // needs the exact id to continue its own flow. The request id is echoed when
  // present so a client can bind the result to the pending form submission.
  z.object({
    type: z.literal('project_created'),
    projectId: z.string(),
    ...optionalRequestId,
  }),
  // Answer to create_chat, sent only to the creating socket. A broadcast
  // directory can contain somebody else's concurrent create, so the creator
  // needs the exact id to know which chat to open. The request id binds late
  // replies to the form that actually sent them.
  z.object({ type: z.literal('chat_created'), chatId: z.string(), ...optionalRequestId }),
  // Answer to open_side_chat, sent only to the asking socket. Carries the parent as
  // well as the side chat: the panel is bound to the chat on screen, and by the time
  // this lands the user may have moved to another one.
  z.object({
    type: z.literal('side_chat'),
    parentChatId: z.string(),
    chatId: z.string(),
    // Already resolved, defaults applied, so the panel can label what it runs on
    // without carrying a second copy of what the default is.
    model: z.string(),
    effort: EffortSchema,
  }),
  // Echo of a side chat's own runtime pick, to the client that made it. Reply-only for
  // the same reason the open is: a panel is not in the directory, so no other client
  // is showing the thing that changed.
  z.object({
    type: z.literal('side_runtime'),
    chatId: z.string(),
    model: z.string(),
    effort: EffortSchema,
  }),
  // One chat's whole override set after a change, to every client: an override
  // is chat state, and a second tab showing the roster default while the chat
  // runs on something else is a stale label.
  z.object({
    type: z.literal('chat_overrides'),
    chatId: z.string(),
    perAgent: z.record(z.string(), ChatOverrideSchema),
  }),
  // A durable event was appended to a chat. Chats keep running server-side
  // whether or not the client is looking at them, so every chat-scoped message
  // carries its chatId and the client filters for the open chat.
  z.object({ type: z.literal('event'), chatId: z.string(), event: ThreadEventSchema }),
  z.object({
    type: z.literal('outbound_thread'),
    requestId: RequestIdSchema,
    draftId: z.string().min(1).max(120),
    result: z.discriminatedUnion('status', [
      z.object({
        status: z.literal('ready'),
        messages: z.array(OutboundThreadMessageSchema).max(50),
        truncated: z.boolean(),
        openUrl: z.string().url().max(2_000).optional(),
      }),
      z.object({ status: z.literal('error'), message: z.string() }),
    ]),
  }),
  // Streaming text for one provider-visible assistant message inside a turn. The
  // matching durable agent_message replaces it when that message completes.
  z.object({
    type: z.literal('delta'),
    chatId: z.string(),
    turnId: z.string(),
    agentId: z.string(),
    messageId: z.string(),
    text: z.string(),
  }),
  z.object({
    type: z.literal('turn_state'),
    chatId: z.string(),
    turnId: z.string(),
    agentId: z.string(),
    state: TurnStateSchema,
    // A provider attempt was replaced inside the same logical turn. Clients drop
    // only its unfinished text; durable work and the running timer stay in place.
    reset: z.boolean().optional(),
    // Server clock, present while the state is 'running'. The elapsed timer reads
    // this rather than client arrival time, so a reconnect does not restart it.
    startedAt: z.number().optional(),
    // A quiet DM routine has no user-facing result to announce.
    routineOutcome: z.enum(['quiet', 'publish']).optional(),
    // How a routine turn's end is announced. `alert`, a notifying one-time result:
    // however short, because nobody watched it start and the floor exists for turns
    // The user watched. `silent`, a routine with notify off: no Done notice at all.
    notice: z.enum(['alert', 'silent']).optional(),
    // The provider this turn actually ran on, pin included, on a terminal state. The
    // subscription-usage listener reads it: a turn ending is when a reading goes
    // stale, and with a per-chat provider pin the roster no longer says whose. Absent
    // when the turn died before its pin was read, where the roster is still right.
    driver: DriverSchema.optional(),
  }),
  // A running turn answered and now only waits on background work it started, or
  // stopped waiting. Zero counts end the wait. Sent on every change, unlike `running`.
  z.object({
    type: z.literal('turn_background'),
    chatId: z.string(),
    turnId: z.string(),
    agentId: z.string(),
    agents: z.number().int().min(0),
    commands: z.number().int().min(0),
  }),
  // A running turn's whole live context state, sent when it changes: throttled for
  // readings, at once for the start and end of a compaction. An older client drops it.
  z.object({
    type: z.literal('turn_context'),
    chatId: z.string(),
    turnId: z.string(),
    agentId: z.string(),
    context: LiveContextSchema,
  }),
  // Cumulative usage per agent id for one chat, pushed after each completed turn.
  z.object({
    type: z.literal('usage'),
    chatId: z.string(),
    perAgent: z.record(z.string(), UsageSchema),
  }),
  // Answer to a request that went nowhere, sent to the socket that asked. Not a
  // thread event: an unusable repo path is a fact about the request, not about a
  // chat, and the alternative is a UI where attaching silently does nothing.
  z.object({
    type: z.literal('notice'),
    kind: z.enum(['error', 'info']),
    text: z.string(),
    requestId: RequestIdSchema.optional(),
  }),
  // Proof of life, broadcast on a timer. Carries nothing: its only job is to give
  // the client something to measure silence against, because a half-open socket
  // stays readyState OPEN and never fires a close event.
  z.object({ type: z.literal('heartbeat') }),
  // One directory's subdirectories, for the folder picker. Sent to the socket that
  // asked. `parent` is null at the filesystem root, which is what stops the "up"
  // control from walking off the end.
  z.object({
    type: z.literal('dir_listing'),
    path: z.string(),
    parent: z.string().nullable(),
    entries: z.array(z.object({ name: z.string(), path: z.string() })),
  }),
  z.object({
    type: z.literal('chat_summary'),
    ...optionalRequestId,
    chatId: z.string(),
    summary: z.object({
      text: z.string(),
      fromEventId: z.string().nullable(),
      fromAt: z.number().nullable(),
      throughEventId: z.string(),
      throughAt: z.number().nullable(),
      updatedAt: z.number(),
    }).nullable(),
    /** The persona's standing notes exactly as its turns receive them; absent when none are injected. */
    notes: z.object({
      path: z.string(),
      content: z.string(),
      truncated: z.boolean(),
    }).optional(),
  }),
  /** Reply to get_dm_files, to the socket that asked. Newest first. */
  z.object({ type: z.literal('dm_files'), ...optionalRequestId, chatId: z.string(), files: z.array(DmFileSchema) }),
  z.object({
    type: z.literal('agent_notes'),
    ...optionalRequestId,
    agentId: z.string(),
    /** Absent when memory is off or the agent keeps none: the same rule its turns follow. */
    notes: z.object({
      path: z.string(),
      content: z.string(),
      truncated: z.boolean(),
    }).optional(),
  }),
  z.object({
    type: z.literal('project_memory'),
    ...optionalRequestId,
    projectId: z.string(),
    files: z.array(z.object({
      path: z.string(),
      kind: z.enum(['index', 'file']),
      modifiedAt: z.number(),
      content: z.string(),
    })),
    truncated: z.boolean(),
    // A project thread's latest write to each of its files and cards: who, when and which line.
    writes: z.array(z.object({
      path: z.string(),
      by: z.string(),
      at: z.number(),
      action: ProjectFileWriteSchema.shape.action,
      line: z.string().optional(),
    })).optional(),
  }),
  // One project's mentionable files, sent to the socket that asked. Paths are
  // `<folder-name>/<path-inside-it>`, the same string the composer inserts and the
  // same one `REPO_FILE_NOTE` teaches the persona to resolve. `truncated` says the
  // cap cut the list, so the menu can admit that rather than imply completeness.
  z.object({
    type: z.literal('repo_files'),
    projectId: z.string(),
    chatId: z.string().optional(),
    files: z.array(z.string()),
    truncated: z.boolean(),
  }),
  // One bounded, reply-only file preview. Echoing project + path lets a client
  // discard a response after the user has already selected another file.
  z.object({
    type: z.literal('repo_file'),
    projectId: z.string(),
    chatId: z.string().optional(),
    path: z.string(),
    result: RepoFileResultSchema,
  }),
  // The answer to one `write_repo_file`, echoed the same way, so a save answered
  // after the user moved to another file lands on nothing.
  z.object({
    type: z.literal('repo_write'),
    projectId: z.string(),
    chatId: z.string().optional(),
    path: z.string(),
    result: FileWriteResultSchema,
  }),
  // Answer to `checkout_status`, to the asking socket. `leftover` is set when the
  // deterministic path exists and the mapping is empty, so the row can offer
  // discard and resume after a switch back to current.
  z.object({
    type: z.literal('checkout_status'),
    chatId: z.string().optional(),
    projectId: z.string().optional(),
    mode: z.enum(['current', 'worktree']),
    branch: z.string().nullable(),
    dirty: z.boolean(),
    gitRoots: z.array(z.string()),
    leftover: z.object({ branch: z.string(), dirty: z.boolean() }).optional(),
    // One list for the chat's shared branch name. A name is unavailable when any
    // mapped repo would refuse it. Empty when the project has no git folder.
    branches: z.array(CheckoutBranchSchema).default([]),
    // Worktree mode only: the branch every linked folder is on, absent when they
    // disagree. A goal Session's Confirm offers the merge into exactly this branch.
    homeBranch: z.string().optional(),
  }),
  // Answer to `session_repo`. `changes` is the whole-Session scope, the same files the
  // diff lists. `waiting` is a result waiting for Confirm: its scope is exactly what
  // Confirm lands, and Commit is refused. `excluded` counts the Session's changed files
  // that result leaves out, the diff's Not included. `error` when the checkout could not be read.
  z.object({
    type: z.literal('session_repo'),
    chatId: z.string(),
    waiting: z.boolean(),
    changes: z.object({
      files: z.number().int().nonnegative(),
      added: z.number().int().nonnegative(),
      removed: z.number().int().nonnegative(),
    }),
    excluded: z.number().int().nonnegative().optional(),
    repos: z.array(SessionRepoSchema),
    error: z.string().optional(),
  }),
  // Answer to `session_diff`. `partial` when the size limits left part of it out.
  z.object({
    type: z.literal('session_diff'),
    chatId: z.string(),
    ignoreWhitespace: z.boolean(),
    waiting: z.boolean(),
    files: z.array(SessionDiffFileSchema).max(MAX_SESSION_DIFF_FILES),
    partial: z.boolean(),
    error: z.string().optional(),
  }),
  // What a Commit or Push did, in one sentence. A Push answers the asking socket; a
  // Commit runs on after its ack and is broadcast when it ends. A failed Commit carries
  // the ticked files and the message the user wrote, so its dialog reopens as they left it.
  z.object({
    type: z.literal('session_git_result'),
    chatId: z.string(),
    root: z.string(),
    action: z.enum(['commit', 'push']),
    ok: z.boolean(),
    text: z.string(),
    // After a Push: the page the remote itself offered for opening a pull or merge
    // request on `branch`. Absent when the remote offered none.
    link: z.object({ label: z.string(), url: z.string(), branch: z.string() }).optional(),
    files: z.array(z.string()).optional(),
    message: z.string().optional(),
    requestId: RequestIdSchema.optional(),
  }),
  // Every Session Commit still running on this host, the whole list each time. Sent on
  // connect and whenever one starts or ends, so the in-progress state is never stale.
  z.object({
    type: z.literal('session_commits'),
    commits: z.array(z.object({ chatId: z.string(), root: z.string(), files: z.number().int().nonnegative() })),
  }),
  // Whether this server has a vault at all, pushed on connect beside the roster.
  // `available: false` is the ordinary state on a machine that is not the user's
  // laptop, and the client hides the tab rather than showing one that cannot work.
  // `name` is the folder's basename, which is what the tab is called.
  z.object({
    type: z.literal('vault_status'),
    available: z.boolean(),
    name: z.string().nullable(),
    // The vault's absolute path on the machine Manor runs on. Deliberately the one
    // place a server path crosses the wire: Manor has one user, the vault is on the user's
    // own machine, and "copy this note's path" is worth more than the symmetry with
    // repo files, where several folders are resolved server side per project.
    root: z.string().nullable().default(null),
    // Where a deleted note or folder goes, so the confirm can say so before it happens.
    trash: z.string().nullable().optional(),
  }),
  // Every note in the vault, as paths relative to its root. Flat, because the client
  // already builds a tree from a path list, and because wikilink resolution needs
  // the whole list in memory anyway — server-side resolution would make every link
  // in a note a round trip.
  z.object({ type: z.literal('vault_files'), files: z.array(z.string()), folders: z.array(z.string()).optional(), previews: z.record(z.string()).optional(), truncated: z.boolean() }),
  z.object({ type: z.literal('vault_folder_created'), path: z.string(), result: z.union([z.object({ status: z.literal('created') }), z.object({ status: z.literal('rejected'), message: z.string() })]) }),
  z.object({ type: z.literal('vault_file'), path: z.string(), result: RepoFileResultSchema }),
  z.object({ type: z.literal('vault_renamed'), requestId: z.string(), path: z.string(), newPath: z.string(), result: z.union([z.object({ status: z.literal('renamed'), revision: z.string() }), z.object({ status: z.literal('rejected'), message: z.string() })]) }),
  z.object({ type: z.literal('vault_write'), path: z.string(), result: FileWriteResultSchema, preview: z.string().optional() }),
  // The answer to one `edit_vault_note`, to the asker only: the replacement for the
  // selection, or the whole edited note. A proposal, never a write.
  z.object({
    type: z.literal('vault_note_edit'),
    requestId: z.string(),
    result: z.union([
      z.object({ status: z.literal('ready'), text: z.string() }),
      z.object({ status: z.literal('failed'), message: z.string() }),
    ]),
  }),
  // Broadcast when a delete lands, so every client drops the entry and closes an editor
  // on it; a refusal goes to the asker only. `trashPath` is where it now lives.
  z.object({
    type: z.literal('vault_deleted'),
    requestId: z.string(),
    path: z.string(),
    result: z.union([
      z.object({ status: z.literal('deleted'), kind: z.enum(['note', 'folder']), trashPath: z.string() }),
      z.object({ status: z.literal('rejected'), message: z.string() }),
    ]),
  }),
  // Broadcast when a move lands, so every client follows an editor open on the moved note
  // or on a note inside the moved folder; a refusal goes to the asker only. A `newPath`
  // equal to `path` means it already sat in that folder, which is answered to the asker.
  z.object({
    type: z.literal('vault_moved'),
    requestId: z.string(),
    path: z.string(),
    result: z.union([
      z.object({ status: z.literal('moved'), kind: z.enum(['note', 'folder']), newPath: z.string() }),
      z.object({ status: z.literal('rejected'), message: z.string() }),
    ]),
  }),
  // The answer to one `search`, to the asker only. Messages are capped per chat and in
  // total on the server; `query` echoes what was asked so a late answer can be dropped.
  z.object({
    type: z.literal('search_results'),
    requestId: z.string(),
    query: z.string(),
    messages: z.array(SearchMessageHitSchema),
    notes: z.array(SearchNoteHitSchema),
  }),
  // Every open reminder with its lists, answered to `reminders_load` and broadcast
  // after each write. `source: 'eventkit'` is the plain fallback: no sections,
  // assignees, flags, tags or subtasks, and `notice` says why in one line.
  // `unavailable` means neither RemCTL nor remindctl could be read.
  z.object({
    type: z.literal('reminders_state'),
    status: z.enum(['ready', 'unavailable']),
    source: z.enum(['remctl', 'eventkit']),
    notice: z.string().optional(),
    /** Changes whenever anything in the store changed, so an identical poll repaints nothing. */
    revision: z.string(),
    /** Today in Europe/Amsterdam on the host, the day Today and Overdue are measured from. */
    today: z.string(),
    groups: z.array(z.object({ id: z.string(), title: z.string() })),
    lists: z.array(ReminderListSchema),
    reminders: z.array(ReminderSchema),
    /** Null when the source cannot count them cheaply (the plain fallback). */
    completedCount: z.number().int().min(0).nullable(),
  }),
  // Newest completion first, one page per request.
  z.object({
    type: z.literal('reminders_completed'),
    offset: z.number().int().min(0),
    reminders: z.array(ReminderSchema),
    total: z.number().int().min(0),
    nextOffset: z.number().int().min(0).nullable(),
  }),
])
export type ServerMessage = z.infer<typeof ServerMessageSchema>

// ---------------------------------------------------------------------------
// Runtime interface — agent config in, event stream out.
// Implemented per driver; nothing outside a driver may touch a CLI.
// ---------------------------------------------------------------------------

export type RuntimeEvent =
  | { type: 'delta'; messageId: string; text: string }
  // The authoritative complete text for one visible assistant message. Drivers
  // emit this before any following tool call, preserving provider event order.
  | { type: 'message'; messageId: string; text: string }
  | { type: 'attachment'; image: ImageAttachment }
  // One completed block of the model's own reasoning. Drivers emit it in provider
  // order, so it interleaves with tool calls rather than being collected at the end.
  | { type: 'reasoning'; text: string; parentToolCallId?: string }
  | { type: 'todo_update'; todos: TodoItem[] }
  | {
      type: 'outbound_draft'
      draftId?: string
      channel: OutboundChannel
      to: string
      subject?: string
      cc?: string
      body: string
      mailAccount?: OutboundMailAccount
      slackChannelId?: string
      slackThreadTs?: string
      slackRichText?: SlackRichText
      thread?: OutboundDraftThread
    }
  | {
      type: 'tool_use'
      toolCallId?: string
      parentToolCallId?: string
      tool: string
      agentType?: string
      subagent?: SubagentLaunch
      detail?: string
      subject?: string
      targets?: string[]
      command?: string
      edits?: FileEdit[]
      /** Started work the persona does not wait for; its `tool_result` comes when that work ends. */
      background?: true
    }
  | { type: 'tool_result'; toolCallId: string; parentToolCallId?: string; outcome: 'success' | 'error' | 'stopped'; tool?: string; subject?: string; output?: string; error?: string; usage?: Usage; reportedModel?: string; reportedEffort?: string; edits?: FileEdit[] }
  | {
      type: 'result'
      text: string
      usage?: Usage
      // Prompt size of the turn's final request; see TurnResultEventSchema.
      contextTokens?: number
      // CLI-reported window for that reading; see TurnResultEventSchema.
      contextWindow?: number
      /**
       * Token count at which this session gets compacted, when the driver knows it
       * exactly. Only Claude does, because Manor passes the threshold in on the argv.
       */
      autoCompactTokens?: number
      // What the CLI says served the turn; see TurnResultEventSchema. Absent when a
      // driver's output carries no model, which every driver has to answer for itself.
      reportedModel?: string
      // Provider evidence for Fast; see TurnResultEventSchema.
      observedSpeed?: 'fast'
      // Session id to persist for the next --resume of this thread + agent.
      sessionId?: string
      /**
       * The provider compacted this session's history during the turn. What the
       * session was told earlier is a summary now, so whatever Manor froze to keep
       * that prompt prefix cached buys nothing and is only stale.
       */
      compacted?: true
    }
  /**
   * Prompt size of the request that just answered, mid-turn: the same per-request
   * basis as the result's `contextTokens`, never a sum over the tool loop. Drivers
   * emit it only where the CLI reports usage per request. `autoCompactTokens` is
   * the result's threshold, so the live dial divides by what the settled one will.
   */
  | { type: 'context'; contextTokens: number; contextWindow?: number; autoCompactTokens?: number }
  /**
   * The CLI compacts this session's history now (`start`), has finished (`end`), or
   * gave up with the history unchanged (`failed`). `contextTokens` on `end` is the
   * compacted size when the CLI names it.
   */
  | { type: 'compaction'; phase: 'start' | 'end' | 'failed'; contextTokens?: number }
  // The turn answered and now only waits on background work; zero counts end the wait.
  | ({ type: 'background_wait' } & BackgroundWait)
  // Background work a provider cannot keep past its turn (Grok), named once as stopped
  // there. `unconfirmed` when Manor could not confirm its processes ended.
  | { type: 'background_stopped'; titles: string[]; unconfirmed?: true }
  | {
      type: 'error'
      message: string
      /** The driver proved that resuming this same provider session is safe once. */
      retryable?: boolean
      sessionId?: string
      usage?: Usage
    }

export interface CatchUpSummary {
  text: string
  throughEventId: string
  /** Bounded exact historical records, re-read from the canonical transcript. */
  retainedEvidence?: string
}

/**
 * Turn context that changes more often than the persona does: a project thread's notes
 * and Sessions list, a project's preferences, retrieved memory files and skills picked
 * for this turn. Drivers deliver each in the turn's message only when it changed since
 * the last confirmed delivery to that provider session, and withdraw one that is gone,
 * so `agent.character` stays byte-stable and the provider's prompt cache holds.
 */
export const VOLATILE_BLOCK_KEYS = ['notes', 'sessions', 'preferences', 'structured-indexes', 'structured-retrieved', 'selected-skills'] as const
export type VolatileBlockKey = (typeof VOLATILE_BLOCK_KEYS)[number]
export interface VolatileBlock {
  key: VolatileBlockKey
  text: string
}

export interface TurnInput {
  agent: AgentConfig
  /** In key order; see `VolatileBlock`. Absent means none this turn, which withdraws any delivered earlier. */
  volatileBlocks?: VolatileBlock[]
  /** Content-free process milestones for local runtime diagnostics. */
  onStage?: (stage: 'processStarted' | 'processInitialized' | 'threadReady') => void
  /** No household context or routing; provider-native helpers inherit this runtime. */
  singleSession?: boolean
  /** Higher-throughput subscription tier for this turn; absent is Standard. */
  speed?: 'fast'
  threadId: string
  // Empty scratch directory this thread's turns run in. Never a real repo: it is
  // also where the Codex driver writes its per-persona AGENTS.md, so pointing it at
  // the project's repo would overwrite a real file there.
  cwd: string
  // The project's folders, empty when it has none. ADDITIONAL directories the
  // persona may work in, never the cwd. Personas have full read and write access to
  // them, so these are the user's real working copies and edits are real.
  repoPaths: string[]
  /**
   * When this turn is isolated, the catch-up names the worktree rather than the
   * shared copy. Absent means current checkout, which keeps `REPO_ACCESS_NOTE`.
   */
  repoAccess?: {
    mode: 'worktree'
    /** Live HEAD. Null when the worktrees do not share a branch, or HEAD is unreadable. */
    branch: string | null
    sources: { sourcePath: string; worktreePath: string }[]
  }
  // Durable events the persona has not seen yet, oldest first.
  catchUp: ThreadEvent[]
  /**
   * Manor-owned context before `catchUp`, present only for a fresh session whose
   * event list starts immediately after this durable cursor.
   */
  catchUpSummary?: CatchUpSummary
  // True when the CLI holds none of this chat yet. `catchUpSummary` plus `catchUp`
  // then represents the whole usable context; without a summary, catchUp is the thread.
  isFullCatchUp: boolean
  /**
   * True for Manor's own disposable jobs (title, summary). Their output is an
   * artifact, not a reply to the user, so the house style pin is left out of the prompt.
   */
  infrastructure?: boolean
  /** A DM turn: prose before a tool call shows as its own bubble, so the house style pin carries the DM rule. */
  dm?: true
  /** Disposable jobs may disable prompt caching. Claude honours this; other drivers use their native default. */
  promptCaching?: 'off'
  /**
   * Manor, rather than the user, started this follow-up turn. Drivers with an explicit
   * Ask/Agent choice must keep it in Agent mode; Ask belongs only to a turn the user
   * deliberately started with a tool-less persona.
   */
  manorFollowUp?: boolean
  /**
   * Conversation from somewhere else that this turn is about, rendered by the server
   * and placed ahead of the catch-up. A side chat is the only thing that sets it: the
   * block is the main chat it hangs off. Read-only context, never this thread.
   */
  contextBlock?: string
  // Session id from this persona's previous turn in this thread, if any.
  sessionId?: string
  /** Materialised copies of images in catchUp, available to the multimodal CLI. */
  imagePaths?: string[]
  /**
   * The persona's MCP attachments with their registry rows already resolved, so a
   * driver renders argv from what it is handed and never reaches for a store. Empty
   * when the persona has none, which is also what makes the flag disappear entirely.
   */
  mcpServers?: AttachedMcpServer[]
  /**
   * A turn in a room that wakes: background work still running at its result may
   * outlive it in a live session, and the persona's next turn here attaches to that.
   * Absent keeps the in-turn hold, for turns somebody waits on as one answer.
   */
  live?: true
  /**
   * The wake turn of a live session whose CLI asked to run on its own: it carries
   * that run, so the driver writes no prompt. Ignored when no wake is held.
   */
  wakeRun?: true
}

/** Background work a live session still runs, by the launch row it settles. */
export interface LiveSessionItem {
  toolCallId: string
  title: string
  kind: 'agent' | 'command'
}

/**
 * A provider process a persona keeps in one thread after its turn ended, because
 * background work it started still runs. The persona's next turn attaches to it.
 */
export interface LiveSessionInfo {
  driver: AgentConfig['driver']
  sessionId: string | undefined
  model: string | undefined
  effort: AgentConfig['effort']
  running: LiveSessionItem[]
  /** The CLI asked to run on its own; it waits, paused, until a wake turn attaches. Codex never does. */
  wakeHeld: boolean
}

/** What a live session reports while no turn of its persona runs. */
export type LiveSessionEvent =
  /** A launch row's background work ended; the row lives in an earlier turn. */
  | { type: 'row'; threadId: string; agentId: string; event: Extract<RuntimeEvent, { type: 'tool_result' }> }
  /**
   * Background work ended and the persona should continue. Admit it with a wake turn,
   * which carries the CLI's own run (`wakeRun`) when the session holds one, or close the session.
   */
  | { type: 'wake'; threadId: string; agentId: string; ended: { toolCallId: string; title: string; state: 'done' | 'failed' | 'stopped' }[] }
  /** The session is gone; nothing of it runs any more. */
  | { type: 'closed'; threadId: string; agentId: string }

/** One resolved attachment: the registry row plus this persona's exclusions. */
export interface AttachedMcpServer {
  server: McpServerConfig
  disabledTools: string[]
  /** Per-turn values that never enter the registry, argv, or the server process env. */
  runtimeEnv?: Record<string, string>
}

export interface TurnHandle {
  events: AsyncIterable<RuntimeEvent>
  /** Refused means no delivery; uncertain must never be automatically replayed. */
  steer?(event: Extract<ThreadEvent, { type: 'user_message' }>): Promise<'accepted' | 'refused' | 'uncertain'>
  // Kill the underlying process; the driver must then end the stream.
  stop(): void
}

export interface CompactSessionInput {
  agent: AgentConfig
  sessionId: string
  threadId: string
  cwd: string
  repoPaths: string[]
  singleSession?: boolean
  speed?: 'fast'
  mcpServers?: AttachedMcpServer[]
}

export type CompactSessionResult = { ok: true } | { ok: false; reason: string }

export interface Driver {
  startTurn(input: TurnInput): TurnHandle
  /** Read-only version probe of the exact command this driver resolves. */
  describeRuntime?(): Promise<{ command: string; version: string | null }>
  /** Whether the CLI holds a login, asked of the CLI itself. Never rejects. */
  describeAccount?(): Promise<ProviderAccount>
  /** The command that signs the user in; null while there is no CLI to run it. Absent where the provider offers none. */
  signInCommand?(): Promise<ProviderSignIn | null>
  /**
   * The provider's own installer, for a CLI that is not on this Mac. Absent where Manor
   * has no installer it can run unattended. It runs only on the user's click.
   */
  installCommand?(): Promise<ProviderSignIn>
  /**
   * Compact the live CLI session in place. Absent means the orchestrator rolls
   * over instead. Same handle shape as a turn so Stop can kill the CLI.
   * Not a user-typed slash line in the Manor transcript.
   */
  compactSession?(input: CompactSessionInput): TurnHandle
  /**
   * House-wide subscription limits for this driver's provider.
   *
   * Optional on purpose. A driver with no subscription behind it (the mock, a
   * future API-key driver) omits it and contributes nothing to the panel, which
   * is the honest answer; a required method would force it to invent one.
   *
   * The probe lives here rather than in feature code because it spawns a CLI, and
   * nothing outside a driver is allowed to do that. Implementations resolve to
   * `status: 'unavailable'` for every failure and never reject.
   */
  readProviderUsage?(): Promise<ProviderUsage>
  /**
   * Installed version against the newest release on this provider's channel.
   * Null when the newest cannot be known. Never rejects.
   */
  checkForUpdate?(): Promise<ProviderVersionCheck | null>
  /**
   * Run the provider's own updater. Present only where Manor may run it; running
   * CLI processes keep their version, the next turn spawns the new one.
   */
  installUpdate?(): Promise<{ ok: true } | { ok: false; reason: string }>
  /**
   * Starts installing the runtime when Manor owns it and none is usable yet, so the
   * install shows before a turn waits on it. Null when a usable one is installed.
   */
  prepareRuntime?(): Promise<{ version: string; done: Promise<{ ok: true } | { ok: false; reason: string }> } | null>
  /** The live session this persona keeps in this thread, if the driver can keep one. */
  liveSession?(threadId: string, agentId: string): LiveSessionInfo | undefined
  /** Threads where a live session of this driver still runs background work, whoever the persona was. */
  busyLiveThreads?(): string[]
  /**
   * Ends a live session and the background work in it, or every live session in the
   * thread when no persona is named. Returns the titles of the work it stopped.
   */
  closeLiveSession?(threadId: string, agentId?: string): string[]
}

// ---------------------------------------------------------------------------
// Desktop browser spike
// ---------------------------------------------------------------------------

/** Bounds in renderer CSS pixels, translated directly to Electron display pixels. */
export interface BrowserViewportBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserInteractiveElement {
  selector: string
  tag: string
  role?: string
  label?: string
  text?: string
  type?: string
  bounds: BrowserViewportBounds
}

export interface BrowserConsoleEntry {
  level: string
  text: string
  timestamp: number
}

/**
 * What an agent reads off the shared page. Text and structure only: pixels are a
 * separate tool, because reading a vacancy costs a few thousand characters here and
 * an image plus an accessibility tree everywhere else.
 */
export interface BrowserSnapshot {
  url: string
  title: string
  /** Optional for older desktop hosts; used to judge keypress effects. */
  focusedSelector?: string | null
  visibleText: string
  interactiveElements: BrowserInteractiveElement[]
  console: BrowserConsoleEntry[]
}

export interface BrowserScreenshot {
  url: string
  title: string
  screenshot: string
}

/** Responsive testing changes CSS dimensions, without impersonating a device or its user agent. */
export interface BrowserDeviceViewport {
  width: number
  height: number
}

export interface BrowserPageSettings {
  viewport: BrowserDeviceViewport | null
  appearance: 'system' | 'light' | 'dark'
  zoomFactor: number
}

/** One page in one chat's browser. The renderer draws the strip from these. */
export interface BrowserTabState {
  /** Absent in older desktop shells. Settings live for this tab, not across restarts. */
  settings?: BrowserPageSettings
  id: string
  title: string
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /**
   * The site's own mark as a data URL, or absent. Fetched in the main process
   * through the browser's own session and inlined, so the app shell never makes a
   * request to a page the user visited and the content policy needs no exception.
   */
  favicon?: string
  /** Pinned tabs sit before regular tabs and show only their favicon. */
  pinned?: boolean
  /** A popup that opened behind the active tab and has not been selected yet. */
  unseen?: boolean
  /**
   * A sign-in popup this tab opened, drawn inside the page area instead of as a
   * separate window. Present only while it is open; `url` is its current address,
   * so the chrome can show where the password is really going.
   */
  signIn?: { url: string; loading?: boolean }
  /**
   * Saved logins for the page's site (or its open sign-in popup) and a pending offer
   * to save one the user just submitted. Desktop only; never reaches the server or an
   * agent, and never carries a password.
   */
  passwords?: BrowserTabPasswords
  /** Ad and tracker blocking on this page's site. Absent for non-web pages and older shells. */
  adblock?: BrowserTabAdblock
}

export interface BrowserTabAdblock {
  /** False once the user switched blocking off for this page's host. */
  blocking: boolean
  /** Requests blocked on the page since it last committed a navigation. */
  blocked: number
}

export interface BrowserTabPasswords {
  logins: Array<{ id: string; username: string }>
  offer?: { kind: 'save' | 'update'; origin: string; username: string }
}

/** A saved browser login as the settings list shows it; the password stays in the desktop host. */
export interface BrowserSavedLogin {
  id: string
  origin: string
  username: string
  source: 'manor' | 'dia'
  updatedAt: number
}

/** The settings list: saved logins plus the sites where saving was switched off. */
export interface BrowserSavedPasswords {
  logins: BrowserSavedLogin[]
  neverSave: Array<{ origin: string; source: 'manor' | 'dia' }>
}

export type BrowserPasswordOfferChoice = 'save' | 'never' | 'dismiss'

/**
 * What an agent's fill request learns about the active tab's saved login: its exact
 * origin and username, never the password. `login` is absent when nothing is saved
 * for that origin; `passwordField` says whether the page has one to fill.
 */
export interface BrowserLoginLookup {
  tabId: string
  /** The page inside the tab, its sign-in popup when one is open; the fill refuses any other. */
  pageId: number
  origin: string
  login?: { id: string; username: string }
  passwordField: boolean
}

/** The login a fill card named, bound to its tab and origin when the user clicks Fill. */
export interface BrowserLoginFillTarget {
  tabId: string
  pageId: number
  origin: string
  loginId: string
}

/** A secret card's value, bound to the tab and origin the card named. */
export interface BrowserSecretFillTarget {
  tabId: string
  pageId: number
  origin: string
  value: string
}

/**
 * Pushed by the desktop host whenever a chat's browser changes shape: a tab opened,
 * closed, navigated, finished loading or became the active one. The renderer holds
 * no browser state of its own, so this is the only thing the strip renders from.
 */
export interface BrowserSessionState {
  /** A separate passive window mirrors the active page. */
  previewWindowOpen?: boolean
  chatId: string
  tabs: BrowserTabState[]
  activeTabId: string | null
}

/** One searchable visit, merged across the replaceable Dia import and Manor's own log. */
export interface BrowserHistoryEntry {
  url: string
  title: string
  visitCount: number
  /** Unix milliseconds, so renderer formatting never depends on Chromium's epoch. */
  lastVisitedAt: number
  /** The site's last known mark as a data URL, kept per host after its tabs close. */
  favicon?: string
}

/**
 * What the address bar completes and suggests from. A site is one host with its visits
 * summed and its root as the address, so a host's sub-pages never stand in for it.
 */
export interface BrowserAddressMatches {
  /** Hosts that start with the typed text, ignoring scheme and `www.`, most visited first. */
  sites: BrowserHistoryEntry[]
  /** Pages whose address or title contains the typed text, most used first. */
  pages: BrowserHistoryEntry[]
}

/** A web page some process on this Mac serves on localhost, offered by a new tab. */
export interface LocalServer {
  url: string
  port: number
  /** The page's own title, else the listening process's name. */
  title: string
}

export interface BrowserBookmark {
  url: string
  title: string
  addedAt: number
}

export type BrowserShortcut = 'new-tab' | 'close-tab' | 'focus-address' | 'reload' |
  'toggle-bookmark' | 'back' | 'forward' | 'next-tab' | 'previous-tab' |
  'find' | 'reopen-tab' | 'zoom-in' | 'zoom-out' | 'zoom-reset'

/** Find on page: `active` is the 1-based highlighted match, 0 with no matches. */
export interface BrowserFindResult {
  matches: number
  active: number
}

/**
 * The preload bridge. Page state belongs to one chat for its whole life, while login
 * storage belongs to Manor's shared persistent browser profile. Direct-message chats
 * also remember tab URLs and the active tab across idle teardown and restart. The
 * three page lifecycle verbs stay distinct: `show` puts one chat's live page under
 * the panel, `hide` parks it, and `close` destroys that chat's tabs and any
 * remembered strip.
 */
/** The Chromium browsers whose logins Manor can copy into its own browser. */
export const IMPORT_BROWSER_IDS = ['chrome', 'arc', 'brave', 'edge', 'dia'] as const
export type ImportBrowserId = (typeof IMPORT_BROWSER_IDS)[number]

export interface BrowserImportStatus {
  enabled: boolean
  /** Whether the chosen browser has a profile to copy on this Mac. */
  available: boolean
  /** The browser the copy comes from, or would come from once it is switched on. */
  browser: ImportBrowserId
  /** Every browser Manor can copy from, and whether it is on this Mac. */
  browsers: { id: ImportBrowserId; name: string; installed: boolean }[]
  profileName?: string
  error?: string
  warning?: string
}

/** In-memory desktop preview; never persisted in the chat or sent to a provider. */
export interface BrowserPreviewImage {
  screenshot: string
  /** Original viewport aspect ratio; the JPEG is bounded to 960 pixels per edge. */
  width: number
  height: number
}

export type BrowserPreviewUpdate = { chatId: string; subscriptionId: string } & (
  | ({ status: 'frame'; tabId: string } & BrowserPreviewImage)
  | { status: 'stopped' | 'unavailable' }
)

/** A persistent renderer guest. Reposition it; never remount it when changing panels. */
export interface BrowserWebviewSurface {
  id: string
  /** A new token replaces a destroyed guest and rejects late attachment acknowledgements. */
  token: string
  partition: string
  /** Inert initial document supplied by the host; later navigation belongs to BrowserTab. */
  src: string
  /** Monotonic layout revision acknowledged after the renderer applies these bounds. */
  revision: number
  /** Shell CSS pixels, including the centered fit already calculated by the host. */
  bounds: BrowserViewportBounds
  presentation: 'hidden' | 'sidebar' | 'floating'
  /** Keep a parked guest painting behind the app during input or capture. */
  painting?: true
  /**
   * The page fills its frame with no emulated viewport to fit. A sidebar guest then
   * follows the frame the renderer measures, without waiting for these bounds.
   */
  fill?: true
  /**
   * A trackpad pinch magnifies the page like an image, without relayout. `x` and `y`
   * are the visible top-left as fractions of the page viewport; absent at 100%.
   */
  magnify?: BrowserMagnification
}

export interface BrowserMagnification { scale: number; x: number; y: number }

export interface BrowserWebviewSnapshot {
  /** Prevents an initial list response from replacing a newer push. */
  revision: number
  surfaces: BrowserWebviewSurface[]
}

export interface DesktopBrowserWebviewsBridge {
  list(): Promise<BrowserWebviewSnapshot>
  onChange(listener: (snapshot: BrowserWebviewSnapshot) => void): () => void
  attach(id: string, token: string, webContentsId: number): Promise<void>
  presented(id: string, token: string, revision: number): Promise<void>
}

/**
 * The session key of the app-owned Browser tab set. It sits where a chat id goes in
 * every browser verb and is never a chat, so no chat close or delete can reach it.
 */
export const BROWSER_HOME_SESSION_ID = 'browser:home'

export interface DesktopBrowserBridge {
  /** Available when the desktop host uses persistent DOM webviews. */
  webviews?: DesktopBrowserWebviewsBridge
  /**
   * `retiredPersistFlag` is unused. Every chat now remembers its tab list; the slot stays
   * so installed shells keep reading `presentation` from the same position.
   */
  show(bounds: BrowserViewportBounds, chatId: string, retiredPersistFlag?: boolean, presentation?: 'sidebar' | 'floating'): Promise<void>
  hide(): Promise<void>
  close(chatId: string): Promise<void>
  /** An agent's turn is using this chat's browser, so its parked page stays live. Absent in older shells. */
  beginAgentUse?(chatId: string): Promise<void>
  /** Clears retained cursors and interrupts input when their agent ends or stops. */
  endAgentUse?(chatId: string): Promise<void>
  /** Interrupts the action in flight for a stopped turn while other turns keep the tabs held. Absent in older shells. */
  interruptAgentInput?(chatId: string): Promise<void>
  /** One floating preview at a time. Manual mode survives agent completion; tokens protect against stale cleanup. */
  startPreview?(chatId: string, subscriptionId: string, mode?: 'agent' | 'manual'): Promise<void>
  stopPreview?(subscriptionId: string): Promise<void>
  onPreview?(listener: (update: BrowserPreviewUpdate) => void): () => void
  navigate(url: string, chatId: string): Promise<{ url: string; title: string }>
  snapshot(chatId: string): Promise<BrowserSnapshot>
  click(selector: string, chatId: string): Promise<{ url: string; title: string; selector: string }>
  type(selector: string, text: string, chatId: string): Promise<{ selector: string }>
  press(key: string, chatId: string): Promise<{ key: string }>
  scroll(deltaX: number, deltaY: number, chatId: string): Promise<{ deltaX: number; deltaY: number }>
  screenshot(chatId: string): Promise<BrowserScreenshot>
  /** The tab strip. `select` with no id lists; the agent reaches these too. */
  tabs(chatId: string, select?: string): Promise<BrowserSessionState>
  /** With a URL, creates and navigates the tab as one shared-browser action. */
  newTab(chatId: string, url?: string): Promise<BrowserSessionState>
  closeTab(tabId: string, chatId: string): Promise<BrowserSessionState>
  /** Closes only the tab's sign-in popup and shows its page again. Absent in older shells. */
  cancelSignIn?(tabId: string, chatId: string): Promise<void>
  /** Moves a tab into or out of the pinned group. Absent in older shells. */
  pinTab?(tabId: string, chatId: string, pinned: boolean): Promise<BrowserSessionState>
  /**
   * Drops a tab at `index` in the strip, kept inside its own group: a pinned tab stays
   * among the pins, an ordinary one after them. Absent in older shells.
   */
  moveTab?(tabId: string, chatId: string, index: number): Promise<BrowserSessionState>
  goBack(chatId: string): Promise<void>
  goForward(chatId: string): Promise<void>
  reload(chatId: string): Promise<void>
  stopLoading(chatId: string): Promise<void>
  /** Browser menu actions are optional for older shells and absent outside desktop. */
  configure?(chatId: string, settings: Partial<BrowserPageSettings>): Promise<void>
  hardReload?(chatId: string): Promise<void>
  openDevTools?(chatId: string): Promise<void>
  /** Moves the same active page to a native window; closing it returns the page. */
  openPreviewWindow?(chatId: string): Promise<void>
  /** These clear only cookies or HTTP cache in the shared browser profile. */
  clearCookies?(): Promise<void>
  clearCache?(): Promise<void>
  /**
   * Turns ad blocking on or off for the active tab's host, remembered across restarts,
   * then reloads the page. Absent in older shells.
   */
  setSiteAdblock?(chatId: string, blocking: boolean): Promise<void>
  /** Recent visits from Manor plus the current read-only Dia history import. */
  history?(query?: string): Promise<BrowserHistoryEntry[]>
  /** Sites and pages for what is typed in the address bar. Absent in older shells, which fall back to `history`. */
  addressMatches?(query: string): Promise<BrowserAddressMatches>
  /** Shared saved pages, independent of the browser profile and history. */
  bookmarks?(): Promise<BrowserBookmark[]>
  /** Local dev servers that answer with a web page. Absent in older shells. */
  localServers?(): Promise<LocalServer[]>
  toggleBookmark?(url: string, title: string): Promise<BrowserBookmark[]>
  /**
   * Saved passwords, desktop only and absent in older shells. Filling happens only on
   * The user's click, into the active tab's page when its site matches the login.
   */
  fillPassword?(chatId: string, loginId: string): Promise<void>
  answerPasswordOffer?(chatId: string, tabId: string, choice: BrowserPasswordOfferChoice): Promise<void>
  /**
   * An agent's fill request, in two steps around the user's card: find the saved login
   * for the active tab's exact origin, then fill it once the user clicked Fill. Neither
   * returns the password. Absent in older shells.
   */
  /** The page and password field a secret card would fill; saved logins play no part. */
  findPasswordField?(chatId: string): Promise<BrowserLoginLookup>
  findSavedLogin?(chatId: string, username?: string): Promise<BrowserLoginLookup>
  fillSavedLogin?(chatId: string, target: BrowserLoginFillTarget): Promise<{ username: string }>
  /**
   * A secret card's value, once, into the password field of the page the card named.
   * The host keeps it only to blank it from what that page shows an agent, until the
   * page moves on. Absent in older shells.
   */
  fillSecret?(chatId: string, target: BrowserSecretFillTarget): Promise<void>
  savedPasswords?(): Promise<BrowserSavedPasswords>
  /**
   * Removes one saved login or lifts Never for one site; without a target, everything.
   * Dia itself is untouched, so with Dia mode on its entries return at the next launch.
   */
  removeSavedPasswords?(target?: { loginId: string } | { neverSaveOrigin: string }): Promise<BrowserSavedPasswords>
  /**
   * Find on page in the active tab. `next` steps from the current match instead of
   * starting over; an empty query is refused, use `stopFind`. Absent in older shells.
   */
  findInPage?(chatId: string, query: string, options: { forward: boolean; next: boolean }): Promise<BrowserFindResult>
  stopFind?(chatId: string): Promise<void>
  /** Reopens the most recently closed tab of this chat, if any. Absent in older shells. */
  reopenClosedTab?(chatId: string): Promise<BrowserSessionState>
  /** Shortcuts received by the host from either chrome or a focused page. */
  onShortcut?(listener: (shortcut: BrowserShortcut) => void): () => void
  /** Whether keyboard focus is in the Browser chrome, rather than its adjacent chat. */
  setShortcutFocus?(focused: boolean): void
  /** Closes every tab and clears the shared persistent profile. */
  clearData(): Promise<void>
  /** The opt-in, Mac-only copy of another browser's active profile. Absent in older shells. */
  browserImportStatus?(): Promise<BrowserImportStatus>
  /**
   * Switches between Manor's ordinary profile and a managed copy of the named
   * browser's profile; without a name, the browser chosen before. Turning this off
   * deletes the copy before it reports success.
   */
  setBrowserImport?(enabled: boolean, browser?: ImportBrowserId): Promise<BrowserImportStatus>
  /** Lets the user quote one visible part of the active page. Escape returns null. */
  selectPageContext(chatId: string): Promise<PageContextAttachment | null>
  /** Push, not poll: the strip has to follow a page the agent moved. Returns its own undo. */
  onState(listener: (state: BrowserSessionState) => void): () => void
}

/** One chat that finished, as the desktop host is asked to announce it. */
export interface DesktopDoneNotice {
  chatId: string
  /** The chat, named the way its own row names it. */
  title: string
  /** The last thing said there, so the notice answers what happened. */
  body: string
}

/** A fast answer is over before leaving the app made its completion worth interrupting for. */
export const COMPLETION_NOTICE_FLOOR_MS = 10_000

/**
 * The desktop host's second narrow bridge, for work that finished while Manor was
 * not the app in front. The split of responsibility is deliberate: the renderer
 * decides *whether* a chat is done, because only it holds the activity state that
 * the inbox already derives Done from, and the host decides *whether to show*,
 * because window focus is the one fact the renderer cannot see. A backgrounded
 * Manor still runs its frame loop and still believes its document is visible.
 */
export interface DesktopNotifyBridge {
  /** Shows one notice, unless the Manor window has focus. Resolves either way. */
  show(notice: DesktopDoneNotice): Promise<void>
  /** The dock count. The same chats the inbox stands at Done; 0 clears the badge. */
  badge(count: number): Promise<void>
  /** A click on a notice, carrying the chat it was about. Returns its own undo. */
  onActivate(listener: (chatId: string) => void): () => void
}

/**
 * Whether the user is using the Mac, as the host sees it through the system idle clock and
 * the lock and suspend events. The renderer relays each value to the server socket.
 */
export interface DesktopPresenceBridge {
  /**
   * Fires with the current value now, then on every change and every heartbeat while
   * active. Returns its own undo.
   */
  onChange(listener: (active: boolean) => void): () => void
}

/**
 * The whole preload surface, one type for main-world and renderer. Optional
 * members exist so an older packaged shell can load today's page without
 * throwing; the current preload always fills them in.
 */
/** The Escape stop for computer use; absent on shells that cannot register it. */
export interface DesktopComputerBridge {
  /** Resolves once Escape is registered (or released); `stop` is required to arm. */
  setStopArmed(armed: boolean, stop?: { token: string; url: string }): Promise<void>
  /** The server socket closed: the shell delivers the stop itself and keeps Escape until it lands. */
  connectionLost?(): Promise<void>
}

/** What Open or Save did with a delivered file; `error` is a sentence for the user. */
export type DesktopFileResult = { ok: true; canceled?: true } | { ok: false; error: string }

/**
 * Delivered files on the Mac. Open hands a copy to the app macOS picks for its type;
 * Save asks where. Both take the signed `src` of a `DeliveredFile` and its name.
 */
export interface DesktopFilesBridge {
  open(src: string, name: string): Promise<DesktopFileResult>
  save(src: string, name: string): Promise<DesktopFileResult>
}

export interface DesktopHostBridge {
  browser: DesktopBrowserBridge
  computer?: DesktopComputerBridge
  files?: DesktopFilesBridge
  /** The Finder folder dialog on the Mac: the absolute path chosen, or null on cancel. */
  chooseFolder?: () => Promise<string | null>
  /** The key of the Manor server on this Mac, so its own desktop shell needs no sign-in; null when there is none. */
  localAccess?: () => Promise<string | null>
  notify?: DesktopNotifyBridge
  presence?: DesktopPresenceBridge
  /** `process.platform` of the shell. */
  platform?: string
  /** Fires now with the current factor, then on every Cmd+/−. */
  onZoomFactor?: (listener: (zoom: number) => void) => () => void
  /** Native macOS fullscreen, where the traffic lights are gone. */
  onFullscreen?: (listener: (fullscreen: boolean) => void) => () => void
}
