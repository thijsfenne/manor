import { useEffect, useRef, useState } from 'react'
import type { DesktopDictationBridge, DictationLanguage, DictationModelId, DictationModelStatus, HouseSettings } from '@manor/contracts'
import { useStableCallback } from '../useStableCallback'
import { modelStatus } from './models'
import { microphoneProblem, startRecording, type Recording, type StartRecording } from './recorder'

/** The house settings dictation reads; the composer is handed only these. */
export type DictationSettings = Pick<HouseSettings, 'dictationModel' | 'dictationLanguage' | 'dictationMicrophone'>

/** How many bars the waveform draws, newest at the right. */
export const WAVE_BARS = 20
const QUIET: readonly number[] = Array.from({ length: WAVE_BARS }, () => 0)

/** The waveform's ring: the last `size` levels with `level` appended as the newest. */
export function pushLevel(levels: readonly number[], level: number, size = WAVE_BARS): number[] {
  return [...levels.slice(Math.max(levels.length + 1 - size, 0)), level]
}

/** A recording this long ends itself and is transcribed as if ✓ was pressed. */
export const MAX_RECORDING_MS = 10 * 60_000

export type DictationPhase = 'idle' | 'starting' | 'recording' | 'transcribing'

/** What the popover above the microphone says. `failed` carries its own sentence. */
export type DictationNotice =
  | { kind: 'needs-model' }
  | { kind: 'mic-denied' }
  | { kind: 'no-microphone' }
  | { kind: 'failed'; message: string }
  | { kind: 'no-speech' }

const COULD_NOT_OPEN = 'Manor could not open the microphone.'
const COULD_NOT_TRANSCRIBE = 'Manor could not transcribe this recording. Try again.'

async function microphoneNotice(error: unknown, bridge: DesktopDictationBridge): Promise<DictationNotice> {
  const problem = microphoneProblem(error)
  if (problem === 'missing') return { kind: 'no-microphone' }
  if (problem === 'refused') {
    const access = await bridge.microphoneAccess().catch(() => 'unknown' as const)
    if (access === 'denied') return { kind: 'mic-denied' }
  }
  return { kind: 'failed', message: COULD_NOT_OPEN }
}

/** The text to insert, or the notice that says why there is none; null once `wanted` says it was cancelled. */
async function transcribe(
  recording: Recording,
  request: { model: DictationModelId; language: DictationLanguage },
  bridge: DesktopDictationBridge,
  wanted: () => boolean,
): Promise<string | DictationNotice | null> {
  const failed = { kind: 'failed', message: COULD_NOT_TRANSCRIBE } as const
  let samples: Float32Array
  try {
    samples = await recording.stop()
  } catch {
    return failed
  }
  if (!wanted()) return null
  if (samples.length === 0) return { kind: 'no-speech' }
  const result = await bridge.transcribe({ ...request, samples }).catch(() => null)
  if (result === null) return failed
  if (!result.ok) return { kind: 'failed', message: result.message }
  const text = result.text.trim()
  return text === '' ? { kind: 'no-speech' } : text
}

/**
 * The composer's dictation: idle, starting (the microphone is opening), recording and
 * transcribing, plus the one notice the popover shows. A press on the microphone with
 * the active model not on disk opens the download notice and records nothing. ✓ hands
 * the transcript to `onInsert` and never sends; ✕, Escape and unmounting discard.
 *
 * Every start and every cancel bumps one counter, and each async step checks it, so a
 * recording or transcript that comes back after a cancel is dropped on arrival.
 */
export function useDictation({ bridge, settings, models, onInsert, record = startRecording }: {
  bridge: DesktopDictationBridge
  settings: DictationSettings
  /** Every model's status from `useDictationModels`; null before the first push. */
  models: readonly DictationModelStatus[] | null
  onInsert: (text: string) => void
  record?: StartRecording
}) {
  const [phase, setPhase] = useState<DictationPhase>('idle')
  const [notice, setNotice] = useState<DictationNotice | null>(null)
  const [levels, setLevels] = useState(QUIET)
  const run = useRef(0)
  // True from a press on the microphone until the session ends. Read synchronously,
  // because the microphone button is still pressable while it fades out.
  const busy = useRef(false)
  const recording = useRef<Recording | null>(null)
  // The model and language the recording started with, so a settings change mid-way
  // does not send it to a model that was not warmed.
  const request = useRef<{ model: DictationModelId; language: DictationLanguage }>({ model: settings.dictationModel, language: settings.dictationLanguage })
  const limit = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const insert = useStableCallback(onInsert)

  const confirm = useStableCallback(async () => {
    const current = recording.current
    if (current === null) return
    recording.current = null
    clearTimeout(limit.current)
    const ticket = run.current
    setPhase('transcribing')
    setLevels(QUIET)
    const outcome = await transcribe(current, request.current, bridge, () => run.current === ticket)
    if (outcome === null || run.current !== ticket) return
    busy.current = false
    setPhase('idle')
    if (typeof outcome === 'string') insert(outcome)
    else setNotice(outcome)
  })

  const cancel = useStableCallback(() => {
    run.current += 1
    busy.current = false
    clearTimeout(limit.current)
    recording.current?.cancel()
    recording.current = null
    setPhase('idle')
    setLevels(QUIET)
  })

  const start = async () => {
    if (busy.current) return
    if (modelStatus(models, settings.dictationModel)?.state !== 'ready') {
      // A second press on the microphone closes the notice again, as the plus menu does.
      setNotice((current) => (current?.kind === 'needs-model' ? null : { kind: 'needs-model' }))
      return
    }
    run.current += 1
    busy.current = true
    const ticket = run.current
    const model = settings.dictationModel
    const language = settings.dictationLanguage
    request.current = { model, language }
    setNotice(null)
    setPhase('starting')
    void bridge.warm(model, language).catch(() => {})
    let started: Recording
    try {
      started = await record({
        microphone: settings.dictationMicrophone,
        onLevel: (level) => {
          if (run.current === ticket) setLevels((current) => pushLevel(current, level))
        },
      })
    } catch (error) {
      if (run.current !== ticket) return
      busy.current = false
      setPhase('idle')
      const next = await microphoneNotice(error, bridge)
      if (run.current === ticket) setNotice(next)
      return
    }
    if (run.current !== ticket) {
      started.cancel()
      return
    }
    recording.current = started
    setPhase('recording')
    limit.current = setTimeout(() => void confirm(), MAX_RECORDING_MS)
  }

  // Escape discards while dictation records or transcribes, wherever the focus is.
  // Captured on the window and stopped there, so the editor's own Escape steps and focus
  // mode never see it. Idle, Escape is everyone else's again.
  const active = phase !== 'idle'
  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [active, cancel])

  // Leaving the composer, or the chat it is keyed to, drops the recording and frees the microphone.
  useEffect(() => () => {
    run.current += 1
    busy.current = false
    clearTimeout(limit.current)
    recording.current?.cancel()
    recording.current = null
  }, [])

  return { phase, notice, levels, start, confirm, cancel, dismissNotice: () => setNotice(null) }
}
