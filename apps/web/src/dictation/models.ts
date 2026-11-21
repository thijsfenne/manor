import { useSyncExternalStore } from 'react'
import type { DictationModelId, DictationModelStatus } from '@manor/contracts'
import { desktopDictation } from '../desktopBrowser'

/**
 * What Settings and the composer show for each dictation model. `honoursLanguage` is false
 * for a model that finds the language itself, so a fixed language choice does not reach it.
 */
export const DICTATION_MODELS = {
  'whisper-turbo': {
    label: 'Whisper Turbo',
    description: 'Most accurate, also for Dutch. Takes a few seconds per recording.',
    honoursLanguage: true,
  },
  'parakeet-tdt-v3': {
    label: 'Parakeet TDT 0.6B v3',
    description: 'Near instant. Strong in English, weaker in Dutch. Finds the language itself.',
    honoursLanguage: false,
  },
} satisfies Record<DictationModelId, { label: string; description: string; honoursLanguage: boolean }>

/** Every model in the order the lists show them, the default first. */
export const DICTATION_MODEL_IDS: readonly DictationModelId[] = ['whisper-turbo', 'parakeet-tdt-v3']

/** A model size in decimal units: `1.0 GB` from a thousand megabytes up, whole `MB` below. */
export function formatModelSize(bytes: number): string {
  const megabytes = Math.round(bytes / 1e6)
  return megabytes >= 1000 ? `${(bytes / 1e9).toFixed(1)} GB` : `${megabytes} MB`
}

export function modelStatus(models: readonly DictationModelStatus[] | null, id: DictationModelId): DictationModelStatus | undefined {
  return models?.find((model) => model.id === id)
}

// One subscription to the bridge for every component that shows models. The last push is
// kept after the last listener leaves, and the bridge pushes again the moment one returns.
let models: DictationModelStatus[] | null = null
let unsubscribeBridge: (() => void) | undefined
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  if (listeners.size === 1) {
    unsubscribeBridge = desktopDictation()?.onModels((next) => {
      models = next
      for (const notify of listeners) notify()
    })
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      unsubscribeBridge?.()
      unsubscribeBridge = undefined
    }
  }
}

const getSnapshot = () => models
const getServerSnapshot = () => null

/** Every model's status, live. Null without the desktop bridge or before its first push. */
export function useDictationModels(): DictationModelStatus[] | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
}
