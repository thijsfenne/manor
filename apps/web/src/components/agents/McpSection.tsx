import { useState } from 'react'
import { Alert01Icon, ArrowDown01Icon } from '@hugeicons/core-free-icons'
import type { AgentDraft, McpServerConfig } from '@manor/contracts'
import { attachmentOf, setExcludedTools, toggleAttachment, toggleExcludedTool } from '../../mcp'
import { Icon } from '../Icon'
import { Checkbox } from '../ui/Checkbox'
import { formFieldClass, formHintClass, formLabelClass } from '../ui/FormField'
import { Pill, PillGroup } from '../ui/Pill'

interface McpSectionProps {
  draft: AgentDraft
  registry: McpServerConfig[]
  onChange: (mcpServers: AgentDraft['mcpServers']) => void
}

/**
 * Which MCP servers this persona holds. A separate field from the toolset on purpose:
 * `--tools` was measured not to gate MCP at all, so an empty toolset with a server
 * attached is a persona with tools. Attaching is the whole access decision, which is
 * why detaching is a checkbox and not a full exclusion list.
 */
export function McpSection({ draft, registry, onChange }: McpSectionProps) {
  const [expanded, setExpanded] = useState<string | null>(null)

  if (registry.length === 0) {
    return (
      <div className={formFieldClass}>
        <span className={formLabelClass}>MCP servers</span>
        <span className={formHintClass}>
          None registered yet. Add one under Plugins → Connectors to make it attachable here.
        </span>
      </div>
    )
  }

  return (
    <div className={formFieldClass}>
      <span className={formLabelClass}>MCP servers</span>
      <div className="flex flex-col rounded-lg border border-line bg-surface-2">
        {registry.map((server) => {
          const attachment = attachmentOf(draft, server.id)
          const held = attachment !== undefined
          const open = expanded === server.id
          const excluded = attachment?.disabledTools.length ?? 0
          return (
            <div key={server.id} className="border-b border-line last:border-b-0">
              <div className="flex items-start gap-2.5 px-2.5 py-2">
                <Checkbox
                  className="mt-[3px]"
                  checked={held}
                  label={`Attach ${server.name}`}
                  onChange={() => onChange(toggleAttachment(draft, server.id))}
                />
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="font-mono text-[12px] text-text">{server.name}</span>
                    <span className="text-meta text-dim">
                      {server.tools.length} {server.tools.length === 1 ? 'tool' : 'tools'}
                    </span>
                    {server.writes ? (
                      <span className="inline-flex items-center gap-1 text-meta text-warn">
                        <Icon icon={Alert01Icon} size={11} />
                        can change things
                      </span>
                    ) : null}
                  </div>
                  {server.description ? (
                    <span className="truncate text-meta text-muted">{server.description}</span>
                  ) : null}
                  {/* Only once attached: excluding tools of a server nobody holds is
                      a control with nothing behind it. */}
                  {held && server.tools.length > 0 ? (
                    <button
                      type="button"
                      className="mt-0.5 inline-flex w-fit cursor-pointer items-center gap-1 border-0 bg-transparent p-0 text-left text-meta text-dim underline decoration-dotted underline-offset-2 hover:text-muted [font:inherit]"
                      aria-expanded={open}
                      onClick={() => setExpanded(open ? null : server.id)}
                    >
                      {excluded === 0 ? 'All tools' : `${excluded} excluded`}
                      <Icon icon={ArrowDown01Icon} size={12} className={`flex-none transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                    </button>
                  ) : null}
                </div>
              </div>
              {held && open ? (
                <div className="border-t border-line px-2.5 py-2">
                  <PillGroup
                    label="Tools this persona may call"
                    // Never "exclude all": that is the state the hint below spends a
                    // sentence talking people out of, since it costs the instructions
                    // block and grants nothing. Detaching is the way to zero.
                    action={
                      excluded === 0
                        ? undefined
                        : { label: 'Restore all', onSelect: () => onChange(setExcludedTools(draft, server.id, [])) }
                    }
                  >
                    {server.tools.map((tool) => (
                      <Pill
                        key={tool}
                        label={tool}
                        mono
                        struck
                        on={!(attachment?.disabledTools.includes(tool) ?? false)}
                        onToggle={() => onChange(toggleExcludedTool(draft, server.id, tool))}
                      />
                    ))}
                  </PillGroup>
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}
