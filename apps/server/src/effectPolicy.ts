import type { BrowserToolName, McpServerConfig } from '@manor/contracts'
import { COMPUTER_MCP_NAME, COMPUTER_READ_TOOLS, drivesDesktop } from './computerPolicy.js'
import { BUILT_IN_BROWSER_MCP_NAME } from './mcp/browserAttachment.js'
import {
  CALENDAR_CREATE_TOOL,
  ICLOUD_CALENDAR_MCP_NAME,
  calendarCreateQuestion,
  parseCalendarCreate,
} from './mcp/calendarCreate.js'
import {
  APPLE_REMINDERS_MCP_NAME,
  REMINDER_COMPLETE_TOOL,
  REMINDER_CREATE_TOOL,
  REMINDER_DELETE_TOOL,
  parseReminderTarget,
  reminderCompleteQuestion,
  reminderDeleteQuestion,
} from './mcp/remindersWrite.js'

export type ConnectorEffect = 'read' | 'trusted_write' | 'confirm_write' | 'agent_message'

export const BROWSER_FILL_LOGIN_TOOL = 'browser_fill_login' satisfies BrowserToolName

const COMPOSIO_EXECUTE = 'COMPOSIO_MULTI_EXECUTE_TOOL'
export const MAX_COMPOSIO_BATCH_ACTIONS = 50
const READ_ONLY_COMPOSIO_TOOLS = new Set(['COMPOSIO_SEARCH_TOOLS', 'COMPOSIO_GET_TOOL_SCHEMAS'])
const READ_ONLY_COMPOSIO_ACTIONS = new Set([
  'GMAIL_FETCH_EMAILS',
  'GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID',
  'GMAIL_FETCH_MESSAGE_BY_THREAD_ID',
  'GMAIL_GET_ATTACHMENT',
  'GMAIL_GET_AUTO_FORWARDING',
  'GMAIL_GET_DRAFT',
  'GMAIL_GET_FILTER',
  'GMAIL_GET_PROFILE',
  'GMAIL_LIST_DRAFTS',
  'GMAIL_LIST_FILTERS',
  'GMAIL_LIST_FORWARDING_ADDRESSES',
  'GMAIL_LIST_HISTORY',
  'GMAIL_LIST_LABELS',
  'GMAIL_LIST_SEND_AS',
  'GMAIL_LIST_SMIME_INFO',
  'GMAIL_LIST_THREADS',
  'GMAIL_SETTINGS_GET_IMAP',
  'GMAIL_SETTINGS_GET_POP',
  'GMAIL_SETTINGS_SEND_AS_GET',
  // Slugs checked against Composio's schemas; unattended routines read calendars.
  'GOOGLECALENDAR_EVENTS_GET',
  'GOOGLECALENDAR_EVENTS_INSTANCES',
  'GOOGLECALENDAR_EVENTS_LIST',
  'GOOGLECALENDAR_FIND_EVENT',
  'GOOGLECALENDAR_FIND_FREE_SLOTS',
  'GOOGLECALENDAR_FREE_BUSY_QUERY',
  'GOOGLECALENDAR_GET_CALENDAR',
  'GOOGLECALENDAR_LIST_CALENDARS',
])
const TRUSTED_COMPOSIO_PREFIXES = ['LINEAR_']
const REVIEWED_READ_TOOLS = new Map<string, ReadonlySet<string>>([
  ['mail', new Set(['mail_search', 'mail_read'])],
  ['figma', new Set(['get_metadata', 'get_design_context', 'get_screenshot', 'get_variable_defs'])],
  ['calendar', new Set(['list_calendars', 'list_events'])],
  [ICLOUD_CALENDAR_MCP_NAME, new Set(['list_calendars', 'list_events', 'find_free_time'])],
  [APPLE_REMINDERS_MCP_NAME, new Set(['list_reminder_lists', 'list_reminders'])],
  ['gmail', new Set([
    'get_draft', 'list_drafts',
    'get_label', 'list_labels',
    'get_message', 'list_messages', 'get_attachment',
    'get_thread', 'list_threads',
    'get_auto_forwarding', 'get_imap', 'get_language', 'get_pop', 'get_vacation',
    'get_delegate', 'list_delegates',
    'get_filter', 'list_filters',
    'get_forwarding_address', 'list_forwarding_addresses',
    'get_send_as', 'list_send_as',
    'get_smime_info', 'list_smime_info',
    'get_profile',
  ])],
  ['composio', READ_ONLY_COMPOSIO_TOOLS],
  ['executor', new Set(['skills', 'list-artifacts'])],
  [COMPUTER_MCP_NAME, new Set(COMPUTER_READ_TOOLS)],
])

/**
 * Writes the user chose to let run without a card, whatever the row says. Like the read
 * exemptions this is Manor code, so a connector cannot put itself on it.
 */
const REVIEWED_TRUSTED_WRITES = new Map<string, ReadonlySet<string>>([
  [APPLE_REMINDERS_MCP_NAME, new Set([REMINDER_CREATE_TOOL])],
])

/** The answers a human-only card offers instead of Allow once and Deny. */
export interface HumanOnlyChoices {
  allow: { label: string; description: string }
  deny: { label: string; description: string }
  /** What it approves happens on the Mac, so only the Mac can answer it. */
  desktopOnly?: true
}

interface ApprovalCard {
  question: (arguments_: unknown) => string
  choices?: HumanOnlyChoices
  /** Only the user may approve it, one call at a time: not full access, not the Auto reviewer. */
  humanOnly?: true
}

/**
 * Writes whose card Manor renders from the call arguments, so the user sees what will
 * happen rather than a tool name. Every one stays a guarded write whatever its row says,
 * so an unattended turn never runs it; a human-only one also skips full access and Auto.
 */
const APPROVAL_CARDS = new Map<string, ReadonlyMap<string, ApprovalCard>>([
  [BUILT_IN_BROWSER_MCP_NAME, new Map([[BROWSER_FILL_LOGIN_TOOL, {
    question: (arguments_: unknown) => fillLoginQuestion(arguments_),
    choices: {
      allow: { label: 'Fill', description: 'Manor fills the saved login into this page. The agent never sees the password.' },
      deny: { label: "Don't fill", description: 'Nothing is filled. The agent hears that you declined.' },
      desktopOnly: true,
    },
    humanOnly: true,
  }]])],
  // Attended turns follow the effect mode like any guarded write (the maintainer, 2026-11-17).
  [ICLOUD_CALENDAR_MCP_NAME, new Map([
    [CALENDAR_CREATE_TOOL, { question: (arguments_: unknown) => calendarCreateQuestion(parseCalendarCreate(arguments_)) }],
  ])],
  [APPLE_REMINDERS_MCP_NAME, new Map<string, ApprovalCard>([
    [REMINDER_COMPLETE_TOOL, { question: (arguments_: unknown) =>
      reminderCompleteQuestion(parseReminderTarget(arguments_, REMINDER_COMPLETE_TOOL)), humanOnly: true }],
    [REMINDER_DELETE_TOOL, { question: (arguments_: unknown) =>
      reminderDeleteQuestion(parseReminderTarget(arguments_, REMINDER_DELETE_TOOL)), humanOnly: true }],
  ])],
])

export function humanOnlyChoices(connector: string, tool: string): HumanOnlyChoices | undefined {
  return APPROVAL_CARDS.get(connector)?.get(tool)?.choices
}

/** "Sign in to github.com as the user?", from the origin and username the desktop looked up. */
function fillLoginQuestion(arguments_: unknown): string {
  if (!isRecord(arguments_) || typeof arguments_.origin !== 'string' || typeof arguments_.username !== 'string') {
    throw new Error('the saved login could not be shown for approval.')
  }
  const site = new URL(arguments_.origin).host
  return arguments_.username === ''
    ? `Sign in to ${site} with its saved password?`
    : `Sign in to ${site} as ${arguments_.username}?`
}

export function humanOnlyWrite(connector: string, tool: string): boolean {
  return APPROVAL_CARDS.get(connector)?.get(tool)?.humanOnly === true
}

/**
 * The card question for a write Manor previews, or undefined for the generic card. Throws
 * when the arguments cannot be shown, and the broker blocks the call rather than ask
 * about something unseen.
 */
export function approvalQuestion(connector: string, tool: string, arguments_: unknown): string | undefined {
  return APPROVAL_CARDS.get(connector)?.get(tool)?.question(arguments_)
}

/** Read exemptions are Manor code, never metadata asserted by an MCP server. */
export function reviewedConnectorRead(connector: string, tool: string): boolean {
  return REVIEWED_READ_TOOLS.get(connector)?.has(tool) ?? false
}

export function connectorEffect(
  server: McpServerConfig,
  tool: string,
  arguments_: unknown = undefined,
): ConnectorEffect {
  const known = server.tools.includes(tool)
  if (known && reviewedConnectorRead(server.name, tool)) return 'read'
  // Before the trust check: a row edited to trusted must not skip the desktop lease.
  if (drivesDesktop(server.name)) return 'confirm_write'
  if (APPROVAL_CARDS.get(server.name)?.has(tool)) return 'confirm_write'
  // An unprobed name gets no exemption and no row trust either.
  if (REVIEWED_TRUSTED_WRITES.get(server.name)?.has(tool)) return known ? 'trusted_write' : 'confirm_write'

  if (server.name === 'composio' && known) {
    if (READ_ONLY_COMPOSIO_TOOLS.has(tool)) return 'read'
    if (tool === COMPOSIO_EXECUTE) return composioBatchEffect(arguments_)
    // Some Composio sessions may preload app tools instead of exposing only the
    // router. Keep the same reviewed connector trust rule for that shape.
    return composioActionEffect(tool)
  }
  if (server.effectPolicy === 'trusted') return 'trusted_write'

  // Server annotations and tools absent from the last probe have no authority here.
  return 'confirm_write'
}

/**
 * Composio routes several logical connectors through one meta-tool. Trust therefore
 * follows every nested action slug, never the broad router tool and never a model-set
 * confirmation field. A mixed or unfamiliar batch stays guarded as one atomic call.
 */
function composioBatchEffect(value: unknown): ConnectorEffect {
  const batch = composioActionBatch(value)
  if (batch === undefined) return 'confirm_write'
  let strongest: ConnectorEffect = 'read'
  for (const action of batch.actions) {
    const effect = composioActionEffect(action)
    if (effect === 'confirm_write') return effect
    if (effect === 'trusted_write') strongest = effect
  }
  return strongest
}

function composioActionEffect(action: string): ConnectorEffect {
  const normalised = action.toUpperCase()
  if (READ_ONLY_COMPOSIO_ACTIONS.has(normalised)) return 'read'
  if (TRUSTED_COMPOSIO_PREFIXES.some((prefix) => normalised.startsWith(prefix))) return 'trusted_write'
  return 'confirm_write'
}

export interface ComposioActionBatch {
  /** Sanitised action identities are safe to name in an approval; arguments are not. */
  actions: string[]
  /** Derived from the actual array, never a count supplied by the model. */
  actionCount: number
}

/** One strict parser feeds both trust classification and turn-budget accounting. */
export function composioActionBatch(value: unknown): ComposioActionBatch | undefined {
  if (
    !isRecord(value) ||
    !Array.isArray(value.tools) ||
    value.tools.length === 0 ||
    value.tools.length > MAX_COMPOSIO_BATCH_ACTIONS
  ) return undefined
  const slugs: string[] = []
  for (const item of value.tools) {
    if (!isRecord(item) || typeof item.tool_slug !== 'string' || item.tool_slug.length > 200) return undefined
    slugs.push(item.tool_slug)
  }
  return { actions: slugs, actionCount: value.tools.length }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Only the observed empty, non-persistent Computer Use app-access form. */
export function executorAppAccess(value: unknown): boolean {
  if (!isRecord(value) || value.kind !== 'form' ||
    typeof value.address !== 'string' ||
    !/^tools\.codex_computer_use\.(org|user)\.[\w-]+\.\w+$/.test(value.address) ||
    !isRecord(value.args) || typeof value.args.app !== 'string' || value.args.app.length === 0 ||
    !isRecord(value.meta) || value.meta.connector_id !== 'computer-use' ||
    Object.keys(value.meta).some((key) => !['connector_id', 'connector_name'].includes(key)) ||
    typeof value.message !== 'string' || !/^Allow Computer Use to use ".+"\?$/.test(value.message) ||
    !isRecord(value.requestedSchema)) return false
  const schema = value.requestedSchema
  return schema.type === 'object' && isRecord(schema.properties) && Object.keys(schema.properties).length === 0 &&
    Object.keys(schema).every((key) => key === 'type' || key === 'properties')
}

const READ_ONLY_BROWSER_TOOLS = new Set<BrowserToolName>([
  'browser_navigate',
  'browser_snapshot',
  'browser_scroll',
  'browser_screenshot',
  'browser_tabs',
])

/** Click, type and keypress can submit untrusted page content; unknown stays write. */
export function browserEffect(tool: BrowserToolName): ConnectorEffect {
  return READ_ONLY_BROWSER_TOOLS.has(tool) ? 'read' : 'confirm_write'
}
