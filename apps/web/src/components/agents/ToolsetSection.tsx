import { useId, useState, type ReactNode } from 'react'
import { ArrowRight01Icon, Settings01Icon } from '@hugeicons/core-free-icons'
import { Settings01Icon as SettingsSolidIcon } from '@manor/client-runtime/solid-icons'
import type { AgentConfig } from '@manor/contracts'
import { formatTools, parseTools } from '../../persona'
import { isKnownTool, TOOL_GROUPS } from '../../runtimes'
import { Icon } from '../Icon'
import { Checkbox } from '../ui/Checkbox'
import { formFieldClass, formInputClass, formLabelClass } from '../ui/FormField'
import { IconButton } from '../ui/IconButton'
import { Switch } from '../ui/Switch'

const CAPABILITIES = [
  { name: 'Read files', description: 'Open files and find text or folders.', tools: ['Read', 'Glob', 'Grep'] },
  { name: 'Change files', description: 'Create and edit files, including notebooks.', tools: ['Write', 'Edit', 'NotebookEdit'] },
  { name: 'Run commands on your Mac', description: 'Run terminal commands, including programs that can change files.', tools: ['Bash'] },
  { name: 'Search the web', description: 'Search online and read web pages.', tools: ['WebSearch', 'WebFetch'] },
  { name: 'Delegate and use skills', description: 'Ask subagents for help, use skills and discover connected tools.', tools: ['Agent', 'Skill', 'SendMessage', 'Monitor', 'ToolSearch'] },
]

const ADVANCED_DESCRIPTIONS: Record<string, string> = {
  'Background work': 'Create tasks, check their progress and stop them.',
  Scheduling: 'Schedule tasks and manage reminders.',
  Harness: 'Use provider features such as workflows and worktrees.',
}

// Mirrors the mapped names in grokDriver. Agent is deliberately absent: that
// driver disables subagents for persona turns. Unmapped saved names stay intact.
const GROK_CONTROLS = new Set([
  'Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash', 'WebSearch', 'WebFetch',
  'Monitor', 'ToolSearch', 'TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate',
  'TaskOutput', 'TaskStop', 'CronCreate', 'CronList', 'CronDelete', 'Workflow',
])

const PROVIDER_NOTE: Record<AgentConfig['driver'], string> = {
  claude: 'These choices apply without a linked project folder. Linked folders give Claude all built-in tools; image attachments can add file reading. Connections are managed separately below.',
  grok: 'Grok groups some tools together. Editing also allows reading; connections add tool discovery. Subagents are disabled for personas. Unmapped names stay saved.',
  codex: 'Codex does not restrict individual tools. The saved list can affect its working mode, but these switches are not permissions. Your saved choices are kept when you change provider.',
  cursor: 'Cursor does not restrict individual tools. A non-empty list can enable its acting mode; linked folders and writable connections can do that too. Your saved choices are kept.',
  mock: 'Mock only simulates tool activity. It uses whether this list is empty, not individual permissions. Your saved choices are kept.',
}

/** Only explicit edits change the list. Opening disclosures or switching provider is lossless. */
export function ToolsetSection({ driver, tools, disabled = false, onChange }: {
  driver: AgentConfig['driver']
  tools: string[]
  disabled?: boolean
  onChange: (tools: string[]) => void
}) {
  const [custom, setCustom] = useState(() => formatTools(tools.filter((tool) => !isKnownTool(tool))))
  const [expandedTools, setExpandedTools] = useState<string[]>([])
  const editable = driver === 'claude' || driver === 'grok'
  const canControl = (tool: string) => editable && (driver !== 'grok' || GROK_CONTROLS.has(tool))
  const noteId = useId()

  const toggle = (names: string[]) => {
    const allOn = names.every((name) => tools.includes(name))
    onChange(allOn ? tools.filter((tool) => !names.includes(tool)) : [...tools, ...names.filter((name) => !tools.includes(name))])
  }

  const row = (group: { name: string; description: string; tools: string[] }) => {
    const descriptionId = `${noteId}-${group.name.replaceAll(' ', '-')}`
    const toolsId = `${descriptionId}-tools`
    const open = expandedTools.includes(group.name)
    const offered = editable ? group.tools.filter(canControl) : group.tools
    const selected = offered.filter((tool) => tools.includes(tool)).length
    const mixed = selected > 0 && selected < offered.length
    const grokDiscovery = driver === 'grok' && group.name === 'Delegate and use skills'
    const name = grokDiscovery ? 'Discover tools and monitor work' : group.name
    const description = grokDiscovery ? 'Find connected tools and follow ongoing work.'
      : driver === 'grok' && group.name === 'Change files' ? 'Create and edit files. Grok also enables reading.' : group.description

    return (
      <div key={group.name} className="py-2">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="text-sm font-medium text-text">{name}</span>
              {mixed ? <span className="text-meta text-muted">Some on</span> : null}
            </div>
            <p id={descriptionId} className="m-0 mt-0.5 text-label text-muted">{description}</p>
          </div>
          <div className="flex flex-none items-center gap-2">
            <IconButton
              icon={open ? SettingsSolidIcon : Settings01Icon}
              solid={open}
              label={`Individual tools for ${name}`}
              selected={open}
              aria-expanded={open}
              aria-controls={toolsId}
              onClick={() => setExpandedTools((current) => current.includes(group.name)
                ? current.filter((name) => name !== group.name)
                : [...current, group.name])}
            />
            <Switch
              label={name}
              describedBy={`${descriptionId} ${noteId}`}
              checked={offered.length > 0 && selected === offered.length}
              indeterminate={mixed}
              disabled={disabled || !editable || offered.length === 0}
              onChange={() => toggle(offered)}
            />
          </div>
        </div>
        {open ? (
          <div id={toolsId} className="flex flex-wrap gap-x-4 gap-y-2 pt-2 pb-1" role="group" aria-label={`${name} tool names`}>
            {group.tools.map((tool) => (
              <label key={tool} className="inline-flex items-center gap-2 text-label text-muted">
                <Checkbox
                  checked={tools.includes(tool)}
                  disabled={disabled || !canControl(tool)}
                  onChange={() => toggle([tool])}
                />
                <span>{tool}</span>
                {driver === 'grok' && !canControl(tool) ? <span className="text-meta">(not controlled here)</span> : null}
              </label>
            ))}
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <section className={formFieldClass} aria-label="Toolset">
      <span className={formLabelClass}>{editable ? 'Toolset' : 'Toolset · saved preferences'}</span>
      <p id={noteId} className="m-0 text-label text-muted">{PROVIDER_NOTE[driver]}</p>
      <div className="flex flex-col gap-1">{CAPABILITIES.map(row)}</div>
      <ToolDisclosure label="Advanced">
        {TOOL_GROUPS.filter((group) => group.name in ADVANCED_DESCRIPTIONS).map((group) => row({
          ...group,
          description: ADVANCED_DESCRIPTIONS[group.name]!,
        }))}
        <label className="mt-3 flex flex-col gap-1.5 text-label text-muted">
          <span>Anything else</span>
          <input
            className={formInputClass}
            value={custom}
            readOnly={!editable}
            disabled={disabled}
            placeholder="Extra tool names, separated by commas"
            onChange={(event) => {
              if (!editable) return
              setCustom(event.target.value)
              const known = tools.filter(isKnownTool)
              const typed = parseTools(event.target.value)
              onChange([...known, ...typed.filter((tool) => !known.includes(tool))])
            }}
          />
        </label>
      </ToolDisclosure>
    </section>
  )
}

function ToolDisclosure({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div className="mt-1">
      <button type="button" aria-expanded={open} aria-controls={id}
        className="flex cursor-pointer items-center gap-1 border-0 bg-transparent px-0 py-1 text-label text-muted hover:text-text"
        onClick={() => setOpen((current) => !current)}>
        <Icon icon={ArrowRight01Icon} size={12} className={open ? 'rotate-90' : ''} />
        {label}
      </button>
      {open ? <div id={id} className="pt-2 pb-1">{children}</div> : null}
    </div>
  )
}
