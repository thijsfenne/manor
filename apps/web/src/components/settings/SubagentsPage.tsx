import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_SUBAGENT_POLICY,
  SUBAGENT_MAX_CONCURRENT_LIMIT,
  subagentChoices,
  type DriverName,
  type Effort,
  type SubagentPolicy,
} from '@manor/contracts'
import { EFFORTS, MODELS } from '../../runtimes'
import { ALL_EFFORTS, ALL_MODELS, SUBAGENT_DRIVERS, effortLabel, inOrder, narrowerModels, providerLabel } from '../../subagentPolicy'
import type { Notice } from '../../state'
import { Pill, PillGroup } from '../ui/Pill'
import { RequestNotice } from '../ui/RequestNotice'
import { Select } from '../ui/Select'
import { Switch } from '../ui/Switch'
import { SettingsGroup, SettingsPage, SettingsRow } from './SettingsLayout'

const policyKey = (policy: SubagentPolicy) => JSON.stringify(policy)

const atDefaults = (policy: SubagentPolicy) =>
  policyKey({ ...policy, personas: {} }) === policyKey(DEFAULT_SUBAGENT_POLICY)

/**
 * What subagents may run, house-wide. Every pick applies the moment it is made, like
 * any other toggle in Settings. Agents choose freely inside this; a request outside it
 * is refused with a reason the agent can read. Per-agent narrowing lives on the agent.
 */
export function SubagentsPage({ policy, notice, onRequest, onSave, onDismissNotice }: {
  /** Null until the server has answered. Nothing is saved over a policy not yet read. */
  policy: SubagentPolicy | null
  notice: Notice | null
  onRequest: () => void
  /** False when the socket was down and nothing left. */
  onSave: (policy: SubagentPolicy) => boolean
  onDismissNotice: () => void
}) {
  const [draft, setDraft] = useState(policy)
  const [offline, setOffline] = useState(false)
  // Saves still on their way back. Their echoes are this page's own picks arriving in
  // order and must not pull the switches back a step; anything else is another window.
  const inFlight = useRef<string[]>([])

  useEffect(() => onRequest(), [onRequest])

  useEffect(() => {
    if (policy === null) return
    const key = policyKey(policy)
    const at = inFlight.current.indexOf(key)
    if (at !== -1) {
      inFlight.current = inFlight.current.slice(at + 1)
      return
    }
    setDraft(policy)
  }, [policy])

  if (draft === null) {
    return (
      <SettingsPage title="Subagents">
        <p className="m-0 text-label text-dim">Reading the subagent settings…</p>
      </SettingsPage>
    )
  }

  const apply = (patch: Partial<SubagentPolicy>) => {
    const next = { ...draft, ...patch }
    onDismissNotice()
    setDraft(next)
    inFlight.current = [...inFlight.current, policyKey(next)]
    const sent = onSave(next)
    setOffline(!sent)
    if (!sent) inFlight.current = inFlight.current.slice(0, -1)
  }

  const models = new Set(draft.models)
  const efforts = new Set(draft.efforts)
  const toggleModel = (model: string) => {
    const next = new Set(models)
    if (next.has(model)) next.delete(model)
    else next.add(model)
    apply({ models: inOrder(ALL_MODELS, next) })
  }
  const toggleEffort = (effort: Effort) => {
    const next = new Set(efforts)
    if (next.has(effort)) next.delete(effort)
    else next.add(effort)
    apply({ efforts: inOrder(ALL_EFFORTS, next) })
  }
  const setProvider = (driver: DriverName, on: boolean) => {
    const next = new Set(models)
    for (const option of MODELS[driver]) {
      if (on) next.add(option.value)
      else next.delete(option.value)
    }
    apply({ models: inOrder(ALL_MODELS, next) })
  }
  // Checked against the persona-free set, which is what every agent without her own
  // narrowing gets; an empty answer means every delegation is refused.
  const usable = subagentChoices({ ...draft, personas: {} }, '').length > 0
  const narrower = narrowerModels(draft.models, draft.efforts)

  return (
    <SettingsPage
      title="Subagents"
      description="Agents start subagents on any model and level allowed here. A request outside it is refused with the reason."
    >
      <SettingsGroup
        title="Allowed"
        onRestore={() => apply({ ...DEFAULT_SUBAGENT_POLICY, personas: draft.personas })}
        restoreDisabled={atDefaults(draft)}
      >
        <div className="flex flex-col gap-3 py-3">
          <span className="text-[14px] font-medium text-text">Models</span>
          {SUBAGENT_DRIVERS.map((driver) => {
            const own = MODELS[driver]
            const allOn = own.every((option) => models.has(option.value))
            return (
              <PillGroup
                key={driver}
                label={providerLabel(driver)}
                action={{ label: allOn ? 'Clear' : 'Select all', onSelect: () => setProvider(driver, !allOn) }}
              >
                {own.map((option) => (
                  <Pill key={option.value} label={option.label} on={models.has(option.value)} onToggle={() => toggleModel(option.value)} />
                ))}
              </PillGroup>
            )
          })}
        </div>
        <div className="flex flex-col gap-2 py-3">
          <span className="text-[14px] font-medium text-text">Effort levels</span>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Effort levels">
            {EFFORTS.map((option) => (
              <Pill key={option.value} label={option.label} on={efforts.has(option.value)} onToggle={() => toggleEffort(option.value)} />
            ))}
          </div>
          {/* The one thing two lists cannot say on their own: some models run fewer
              levels than the list allows, and a model with none left is refused. */}
          {!usable ? (
            <p className="m-0 text-label text-danger" role="status">
              {draft.models.length === 0
                ? 'No models selected, so every subagent request is refused.'
                : draft.efforts.length === 0
                  ? 'No effort levels selected, so every subagent request is refused.'
                  : 'None of the selected models runs at these levels, so every subagent request is refused.'}
            </p>
          ) : narrower.length === 0 || draft.efforts.length === 0 ? null : (
            <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-label text-dim">
              {narrower.map((entry) => (
                <li key={entry.label} className={entry.efforts.length === 0 ? 'text-danger' : undefined}>
                  {entry.efforts.length === 0
                    ? `${entry.label} runs none of these levels, so it is refused.`
                    : `${entry.label} runs only ${entry.efforts.map(effortLabel).join(', ')}.`}
                </li>
              ))}
            </ul>
          )}
        </div>
        <SettingsRow label="Maximum concurrent subagents" description="Per chat, counting every subagent still running.">
          <div className="w-[88px]">
            <Select
              label="Maximum concurrent subagents"
              value={String(draft.maxConcurrent)}
              options={Array.from({ length: SUBAGENT_MAX_CONCURRENT_LIMIT }, (_, index) => ({ value: String(index + 1), label: String(index + 1) }))}
              onChange={(value) => apply({ maxConcurrent: Number(value) })}
            />
          </div>
        </SettingsRow>
        <SettingsRow label="Allow subagents to delegate" description="A subagent may start its own, one level deeper at most.">
          <Switch label="Allow subagents to delegate" checked={draft.allowNested} onChange={(allowNested) => apply({ allowNested })} />
        </SettingsRow>
      </SettingsGroup>
      {notice !== null ? (
        <RequestNotice notice={notice} onDismiss={onDismissNotice} />
      ) : offline ? (
        <p className="m-0 text-label text-danger" role="status">Nothing was sent, the connection is down. Try again once it is back.</p>
      ) : null}
    </SettingsPage>
  )
}
