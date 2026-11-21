import { useRef, useState } from 'react'
import type { AgentConfig, AgentDraft, ChatOverride } from '@manor/contracts'
import { cleanDraft, draftOf } from '../persona'
import { effectiveDriver, runtimeParts } from '../runtimeChoices'
import { CATALOG_DRIVERS, defaultModel } from '../runtimes'
import { withRuntimePick } from './agents/NewAgentFields'
import { ProviderMark } from './ProviderMark'
import { RuntimeSections, SPLIT_PICKER_SHELL, SPLIT_PICKER_WIDTH } from './RuntimeMenu'
import { Popover } from './ui/Popover'
import { useDismiss } from './ui/useDismiss'

const NO_PIN: ChatOverride = {}

/**
 * Whether a DM's top bar names a model: a mock persona reaches none, and a Session
 * persona's old DM is view-only, so neither has a next turn to name.
 */
export const namesDmRuntime = (agent: AgentConfig | undefined): agent is AgentConfig =>
  agent !== undefined && agent.driver !== 'mock' && agent.placement !== 'session'

/**
 * The model a one-agent DM runs on, at the far end of the desktop top bar, opening the
 * composer's own picker. A DM has no chat pin of its own: a pick saves the agent's
 * setting, so this and Agent settings always show the same value. The label reads the
 * stored agent only, never the pick on its way, so a refused save cannot leave it
 * naming a model nothing runs. A pin left over from before is what the DM runs until a
 * pick replaces it; it goes with the save that pick sends. Auto never runs in a DM,
 * so the label is always a concrete model.
 *
 * Not positioned itself: the card hangs off the top bar's unclipped wrapper, which lets
 * the label's own clip hide it whole in a narrow pane without clipping the card.
 */
export function DmRuntimePicker({ agent, pin = NO_PIN, disabled, onSaveAgent, onClearPin }: {
  agent: AgentConfig
  pin?: ChatOverride
  disabled: boolean
  onSaveAgent: (draft: AgentDraft, requestId: string) => boolean
  onClearPin?: () => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [picking, setPicking] = useState(false)
  // A dropped connection closes the card: a pick then could not be sent.
  const open = picking && !disabled
  useDismiss(open, () => setPicking(false), { within: [rootRef], escape: true })
  // An agent saved before models were required runs on its driver's default; say which.
  const voice: AgentConfig = { ...agent, model: agent.model ?? defaultModel(agent.driver) }
  const parts = runtimeParts(voice, pin, false)
  // The last pick sent, until the stored agent changes. The menu reads it and the next
  // pick builds on it, so picks made before the first one reads back compose instead of
  // undoing each other; the label above stays on what is stored. A pin it replaced is
  // already on its way out, so the menu no longer reads it either.
  const [sent, setSent] = useState<{ base: AgentConfig; draft: AgentDraft } | null>(null)
  const pending = sent?.base === agent ? sent.draft : undefined
  const { speed: _speed, ...unsped } = voice
  // Speed from the pick alone: a pick that turned Fast off carries no speed at all.
  const menuVoice: AgentConfig = pending === undefined ? voice : { ...unsped, ...pending, id: agent.id }
  const menuPin = pending === undefined ? pin : NO_PIN

  const pick = (next: ChatOverride) => {
    const draft = cleanDraft(withRuntimePick(pending ?? draftOf(voice), next))
    if (!onSaveAgent(draft, crypto.randomUUID())) return
    setSent({ base: agent, draft })
    if (Object.keys(pin).length > 0) onClearPin?.()
  }

  return (
    <div ref={rootRef} className="flex">
      <button
        type="button"
        className={`flex h-7 cursor-pointer items-center gap-1.5 rounded-button border-0 px-2 text-meta disabled:cursor-default disabled:opacity-45 ${
          open ? 'bg-icon-fill text-text' : 'bg-transparent text-muted hover:bg-icon-fill hover:text-text'
        }`}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Change ${agent.name}'s model, ${parts.model} ${parts.effort}`}
        title={`${agent.name}'s provider, model and reasoning`}
        onClick={() => setPicking((current) => !current)}
      >
        <ProviderMark driver={effectiveDriver(voice, pin)} size={12} />
        <span>{parts.model}</span>
        {parts.effort === '' ? null : <span className="text-dim @max-[520px]/top-bar:hidden">{parts.effort}</span>}
      </button>
      <Popover
        open={open}
        origin="top-right"
        className={`no-drag absolute top-[calc(100%+6px)] right-0 z-20 ${SPLIT_PICKER_SHELL} ${SPLIT_PICKER_WIDTH}`}
        role="menu"
        aria-label={`${agent.name}'s model`}
      >
        <RuntimeSections
          agent={menuVoice}
          override={menuPin}
          allowedDrivers={CATALOG_DRIVERS}
          layout="split"
          allowAuto={false}
          marksDefault={false}
          onChange={pick}
        />
      </Popover>
    </div>
  )
}
