import type { AgentConfig } from '@manor/contracts'

/**
 * What the providers actually offer, as the form should present it. Every value in
 * this file was read off the installed CLIs (last refreshed for Codex on 2026-09-29)
 * rather than remembered:
 * the model ids from `claude --help`, `codex debug models` on the bundled CLI,
 * and Cursor's `agent --list-models`; the effort levels from the respective CLI flags, the tool
 * names by asking `claude --tools <name>`
 * which of them resolved. A name that does not resolve is silently dropped by the
 * CLI, which is the worst failure this form could ship, so nothing unverified is
 * offered as a choice here.
 */

export interface Option<T extends string> {
  value: T
  label: string
}

export const PROVIDERS: Option<AgentConfig['driver']>[] = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'grok', label: 'Grok Build' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'mock', label: 'Mock (no provider)' },
]

export { MODELS, EFFORTS, defaultModel, modelLabel, effortsFor, clampsEffort } from '@manor/contracts'

export interface ToolGroup {
  name: string
  tools: string[]
}

/**
 * The Claude Code built-in set, grouped so the things a knowledge-work persona
 * needs read first and the harness machinery sits at the bottom. Codex cannot pick
 * per tool; Grok maps the shared names to its native built-ins in its driver.
 */
export const TOOL_GROUPS: ToolGroup[] = [
  { name: 'Files', tools: ['Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep'] },
  { name: 'Machine', tools: ['Bash'] },
  { name: 'Web', tools: ['WebSearch', 'WebFetch'] },
  { name: 'Delegation', tools: ['Agent', 'Skill', 'SendMessage', 'Monitor', 'ToolSearch'] },
  { name: 'Background work', tools: ['TaskCreate', 'TaskGet', 'TaskList', 'TaskOutput', 'TaskUpdate', 'TaskStop'] },
  { name: 'Scheduling', tools: ['CronCreate', 'CronList', 'CronDelete', 'ScheduleWakeup', 'PushNotification', 'RemoteTrigger'] },
  { name: 'Harness', tools: ['Artifact', 'Workflow', 'ReportFindings', 'DesignSync', 'EnterWorktree', 'ExitWorktree'] },
]

/** Every pill name, in the order the groups read. The toolset is composed in it. */
export const KNOWN_TOOLS: readonly string[] = TOOL_GROUPS.flatMap((group) => group.tools)

const KNOWN = new Set(KNOWN_TOOLS)

/** True for a name the pills cover, so the rest can be kept as free text. */
export const isKnownTool = (tool: string): boolean => KNOWN.has(tool)
