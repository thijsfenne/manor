import {
  SIDE_CHAT_DEFAULTS,
  SINGLE_CHAT_VOICE,
  driverForModel,
  type AgentConfig,
  type ChatOverride,
  type Effort,
} from '@manor/contracts'
import { activeEffort, activeModel, effectiveDriver } from '../runtimeChoices'
import { defaultModel } from '../runtimes'
import { RuntimeMenu } from './RuntimeMenu'

interface RuntimeDefaults {
  model: string
  effort: Effort
}

/** The provider a model belongs to, falling back the way the server's own resolve does. */
const driverOf = (model: string, defaults: RuntimeDefaults): AgentConfig['driver'] =>
  driverForModel(model) ?? driverForModel(defaults.model) ?? 'claude'

/** A persona-less voice on the defaults, which is what the shared picker marks as Default. */
const voiceOn = (defaults: RuntimeDefaults): AgentConfig => ({
  ...SINGLE_CHAT_VOICE,
  color: '',
  character: '',
  driver: driverOf(defaults.model, defaults),
  model: defaults.model,
  effort: defaults.effort,
  allowedTools: [],
  mcpServers: [],
  memoryScope: false,
  description: '',
  role: '',
  isCos: false,
})

interface SideRuntimeMenuProps {
  model: string
  effort: Effort
  /** True while the panel has no thread yet: there is nothing to write the pick to. */
  disabled: boolean
  /** What the menu marks as Default. The side chat's own unless another tool-less job says otherwise. */
  defaults?: RuntimeDefaults
  title?: string
  onChange: (model: string, effort: Effort) => void
}

/**
 * What the side chat runs on, in its composer's bottom row, and what the note AI runs
 * on, in Settings: both are a model with an effort and nothing else.
 *
 * Provider is represented in the shared picker, but remains derived from the chosen
 * model when the side chat stores the result. Speed stays absent because the side-chat
 * runtime has no speed field.
 */
export function SideRuntimeMenu({ model, effort, disabled, defaults = SIDE_CHAT_DEFAULTS, title = 'Provider, model and reasoning for this side chat', onChange }: SideRuntimeMenuProps) {
  const voice = voiceOn(defaults)
  const driver = driverOf(model, defaults)
  const override: ChatOverride = {
    // Side chats are outside Auto, and absent means on, so the label is told.
    auto: false,
    ...(driver === voice.driver ? {} : { driver }),
    ...(model === defaults.model ? {} : { model }),
    ...(effort === defaults.effort ? {} : { effort }),
  }

  const select = (next: ChatOverride) => {
    const nextDriver = effectiveDriver(voice, next)
    const nextModel = activeModel(voice, next) ?? defaultModel(nextDriver)
    if (nextModel === undefined) return
    const nextEffort = activeEffort(voice, next)
    if (nextModel !== model || nextEffort !== effort) onChange(nextModel, nextEffort)
  }

  return (
    <RuntimeMenu
      agent={voice}
      override={override}
      disabled={disabled}
      layout="split"
      compact
      allowSpeed={false}
      allowAuto={false}
      title={title}
      onChange={select}
    />
  )
}
