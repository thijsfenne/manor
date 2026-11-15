import { plainCommand } from './plainCommand'
import { isToolStep, type ToolStep, type TurnActivity, type TurnRow } from './state'

/**
 * How a tool call reads in prose. Shared, because the same step is named twice on
 * screen: once inside the turn's own timeline and once on the status bar above the
 * composer, which is the only place still visible after a long turn has scrolled its
 * header away. Two spellings of "Reading state.ts" would be two labels to keep in
 * sync, and one of them would eventually lie.
 */
const readTools = /^(read|view|open)/i
const searchTools = /(search|grep|find)/i
const editTools = /^(edit|write|patch|notebook)/i
const shellTools = /(bash|shell|command|terminal)/i
const browserTools = /(?:^|__)browser_(navigate|snapshot|click|type|press|scroll|screenshot|tabs)$/

type BrowserAction = 'navigate' | 'snapshot' | 'click' | 'type' | 'press' | 'scroll' | 'screenshot' | 'tabs'

export function isReadTool(tool: string) {
  return readTools.test(tool) || tool === 'mcp__skills__read_skill' || /^(WebFetch|web_fetch)$/i.test(tool)
}
export function isSearchTool(tool: string) {
  return searchTools.test(tool)
}
export function isEditTool(tool: string) {
  return editTools.test(tool)
}
export function isShellTool(tool: string) {
  return shellTools.test(tool)
}
export function isBrowserTool(tool: string) {
  return browserTools.test(tool)
}
export function isTaskTool(tool: string) {
  return /^(task|agent|spawn_subagent)$/i.test(tool)
}

export type ActivityKind = 'edit' | 'read' | 'search' | 'shell' | 'reasoning' | 'other'

/** The visual family of one activity, shared so Mac and phone choose the same lead icon. */
export function activityKind(activity: ToolStep): ActivityKind {
  if (isEditTool(activity.tool) || (activity.edits?.length ?? 0) > 0) return 'edit'
  if (isReadTool(activity.tool)) return 'read'
  if (isSearchTool(activity.tool)) return 'search'
  if (isShellTool(activity.tool)) return 'shell'
  return 'other'
}

export interface WorkSummary {
  label: string
  kind: ActivityKind
}

/**
 * One closed line for the activity between two things the agent said.
 *
 * A single call keeps its useful detail. A longer run names each kind of work once,
 * in a stable order, so ten reads become "read files" rather than ten paths pushing
 * the next sentence away. File edits are supplied separately because the turn model
 * keeps their landed diffs beside the tool trace instead of duplicating them inside it.
 */
export function workSummary(activities: readonly TurnActivity[], hasEdits = false): WorkSummary {
  const tools = activities.filter(isToolStep)

  if (!hasEdits && tools.length === 1 && activities.length === 1) {
    const tool = tools[0]!
    return {
      label: tool.status === 'error' ? 'Tool had an issue' : settledLabel(tool),
      kind: activityKind(tool),
    }
  }

  const kinds = new Set(tools.map(activityKind))
  if (hasEdits) kinds.add('edit')
  // A kind whose every call failed reads as an attempt, so a folded line never claims
  // work that did not happen. One success among failures still counts as the work.
  const failed = (kind: ActivityKind) => {
    const ofKind = tools.filter((tool) => activityKind(tool) === kind)
    return ofKind.length > 0 && ofKind.every((tool) => tool.status === 'error') && !(kind === 'edit' && hasEdits)
  }
  const labels: string[] = []
  if (kinds.has('edit')) labels.push(failed('edit') ? 'tried to edit files' : 'edited files')
  if (kinds.has('read')) labels.push(failed('read') ? 'tried to read files' : 'read files')
  if (kinds.has('search')) labels.push(failed('search') ? 'tried to search' : 'searched')
  if (kinds.has('shell')) {
    const shells = tools.filter((tool) => activityKind(tool) === 'shell')
    const object = shells.length === 1 ? 'a command' : 'commands'
    const verb = failed('shell') ? 'tried to run' : shells.some(isBackgroundRunning) ? 'running' : 'ran'
    labels.push(`${verb} ${object}`)
  }
  if (kinds.has('other')) labels.push(failed('other') ? 'tried to use tools' : 'used tools')

  const kind = (['edit', 'read', 'search', 'shell', 'other'] as const).find((candidate) => kinds.has(candidate))
  if (labels.length > 0 && kind !== undefined) {
    const joined = labels.join(', ')
    const label = `${joined[0]!.toUpperCase()}${joined.slice(1)}`
    return { label, kind }
  }
  return {
    label: activities.some((activity) => activity.kind === 'reasoning') ? 'Thought it through' : 'Worked',
    kind: activities.some((activity) => activity.kind === 'reasoning') ? 'reasoning' : 'other',
  }
}

function browserAction(tool: string): BrowserAction | undefined {
  return browserTools.exec(tool)?.[1] as BrowserAction | undefined
}

/**
 * A step that writes into the user's daily log, whatever tool it used. Personas are told
 * to write those with a file-write tool, which shows its content anyway; this catches
 * the case where an older call appends through shell redirection instead. Mentioning
 * the daily path in a mixed read/command script is not evidence of a write.
 *
 * Matched on the daily-log path rather than the repo, because that path is the thing
 * with the rule attached to it and it is the same string in every checkout.
 */
const memoryPath = /memory\/daily\//
export function isMemoryWrite(step: ToolStep): boolean {
  if (isReadTool(step.tool) || isSearchTool(step.tool)) return false
  return (
    />>?\s*['"]?[^\s'"]*memory\/daily\//.test(step.command ?? '') ||
    (step.targets ?? []).some((target) => memoryPath.test(target)) ||
    (step.edits ?? []).some((edit) => memoryPath.test(edit.path))
  )
}

// A safety cap, not a layout choice: rows truncate at their own width.
const MAX_DETAIL = 300

/** One line, clipped at the end. Never in the middle: a summary that stops mid-word
 *  still reads left to right, one that lost its head does not. */
function clamp(detail: string): string {
  const line = detail.replace(/\s+/g, ' ').trim()
  return line.length > MAX_DETAIL ? `${line.slice(0, MAX_DETAIL - 1)}…` : line
}

/** Only ever applied to something the driver told us is a path. Splitting on slashes
 *  is safe there and nowhere else — a shell command is full of them, and shortening
 *  `… && grep -rn x apps/web/src --include=*.tsx` to its last segment produced the
 *  nonsense labels ("Ran src --include=*.tsx") this replaces. */
export const shortTarget = (path: string): string => pathTail(path)

/** Where Claude Code parks a long tool output or a background task's log: a random
 *  name such as `bfbh0os7c.txt` that tells the user nothing. */
const SCRATCH_PATH = /[\\/]\.claude[\\/]projects[\\/].*[\\/]tool-results[\\/]|^(?:[\\/]private)?[\\/]tmp[\\/]claude-\d+[\\/]/

const pathTail = (path: string): string => {
  if (SCRATCH_PATH.test(path)) return 'a scratch file'
  const parts = path.split(/[\\/]/).filter(Boolean)
  const file = parts.at(-1) ?? path
  // Every imported skill uses the same filename. Its parent is the actual identity;
  // basename-only labels turn all of them into the useless "Read SKILL.md".
  if (file === 'SKILL.md' && parts.length > 1) return clamp(`${parts.at(-2)}/${file}`)
  return clamp(file)
}

export function activityDetail(activity: ToolStep): string | undefined {
  // An edit names its own files, so it never falls back to the raw provider detail.
  if ((activity.edits?.length ?? 0) > 1) return `${activity.edits!.length} files`
  if (activity.edits?.length === 1) return pathTail(activity.edits[0]!.path)
  if (activity.subject !== undefined) return clamp(activity.subject)
  if ((activity.targets?.length ?? 0) > 1) return `${activity.targets!.length} files`
  if (activity.targets?.length === 1) return pathTail(activity.targets[0]!)
  // Whatever is left is a command, a pattern or a query: prose, not a path.
  return activity.detail === undefined ? undefined : clamp(activity.detail)
}

/**
 * The part of a raw command that says what ran. A `cd` into the repo, an environment
 * assignment or a `sleep` before the real command is the same prefix on hundreds of
 * rows and pushed the actual program past the clip; a heredoc body is a script, not a
 * label. Applied to the stored `detail`, so older transcripts read the same way.
 */
export function cleanCommand(detail: string): string {
  let text = detail.replace(/\s+/g, ' ').trim()
  for (;;) {
    const next = text
      .replace(/^cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*/, '')
      .replace(/^(?:export\s+)?[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|[^\s;&]*)\s*(?:&&\s*|;\s*)?/, '')
      .replace(/^sleep\s+\d+(?:\.\d+)?\s*(?:&&|;)\s*/, '')
    if (next === text || next.length === 0) break
    text = next
  }
  const heredoc = /^(\S+)(?:\s+-)?\s*<<-?\s*['"]?\w+/.exec(text)
  if (heredoc !== null) return `${heredoc[1]!.split('/').at(-1)} script`
  return text
}

/**
 * Manor's own tools and a few provider housekeeping calls, by what they mean. Raw
 * names such as "Used MCP manor.goal_reached" told nobody what happened.
 */
const NAMED_TOOLS: Readonly<Record<string, readonly [string, string]>> = {
  mcp__manor__goal_reached: ['Reporting done', 'Reported done'],
  mcp__manor__set_session_status: ['Updating the status', 'Updated the status'],
  mcp__manor__write_instructions: ['Writing its instructions', 'Wrote its instructions'],
  mcp__manor__update_project_file: ['Updating project notes', 'Updated project notes'],
  mcp__work__start_work: ['Proposing a Session', 'Proposed a Session'],
  mcp__manor__task_result: ['Checking on a helper', 'Checked on a helper'],
  mcp__manor__task_cancel: ['Cancelling a helper', 'Cancelled a helper'],
  mcp__manor__subagent_capabilities: ['Checking helper models', 'Checked helper models'],
  mcp__manor__send_to_session: ['Messaging a Session', 'Messaged a Session'],
  mcp__manor__report_to_project: ['Reporting to the project', 'Reported to the project'],
  mcp__manor__answer_session_question: ['Answering a Session', 'Answered a Session'],
  mcp__manor__review_passed: ['Passing the review', 'Passed the review'],
  mcp__manor__ask_user: ['Asking you', 'Asked you'],
  mcp__manor__prepare_outbound_draft: ['Drafting a message', 'Drafted a message'],
  mcp__manor__message_agent: ['Messaging an agent', 'Messaged an agent'],
  mcp__routines__routine_list: ['Checking routines', 'Checked routines'],
  mcp__routines__routine_runs: ['Checking routine runs', 'Checked routine runs'],
  mcp__routines__routine_cancel: ['Cancelling a routine', 'Cancelled a routine'],
  mcp__artifacts__artifact_search: ['Searching mymind', 'Searched mymind'],
  mcp__artifacts__artifact_view: ['Viewing mymind items', 'Viewed mymind items'],
  mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL: ['Using Composio', 'Used Composio'],
  mcp__composio__COMPOSIO_SEARCH_TOOLS: ['Finding Composio tools', 'Found Composio tools'],
  ToolSearch: ['Loading tools', 'Loaded tools'],
  GetMcpTools: ['Loading tools', 'Loaded tools'],
}

/** A named tool's label, with its one useful object where the call carries one. */
function namedLabel(activity: ToolStep, running: boolean): string | undefined {
  if (activity.tool === 'mcp__manor__deliver_file') {
    const file = activity.detail === undefined ? '' : ` ${pathTail(activity.detail)}`
    return `${running ? 'Delivering' : 'Delivered'}${file || ' a file'}`
  }
  if (/^list_dir$/i.test(activity.tool)) {
    const folder = activity.detail === undefined ? '' : ` ${pathTail(activity.detail)}`
    return `${running ? 'Listing' : 'Listed'}${folder || ' a folder'}`
  }
  if (/^monitor$/i.test(activity.tool) && activity.detail !== undefined) {
    return `${running ? 'Watching' : 'Watched'} ${clamp(activity.detail)}`
  }
  const named = NAMED_TOOLS[activity.tool]
  return named === undefined ? undefined : named[running ? 0 : 1]
}

/** A code search's pattern and where it looked, from the driver's `“pattern” in place`. */
export function searchQuery(activity: ToolStep): { pattern: string; place?: string } | undefined {
  const quoted = activity.subject === undefined ? undefined : /^“([\s\S]+)”(?: in ([\s\S]+))?$/.exec(activity.subject.trim())
  if (quoted === undefined || quoted === null) return undefined
  return { pattern: quoted[1]!, ...(quoted[2] === undefined ? {} : { place: quoted[2] }) }
}

/** The words a pattern looks for, when it is only words joined by `|`. */
function searchTerms(pattern: string): string[] | undefined {
  // `\|` is a literal bar in one regex flavour and an "or" in another, so it stays a pattern.
  if (pattern.includes('\\|')) return undefined
  const terms = pattern.split('|').map((term) => term.replace(/\\b/g, '').trim())
  return terms.every((term) => /^[\w\s'-]+$/.test(term)) ? terms : undefined
}

/**
 * A search at a glance: one word is named, several are counted, a regular expression
 * is "a pattern". The exact pattern stands in the opened row.
 */
function searchObject(activity: ToolStep): string | undefined {
  const query = searchQuery(activity)
  if (query === undefined) return undefined
  const terms = searchTerms(query.pattern)
  const what = terms === undefined ? 'a pattern' : terms.length === 1 ? `“${terms[0]}”` : `${terms.length} terms`
  return ` for ${what}${query.place === undefined ? '' : ` in ${clamp(query.place)}`}`
}

const MAX_SAID = 300

/** A shell call the provider described in its own words (Claude's Bash, Cursor's shell). */
function describedShell(activity: ToolStep): string | undefined {
  if (!isShellTool(activity.tool) || activity.subject === undefined) return undefined
  const line = activity.subject.replace(/\s+/g, ' ').trim()
  if (line.length === 0) return undefined
  const said = line.length > MAX_SAID ? `${line.slice(0, MAX_SAID - 1)}…` : line
  return `${said[0]!.toUpperCase()}${said.slice(1)}`
}

/** A shell call with only its command: a family name, or the cleaned command itself. */
function commandObject(activity: ToolStep): string | undefined {
  return activity.detail === undefined ? activityDetail(activity) : clamp(cleanCommand(activity.detail))
}

function browserDestination(detail: string | undefined): string {
  if (detail === undefined) return 'the page'
  try {
    const url = new URL(detail)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'the page'
    const path = url.pathname === '/' ? '' : url.pathname
    return `${url.host.replace(/^www\./, '')}${path}`
  } catch {
    return 'the page'
  }
}

function browserLabel(action: BrowserAction, activity: ToolStep, running: boolean): string {
  switch (action) {
    case 'navigate': {
      const destination = browserDestination(activity.detail)
      return running ? `Opening ${destination}…` : `Opened ${destination}`
    }
    case 'snapshot': return running ? 'Reading the page…' : 'Read the page'
    case 'click': return running ? 'Clicking on the page…' : 'Clicked on the page'
    case 'type': return running ? 'Entering text…' : 'Entered text'
    case 'press': return running ? 'Using the keyboard…' : 'Used the keyboard'
    case 'scroll': return running ? 'Scrolling the page…' : 'Scrolled the page'
    case 'screenshot': return running ? 'Taking a screenshot…' : 'Took a screenshot'
    case 'tabs': return running ? 'Checking browser tabs…' : 'Checked browser tabs'
  }
}

export function currentLabel(activity: ToolStep): string {
  const browser = browserAction(activity.tool)
  if (browser !== undefined) return browserLabel(browser, activity, true)
  const detail = activityDetail(activity)
  const suffix = detail === undefined ? '' : ` ${detail}`
  // Named for what it means, not for the tool it used. "Ran cat" and "Edited
  // 2026-08-08-manor.md" both describe a write into the user's memory without saying so.
  if (isMemoryWrite(activity)) return 'Saving to memory…'
  if (activity.tool === SCHEDULE_TOOL) return detail === undefined ? 'Saving task…' : `Saving task${suffix}`
  const named = namedLabel(activity, true)
  if (named !== undefined) return named
  if (isReadTool(activity.tool)) return `Reading${suffix}`
  if (isSearchTool(activity.tool)) return `Searching${searchObject(activity) ?? suffix}`
  if (isEditTool(activity.tool)) return `Editing${suffix}`
  if (isShellTool(activity.tool)) {
    const said = describedShell(activity)
    if (said !== undefined) return said
    const plain = activity.detail === undefined ? undefined : plainCommand(activity.detail, true)
    if (plain !== undefined) return plain
    const object = commandObject(activity)
    return object === undefined ? 'Running a command' : `Running ${object}`
  }
  if (isTaskTool(activity.tool)) return detail ?? `Using ${displayTool(activity.tool)}`
  return `Using ${displayTool(activity.tool)}${suffix}`
}

/** Background work has not settled while it runs, even though its call returned. */
const isBackgroundRunning = (activity: ToolStep): boolean => activity.background === true && activity.status === 'running'

/**
 * A finished step in past tense. A background step whose work still runs keeps its
 * running words, so a folded build reads "Running pnpm build" until it reports back.
 */
export function settledLabel(activity: ToolStep): string {
  if (isBackgroundRunning(activity)) return currentLabel(activity)
  const browser = browserAction(activity.tool)
  if (browser !== undefined) return browserLabel(browser, activity, false)
  const described = activityDetail(activity)
  const detail = described === undefined ? '' : ` ${described}`
  if (isMemoryWrite(activity)) return 'Saved to memory'
  if (activity.tool === SCHEDULE_TOOL) return `Saved task${detail}`
  const named = namedLabel(activity, false)
  if (named !== undefined) return named
  if (isReadTool(activity.tool)) return `Read${detail}`
  if (isSearchTool(activity.tool)) return `Searched${searchObject(activity) ?? detail}`
  if (isEditTool(activity.tool)) return `Edited${detail}`
  if (isShellTool(activity.tool)) {
    const stopped = activity.background === true && activity.status === 'stopped'
    const said = describedShell(activity)
    if (said !== undefined) return stopped ? `${said}, stopped` : said
    const plain = stopped || activity.detail === undefined ? undefined : plainCommand(activity.detail, false)
    if (plain !== undefined) return plain
    const object = commandObject(activity)
    return `${stopped ? 'Stopped' : 'Ran'}${object === undefined ? ' a command' : ` ${object}`}`
  }
  if (isTaskTool(activity.tool)) return described ?? `Used ${displayTool(activity.tool)}`
  return `Used ${displayTool(activity.tool)}${detail}`
}

/**
 * A DM task's only visible trace is this row, so it reads as what happened, not as the
 * MCP call. It says saved, never scheduled: the call's input cannot tell whether the
 * task ends up on (a save without `enabled` keeps a paused task paused).
 */
const SCHEDULE_TOOL = 'mcp__routines__routine_save'

const displayTool = (tool: string): string => tool.startsWith('mcp__')
  ? `MCP ${tool.slice(5).replaceAll('__', '.')}`
  : tool

/**
 * The step a running turn is on right now, or nothing when it is only thinking.
 * Reasoning is part of the trace but never a step: a turn that is mid-thought has no
 * current activity, which is exactly what makes the caller say "Thinking…".
 */
export const currentActivity = (turn: TurnRow): ToolStep | undefined =>
  [...turn.activities].filter(isToolStep).reverse()
    .find((activity) => activity.status === 'running' && activity.background !== true)

/**
 * How long a finished turn took, or nothing when the transcript cannot say. Older
 * events carry no usable span, and a turn that finished inside a second has no wait
 * worth naming — both fall back to whatever the caller says instead.
 */
export function workedLabel(startedAt: number | undefined, endedAt: number | undefined): string | undefined {
  if (startedAt === undefined || endedAt === undefined) return undefined
  if (endedAt - startedAt < 1000) return undefined
  return elapsedLabel(startedAt, endedAt)
}

/**
 * `startedAt` is the server's clock, so this survives a reconnect instead of
 * restarting at zero. Skew between the two machines is accepted (Manor talks to one
 * server over one socket); the clamp is what keeps a clock that runs ahead from
 * rendering a negative age.
 */
export function elapsedLabel(startedAt: number | undefined, now: number): string {
  if (startedAt === undefined) return '0s'
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m ${remainingSeconds}s`
}

/**
 * The compact line a wake row shows: what ended, by its own title. A wake is a turn
 * The user did not start, so the line says why the persona speaks again.
 */
export function wakeLine(items: readonly { title: string; state: 'done' | 'failed' | 'stopped' }[]): string {
  if (items.length === 0) return 'Background work ended'
  return items.map((item) => `\u201c${item.title}\u201d ${item.state === 'done' ? 'finished' : item.state}`).join(', ')
}
