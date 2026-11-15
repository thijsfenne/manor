import { SUBAGENT_TEXT_MAX, type RuntimeEvent, type SubagentLaunch } from '@manor/contracts'

type ToolActivity = Omit<Extract<RuntimeEvent, { type: 'tool_use' }>, 'type' | 'toolCallId'>

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined


/** Keep credentials, query strings and fragments out of page labels. */
function pageUrl(value: unknown): string | undefined {
  try {
    const url = new URL(text(value) ?? '')
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return `${url.origin}${url.pathname}`
  } catch {
    return undefined
  }
}

export function searchSubject(pattern: string, targets: readonly string[] = []): string {
  return `“${pattern}”${targets.length === 0 ? '' : ` in ${targets.join(', ')}`}`
}

/** The brief's own opening, for a provider that gives no separate description. */
function firstSentence(prompt: string): string | undefined {
  const line = prompt.split('\n').map((value) => value.replace(/^[\s#>*-]+/, '').trim()).find((value) => value.length > 0)
  if (line === undefined) return undefined
  const sentence = line.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? line
  return sentence
}

/**
 * What a subagent launch reported, from the provider's own launch fields. Model
 * and effort are only what this call asked for; `inherit` names the parent's.
 */
export function subagentLaunch(fields: {
  description?: unknown
  prompt?: unknown
  fallbackTitle?: string
  model?: unknown
  effort?: unknown
}): SubagentLaunch | undefined {
  // Verbatim and whole: the detail promises the exact brief.
  const prompt = text(fields.prompt)
  const description = text(fields.description)
  const title = (description === undefined ? undefined : description)
    ?? (prompt === undefined ? undefined : firstSentence(prompt))
    ?? fields.fallbackTitle
  const model = text(fields.model)?.trim()
  const effort = text(fields.effort)?.trim()
  const launch: SubagentLaunch = {
    ...(title === undefined ? {} : { title }),
    ...(prompt === undefined ? {} : { prompt }),
    ...(model === undefined || model === 'inherit' ? {} : { model: model.slice(0, 100) }),
    ...(effort === undefined ? {} : { effort: effort.slice(0, 40) }),
  }
  return Object.keys(launch).length === 0 ? undefined : launch
}

/** A subagent's final answer from a tool result, without the runtime's own trailers. */
export function subagentOutput(content: unknown): string | undefined {
  const parts = typeof content === 'string'
    ? [content]
    : Array.isArray(content)
      ? content.map((block) => record(block)['type'] === 'text' ? text(record(block)['text']) : undefined)
      : []
  const answer = parts
    .filter((part): part is string => part !== undefined && !/^\s*agentId:/.test(part))
    .join('\n\n')
    .trim()
  // A background launch answers with a receipt, not with what the helper found.
  if (answer.length === 0 || /^Async agent launched/i.test(answer)) return undefined
  return answer.slice(0, SUBAGENT_TEXT_MAX)
}

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g

const BARE_EXIT = /^(?:exit code|exited with code|command failed with exit code) -?\d+\.?$/i
const FAILURE_WORDS = /error|fail|not found|no such|denied|cannot|can't|invalid|exception|refused|missing|unknown|timed? ?out/i

/**
 * A failed call's output as text, from a string, content blocks, or an object with
 * `text`/`message`/`error`. Kept exactly as sent: `redactToolActivity` redacts it first
 * and only then picks the line that says why (`errorLine`) and clips it, because a cut,
 * trim or whitespace rewrite through a secret leaves part of it unmatched.
 */
export function errorText(content: unknown): string | undefined {
  const raw = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((block) => record(block)['type'] === 'text' ? text(record(block)['text']) : undefined)
        .filter((part) => part !== undefined).join('\n')
      : (() => {
          const fields = record(content)
          return text(fields['text']) ?? text(fields['message']) ?? text(fields['error'])
        })()
  return raw === undefined || raw.replace(ANSI, '').trim().length === 0 ? undefined : raw
}

/**
 * The line that says why a call failed: the first line that names a failure, else the
 * first that is more than a bare exit code (Claude opens a failed Bash with "Exit code
 * 1"), else the first line.
 */
export function errorLine(output: string): string {
  const lines = output.replace(ANSI, '').split(/\r?\n/).map((value) => value.replace(/\s+/g, ' ').trim()).filter((value) => value.length > 0)
  // An echoed command banner ("> vitest run test/errors.test.ts") is not the reason.
  const said = lines.filter((value) => !BARE_EXIT.test(value) && !/^[>$] /.test(value))
  return said.find((value) => FAILURE_WORDS.test(value)) ?? said[0] ?? lines[0] ?? ''
}

/** Head and tail both stay, so a check that follows a long heredoc edit is still on record. */
const clipCommand = (command: string): string =>
  command.length > 2_000 ? `${command.slice(0, 1_000)}\n...\n${command.slice(-995)}` : command

/** Clips only after redaction: a cut through a secret would leave its prefix unmatched. */
const clipRedacted = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`

/**
 * Provider syntax stops here. Only selected subjects enter the transcript, as written:
 * `redactToolActivity` collapses whitespace and clips them after redaction, so no
 * rewrite splits a secret.
 */
export function describeTool(tool: string, input: unknown): ToolActivity {
  const args = record(input)
  // Grok's catalogue gateway names the actual MCP tool inside its arguments.
  if (tool === 'use_tool') {
    const name = text(args['tool_name'])
    // It drops the `mcp__` prefix the other drivers carry; restore it so every label and
    // check sees one name per tool.
    if (name !== undefined && name.includes('__')) return describeTool(name.startsWith('mcp__') ? name : `mcp__${name}`, args['tool_input'])
  }
  const canonical = tool.replace(/^mcp__/, '').replaceAll('__', '.')
  if (canonical === 'skills.read_skill') {
    const skill = text(args['skillId'])
    const file = text(args['path'])
    return {
      tool: 'mcp__skills__read_skill',
      subject: `skill${skill === undefined ? '' : ` ${skill}`}${file === undefined ? '' : ` / ${file}`}`,
    }
  }
  // The saved task stands in the fold rather than as a note in the DM, so its row names
  // the task and the moment it was given (wall-clock time in the task's own zone). It
  // says nothing about on or off: a save that omits `enabled` keeps whatever the task was.
  if (canonical === 'routines.routine_save') {
    const name = text(args['name'])
    const when = text(args['runAt']) ?? text(args['cron'])
    const subject = [name === undefined ? undefined : `“${name}”`, when?.replace('T', ' ')].filter(Boolean).join(', ')
    return { tool: 'mcp__routines__routine_save', ...(subject === '' ? {} : { subject: subject }) }
  }
  if (/^browser\.browser_(navigate|snapshot|click|type|press|scroll|screenshot|tabs)$/.test(canonical)) {
    const url = canonical.endsWith('_navigate') ? pageUrl(args['url']) : undefined
    return { tool: `mcp__${canonical.replace('.', '__')}`, ...(url === undefined ? {} : { detail: url }) }
  }

  const target = [args['file_path'], args['target_file'], args['path'], args['filePath'], args['targetFile'], args['relativePath'], args['target_directory'], args['notebook_path']]
    .map(text).find((value) => value !== undefined)
  const targets = target === undefined ? undefined : [target]
  if (/^(WebSearch|web_search)$/i.test(tool)) {
    const action = record(args['action'])
    if (action['type'] === 'openPage') return describeTool('WebFetch', action)
    if (action['type'] === 'findInPage') {
      const pattern = text(action['pattern'])
      const url = pageUrl(action['url'])
      return { tool: 'Search', ...(pattern === undefined ? {} : { subject: searchSubject(pattern, url === undefined ? [] : [url]) }) }
    }
    const queries = Array.isArray(action['queries']) ? action['queries'].map(text).filter((value) => value !== undefined) : []
    const query = (queries.length > 0 ? queries.join('; ') : undefined) ?? text(action['query']) ?? text(args['query']) ?? text(args['search_term'])
    return { tool: 'WebSearch', ...(query === undefined ? {} : { subject: `web for “${query}”` }) }
  }
  if (/^(WebFetch|web_fetch)$/i.test(tool)) {
    const url = pageUrl(args['url'])
    return { tool: 'WebFetch', ...(url === undefined ? {} : { subject: url.replace(/^https?:\/\//, '') }) }
  }
  if (/^(Search|Grep|Glob|grep_search|file_search|search_files|search_tool)$/i.test(tool)) {
    const query = text(args['pattern']) ?? text(args['query']) ?? text(args['glob'])
    return {
      tool,
      ...(targets === undefined ? {} : { targets, detail: target }),
      ...(query === undefined ? {} : { subject: searchSubject(query, targets) }),
    }
  }
  if (/^(read|view|open)/i.test(tool) && target !== undefined) {
    const offset = args['offset']
    const limit = args['limit']
    const start = typeof offset === 'number' && Number.isSafeInteger(offset) && offset > 0 ? offset : undefined
    const count = typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 ? limit : undefined
    // Claude/Cursor Read and Grok read_file use lines; skill offsets use characters.
    const range = /^(Read|read_file)$/i.test(tool) && start !== undefined
      ? `, ${count === undefined ? `from line ${start}` : `lines ${start}–${start + count - 1}`}`
      : undefined
    const parts = target.split(/[\\/]/).filter(Boolean)
    const filename = parts.at(-1) === 'SKILL.md' ? parts.slice(-2).join('/') : parts.at(-1)
    return {
      tool, detail: target, targets: [target],
      ...(range === undefined ? {} : { subject: `${filename}${range}` }),
    }
  }
  if (tool === 'Edit' && target !== undefined) return { tool, detail: target, targets: [target] }
  if (/^(Task|Agent|spawn_subagent)$/i.test(tool)) {
    const prompt = text(args['prompt']) ?? text(args['task']) ?? text(args['message'])
    const brief = text(args['description']) ?? prompt
    const subagent = subagentLaunch({
      description: args['description'],
      prompt,
      model: args['model'],
      effort: args['reasoning_effort'] ?? args['effort'],
    })
    return {
      tool,
      ...(brief === undefined ? {} : { subject: brief }),
      ...(subagent === undefined ? {} : { subagent }),
    }
  }
  // Preserve the existing selected detail fallback without copying arbitrary inputs.
  const detail = target ?? text(args['command']) ?? text(args['pattern']) ?? text(args['query']) ?? pageUrl(args['url'])
  return { tool, ...(detail === undefined ? {} : { detail: detail }) }
}

export function describeMcpTool(server: unknown, name: unknown, input: unknown): ToolActivity {
  const tool = text(name)
  const source = text(server)
  if (tool === undefined) return { tool: source === undefined ? 'MCP' : `MCP ${source}` }
  const qualified = tool.startsWith('mcp__') || tool.includes('__') || tool.includes('.')
    ? tool
    : source === undefined ? `MCP ${tool}` : `mcp__${source}__${tool}`
  return describeTool(qualified, input)
}

/** Redact every string the activity row can persist or show. */
export function redactToolActivity<T extends {
  detail?: string
  subject?: string
  command?: string
  targets?: string[]
  subagent?: SubagentLaunch
  output?: string
  error?: string
  edits?: { path: string; originPath?: string; panelPath?: string; before?: string; after?: string }[]
}>(activity: T, redact: (value: string) => string): T {
  return {
    ...activity,
    ...(activity.detail === undefined ? {} : { detail: clipRedacted(redact(activity.detail), 500) }),
    ...(activity.subject === undefined ? {} : { subject: clipRedacted(redact(activity.subject).replace(/\s+/g, ' ').trim(), 500) }),
    ...(activity.command === undefined ? {} : { command: clipCommand(redact(activity.command)) }),
    ...(activity.output === undefined ? {} : { output: redact(activity.output) }),
    ...(activity.error === undefined ? {} : { error: clipRedacted(errorLine(redact(activity.error)), 200) }),
    ...(activity.targets === undefined ? {} : { targets: activity.targets.map(redact) }),
    ...(activity.subagent === undefined ? {} : { subagent: {
      ...activity.subagent,
      ...(activity.subagent.title === undefined ? {} : { title: clipRedacted(redact(activity.subagent.title).replace(/\s+/g, ' ').trim(), 200) }),
      ...(activity.subagent.prompt === undefined ? {} : { prompt: redact(activity.subagent.prompt) }),
      ...(activity.subagent.model === undefined ? {} : { model: redact(activity.subagent.model) }),
      ...(activity.subagent.effort === undefined ? {} : { effort: redact(activity.subagent.effort) }),
    } }),
    ...(activity.edits === undefined ? {} : { edits: activity.edits.map((edit) => ({
      ...edit,
      path: redact(edit.path),
      ...(edit.originPath === undefined ? {} : { originPath: redact(edit.originPath) }),
      ...(edit.panelPath === undefined ? {} : { panelPath: redact(edit.panelPath) }),
      ...(edit.before === undefined ? {} : { before: redact(edit.before) }),
      ...(edit.after === undefined ? {} : { after: redact(edit.after) }),
    })) }),
  }
}
