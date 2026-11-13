import { useId } from 'react'
import { subagentChoices, type AgentConfig, type Effort, type SubagentPolicy } from '@manor/contracts'
import { EFFORTS, MODELS } from '../../runtimes'
import { ALL_EFFORTS, ALL_MODELS, SUBAGENT_DRIVERS, inOrder, providerLabel } from '../../subagentPolicy'
import { formFieldClass, formHintClass, formLabelClass } from '../ui/FormField'
import { Pill, PillGroup } from '../ui/Pill'
import { Switch } from '../ui/Switch'

/** One persona's narrowing: absent means she uses the global lists as they stand. */
export type PersonaSubagents = SubagentPolicy['personas'][string] | undefined

/** Only these drivers hand a persona the delegate tools today. */
const DELEGATING_DRIVERS: ReadonlySet<AgentConfig['driver']> = new Set(['claude', 'codex'])

const OFF_IN_SETTINGS = 'Off in Settings, so no agent can use it.'

/**
 * What this persona's subagents may run, beside her other capabilities but apart
 * from "Delegate and use skills", which bundles provider features. It can only
 * narrow Settings: a choice Settings rules out shows, disabled, with the reason.
 */
export function SubagentsSection({ agentId, driver, policy, own, onChange }: {
  agentId: string
  driver: AgentConfig['driver']
  /** Null until the server has answered; the section waits rather than guessing. */
  policy: SubagentPolicy | null
  own: PersonaSubagents
  onChange: (own: PersonaSubagents) => void
}) {
  const hintId = useId()
  const restricted = own !== undefined

  if (!DELEGATING_DRIVERS.has(driver)) {
    return (
      <section className={formFieldClass} aria-label="Subagents">
        <span className={formLabelClass}>Subagents</span>
        <p className={`m-0 ${formHintClass}`}>Only Claude and Codex agents can start subagents for now.</p>
      </section>
    )
  }

  if (policy === null) {
    return (
      <section className={formFieldClass} aria-label="Subagents">
        <span className={formLabelClass}>Subagents</span>
        <p className={`m-0 ${formHintClass}`}>Reading the subagent settings…</p>
      </section>
    )
  }

  const models = new Set(own?.models ?? policy.models)
  const efforts = new Set(own?.efforts ?? policy.efforts)
  const globalModels = new Set(policy.models)
  const globalEfforts = new Set(policy.efforts)
  const toggleModel = (model: string) => {
    const next = new Set(models)
    if (next.has(model)) next.delete(model)
    else next.add(model)
    onChange({ ...own, models: inOrder(ALL_MODELS, next) })
  }
  const toggleEffort = (effort: Effort) => {
    const next = new Set(efforts)
    if (next.has(effort)) next.delete(effort)
    else next.add(effort)
    onChange({ ...own, efforts: inOrder(ALL_EFFORTS, next) })
  }
  const choices = subagentChoices({ ...policy, personas: own === undefined ? {} : { [agentId]: own } }, agentId).length

  return (
    <section className={formFieldClass} aria-label="Subagents">
      <span className={formLabelClass}>Subagents</span>
      <div className="flex items-center justify-between gap-4 py-1">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium text-text">Restrict for this agent</span>
          <span id={hintId} className={formHintClass}>
            {restricted ? 'Narrows the models and levels in Settings.' : 'Uses the models and levels in Settings.'}
          </span>
        </div>
        <Switch
          label="Restrict subagents for this agent"
          describedBy={hintId}
          checked={restricted}
          onChange={(on) => onChange(on ? { models: [...policy.models], efforts: [...policy.efforts] } : undefined)}
        />
      </div>

      {!restricted ? null : (
        <div className="flex flex-col gap-3">
          {SUBAGENT_DRIVERS.map((provider) => (
            <PillGroup key={provider} label={providerLabel(provider)}>
              {MODELS[provider].map((option) => {
                const allowed = globalModels.has(option.value)
                return (
                  <Pill
                    key={option.value}
                    label={option.label}
                    on={allowed && models.has(option.value)}
                    disabled={!allowed}
                    {...(allowed ? {} : { hint: OFF_IN_SETTINGS })}
                    onToggle={() => toggleModel(option.value)}
                  />
                )
              })}
            </PillGroup>
          ))}
          <PillGroup label="Effort levels">
            {EFFORTS.map((option) => {
              const allowed = globalEfforts.has(option.value)
              return (
                <Pill
                  key={option.value}
                  label={option.label}
                  on={allowed && efforts.has(option.value)}
                  disabled={!allowed}
                  {...(allowed ? {} : { hint: OFF_IN_SETTINGS })}
                  onToggle={() => toggleEffort(option.value)}
                />
              )
            })}
          </PillGroup>
          <p className={`m-0 text-label ${choices === 0 ? 'text-danger' : 'text-dim'}`} role="status">
            {choices === 0
              ? 'Nothing is left, so every subagent request from this agent is refused.'
              : `${choices} ${choices === 1 ? 'model' : 'models'} left for this agent's subagents.`}
          </p>
        </div>
      )}
    </section>
  )
}
