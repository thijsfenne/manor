import { useEffect, useState } from 'react'
import {
  DEFAULT_HOUSE_SETTINGS,
  type DesktopDictationBridge,
  type DictationLanguage,
  type DictationModelId,
  type DictationModelStatus,
  type HouseSettings,
} from '@manor/contracts'
import { desktopDictation } from '../../desktopBrowser'
import { DICTATION_MODEL_IDS, DICTATION_MODELS, formatModelSize, modelStatus, useDictationModels } from '../../dictation/models'
import { Button } from '../ui/Button'
import { Select, type SelectOption } from '../ui/Select'
import { SettingsGroup, SettingsPage, SettingsRow } from './SettingsLayout'

const DESCRIPTION = 'Dictate a message in the composer. Speech is turned into text on this Mac; nothing is sent to a service.'

const LANGUAGE_OPTIONS: readonly SelectOption<DictationLanguage>[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'nl', label: 'Dutch' },
  { value: 'en', label: 'English' },
]

/** The models a fixed language choice reaches, named in the note under Language. */
const LANGUAGE_MODELS = DICTATION_MODEL_IDS.filter((id) => DICTATION_MODELS[id].honoursLanguage)
  .map((id) => DICTATION_MODELS[id].label)
  .join(' and ')

/** Kept in the list while the saved microphone is unplugged, so the choice is not silently changed. */
const UNAVAILABLE = 'Unavailable microphone'

// The bridge answers with a status push, which is what the row shows; a refused call changes nothing.
const quietly = (call: Promise<void>) => void call.catch(() => undefined)

const mediaDevices = () => (typeof navigator === 'undefined' ? undefined : navigator.mediaDevices)

/**
 * This Mac's audio inputs with a name, live across plugging in and out. Null until the
 * first read lands; an empty list where the shell has no media devices at all.
 */
function useMicrophones(enabled: boolean) {
  const [inputs, setInputs] = useState<{ deviceId: string; label: string }[] | null>(() => (mediaDevices() === undefined ? [] : null))
  useEffect(() => {
    const devices = mediaDevices()
    if (!enabled || devices === undefined) return
    // Reads can overlap when devices change quickly; only the latest one lands, and none after unmount.
    let latest = 0
    const read = () => {
      const turn = ++latest
      devices.enumerateDevices().then(
        (list) => {
          if (turn !== latest) return
          // `default` and `communications` repeat a real input under another id.
          setInputs(list
            .filter((device) => device.kind === 'audioinput' && device.label !== '' && device.deviceId !== 'default' && device.deviceId !== 'communications')
            .map(({ deviceId, label }) => ({ deviceId, label })))
        },
        () => { if (turn === latest) setInputs([]) },
      )
    }
    read()
    devices.addEventListener('devicechange', read)
    return () => {
      latest = -1
      devices.removeEventListener('devicechange', read)
    }
  }, [enabled])
  return inputs
}

/** A thin download bar in the row; the percent beside it is the readable value. */
function ProgressBar({ value, label }: { value: number; label: string }) {
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      className="h-1 w-20 overflow-hidden rounded-full bg-line"
    >
      <div className="h-full origin-left bg-muted" style={{ transform: `scaleX(${value / 100})` }} />
    </div>
  )
}

/** The right side of one model row: its state and the acts that fit it. */
function ModelActions({ id, status, active, bridge, onUse }: {
  id: DictationModelId
  /** Undefined until the bridge's first push. */
  status: DictationModelStatus | undefined
  active: boolean
  bridge: DesktopDictationBridge
  onUse: () => void
}) {
  if (status === undefined) return <span className="text-label text-dim">Checking…</span>
  const remove = <Button size="compact" variant="ghost" onClick={() => quietly(bridge.remove(id))}>Remove</Button>
  switch (status.state) {
    case 'missing':
      return <Button size="compact" variant="primary" onClick={() => quietly(bridge.download(id))}>Download</Button>
    case 'downloading': {
      const percent = Math.round(status.progress * 100)
      return (
        <>
          <span className="text-label text-muted tabular-nums">{percent}%</span>
          <ProgressBar value={percent} label={`Downloading ${DICTATION_MODELS[id].label}`} />
          <Button size="compact" variant="ghost" onClick={() => quietly(bridge.cancelDownload(id))}>Cancel</Button>
        </>
      )
    }
    case 'ready':
      return (
        <>
          {active
            ? <span className="text-label text-muted">In use</span>
            : <Button size="compact" variant="secondary" onClick={onUse}>Use</Button>}
          {remove}
        </>
      )
    case 'failed':
      return <Button size="compact" variant="secondary" onClick={() => quietly(bridge.download(id))}>Retry</Button>
  }
}

/** Settings → Voice: the dictation models, the language and the microphone. A pick saves at once. */
export function VoicePage({ settings, onSave }: {
  /** Null until the server's connect message lands; nothing is saved over unread settings. */
  settings: HouseSettings | null
  onSave: (settings: HouseSettings) => void
}) {
  const bridge = desktopDictation()
  const models = useDictationModels()
  const microphones = useMicrophones(bridge !== undefined)

  if (bridge === undefined) {
    return (
      <SettingsPage title="Voice">
        <p className="m-0 text-[14px] text-muted">Dictation only works in the Manor desktop app on your Mac.</p>
      </SettingsPage>
    )
  }

  if (settings === null) {
    return (
      <SettingsPage title="Voice" description={DESCRIPTION}>
        <p className="m-0 text-label text-dim">Reading the settings…</p>
      </SettingsPage>
    )
  }

  const save = (next: HouseSettings) => {
    if (next.dictationModel !== settings.dictationModel || next.dictationLanguage !== settings.dictationLanguage || next.dictationMicrophone !== settings.dictationMicrophone) {
      onSave(next)
    }
  }

  const active = DICTATION_MODELS[settings.dictationModel]
  const activeReady = modelStatus(models, settings.dictationModel)?.state === 'ready'
  const languageNote = !active.honoursLanguage && settings.dictationLanguage !== 'auto'
    ? ` ${active.label} finds the language itself, so this choice only applies to ${LANGUAGE_MODELS}.`
    : ''

  const saved = settings.dictationMicrophone
  const microphoneOptions: SelectOption<string>[] = [
    { value: '', label: 'System default' },
    ...(microphones ?? []).map(({ deviceId, label }) => ({ value: deviceId, label })),
    // Before the first read the saved input is not known to be gone, so the trigger shows `Checking…` instead.
    ...(saved !== '' && microphones !== null && !microphones.some((input) => input.deviceId === saved) ? [{ value: saved, label: UNAVAILABLE }] : []),
  ]

  return (
    <SettingsPage title="Voice" description={DESCRIPTION}>
      <SettingsGroup
        title="Dictation model"
        {...(models === null || activeReady ? {} : { note: `Download ${active.label} to start dictating.` })}
      >
        {DICTATION_MODEL_IDS.map((id) => {
          const model = DICTATION_MODELS[id]
          const status = modelStatus(models, id)
          return (
            <SettingsRow
              key={id}
              label={model.label}
              description={
                <>
                  {status === undefined ? model.description : `${model.description} ${formatModelSize(status.bytes)}`}
                  {status?.state === 'failed' && status.error !== undefined ? <span className="block text-danger">{status.error}</span> : null}
                </>
              }
            >
              <ModelActions
                id={id}
                status={status}
                active={id === settings.dictationModel}
                bridge={bridge}
                onUse={() => save({ ...settings, dictationModel: id })}
              />
            </SettingsRow>
          )
        })}
      </SettingsGroup>
      <SettingsGroup
        title="Dictation"
        onRestore={() => save({
          ...settings,
          dictationLanguage: DEFAULT_HOUSE_SETTINGS.dictationLanguage,
          dictationMicrophone: DEFAULT_HOUSE_SETTINGS.dictationMicrophone,
        })}
        restoreDisabled={
          settings.dictationLanguage === DEFAULT_HOUSE_SETTINGS.dictationLanguage
          && settings.dictationMicrophone === DEFAULT_HOUSE_SETTINGS.dictationMicrophone
        }
      >
        <SettingsRow label="Language" description={`The language you speak. Automatic lets the model find it.${languageNote}`}>
          <div className="w-[200px]">
            <Select
              label="Language"
              value={settings.dictationLanguage}
              options={LANGUAGE_OPTIONS}
              onChange={(dictationLanguage) => save({ ...settings, dictationLanguage })}
            />
          </div>
        </SettingsRow>
        <SettingsRow label="Microphone" description="The input Manor records from.">
          <div className="w-[200px]">
            <Select
              label="Microphone"
              value={saved}
              options={microphoneOptions}
              placeholder="Checking…"
              onChange={(dictationMicrophone) => save({ ...settings, dictationMicrophone })}
            />
          </div>
        </SettingsRow>
      </SettingsGroup>
    </SettingsPage>
  )
}
