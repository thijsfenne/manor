import type { ComponentPropsWithoutRef, CSSProperties } from 'react'
import { DOCK_FLOAT, DOCK_PANEL_GAP, DOCK_PANEL_SHELL } from '../ui/dockPanel'
import { AgentSettings, type AgentSettingsProps } from './AgentSettings'

interface Props extends AgentSettingsProps {
  onClose: () => void
  width: number
  resizing: boolean
  resizeProps: ComponentPropsWithoutRef<'div'>
  overlay?: boolean
  revealed?: boolean
  phone?: boolean
}

/** Agent settings docked beside the agent's DM: the same editor Settings → Agents hosts. */
export function AgentSettingsPanel({ width, resizing, resizeProps, overlay = false, revealed = true, phone = false, ...settings }: Props) {
  return (
    <aside
      aria-label="Agent settings"
      className={`${phone ? 'absolute inset-0 z-[8]' : `${overlay ? `dock-panel-reveal ${DOCK_FLOAT} max-w-[calc(100%-16px)]` : 'relative'} my-2 mr-2`} flex min-h-0 flex-col ${DOCK_PANEL_SHELL}`}
      data-open={overlay && !phone ? revealed : undefined}
      style={{
        width: phone ? '100%' : `calc(var(--agent-settings-width) - ${DOCK_PANEL_GAP}px)`,
        '--agent-settings-width': `${width}px`,
      } as CSSProperties}
    >
      {phone ? null : (
        <div {...resizeProps} className="group absolute inset-y-0 left-0 z-30 w-2 touch-none cursor-col-resize outline-none max-[760px]:hidden">
          <span
            className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 ${
              resizing ? 'bg-primary' : 'bg-transparent group-hover:bg-muted group-focus-visible:bg-primary group-active:bg-primary'
            }`}
          />
        </div>
      )}
      {/* Keyed on the agent so another DM's panel never shows this one's draft or page. */}
      <AgentSettings key={settings.agent.id} {...settings} />
    </aside>
  )
}
