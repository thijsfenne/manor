import {
  type ChatOverride,
  type SingleRuntime,
} from '@manor/contracts'
import {
  SINGLE_DRIVERS,
  activeEffort,
  activeModel,
  activeSpeed,
  defaultSingleRuntime,
  effectiveDriver,
  isAutoOn,
  isSingleDriver,
  readSingleRuntime,
  singleRuntimeVoice,
} from '../runtimeChoices'
import { defaultModel } from '../runtimes'
import { RuntimeMenu } from './RuntimeMenu'
import { useHostAuto } from '../useHostAuto'

export { defaultSingleRuntime, readSingleRuntime }

interface SingleRuntimeControlProps {
  override: ChatOverride
  fallback: SingleRuntime
  disabled: boolean
  allowAuto?: boolean
  onChange: (override: ChatOverride) => void
}

/** Provider, model and reasoning for a chat whose voice is not a Manor persona. */
export function SingleRuntimeControl({
  override,
  fallback,
  disabled,
  allowAuto = true,
  onChange,
}: SingleRuntimeControlProps) {
  const hostAuto = useHostAuto()
  const voice = singleRuntimeVoice(readSingleRuntime(override, fallback))

  const select = (next: ChatOverride) => {
    if (allowAuto && isAutoOn(next, hostAuto) && next.autoResolved !== true) {
      onChange(next)
      return
    }
    const driver = effectiveDriver(voice, next)
    if (!isSingleDriver(driver)) return
    const model = activeModel(voice, next) ?? defaultModel(driver)
    if (model === undefined) return
    const speed = activeSpeed(voice, next)
    onChange({
      driver,
      model,
      effort: next.effort ?? activeEffort(voice, next),
      auto: false,
      ...(speed === 'fast' ? { speed } : {}),
    })
  }

  return (
    <RuntimeMenu
      agent={voice}
      override={override}
      disabled={disabled}
      allowedDrivers={SINGLE_DRIVERS}
      layout="split"
      allowAuto={allowAuto}
      effortDefault={fallback.effort}
      title="Provider, model, reasoning and speed for this chat"
      onChange={select}
    />
  )
}
