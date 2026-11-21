import type { DictationModelStatus, DictationResult, MicrophoneAccess } from '@manor/contracts'
import { ipcMain, shell, systemPreferences, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { SAMPLE_RATE } from './dictationAudio'
import { isDictationLanguage, isDictationModelId } from './dictationCatalog'
import {
  DICTATION_CANCEL_CHANNEL, DICTATION_DOWNLOAD_CHANNEL, DICTATION_MICROPHONE_CHANNEL, DICTATION_MICROPHONE_SETTINGS_CHANNEL,
  DICTATION_MODELS_CHANNEL, DICTATION_REMOVE_CHANNEL, DICTATION_TRANSCRIBE_CHANNEL, DICTATION_WARM_CHANNEL,
} from './dictationChannels'
import type { DictationModelStore } from './dictationModels'
import { TRANSCRIPTION_FAILED, type DictationService } from './dictationService'

/** The composer stops a recording at 10 minutes; the extra half minute is slack, not an allowance. */
export const MAX_SAMPLES = 10.5 * 60 * SAMPLE_RATE
export const MICROPHONE_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone'

/** What macOS says about Manor and the microphone. Reading the status never prompts. */
export function microphoneAccess(platform: NodeJS.Platform, status: () => string): MicrophoneAccess {
  if (platform !== 'darwin') return 'unknown'
  const value = status()
  if (value === 'granted') return 'granted'
  return value === 'denied' || value === 'restricted' ? 'denied' : 'unknown'
}

/** The store's `onChange` in main: every status change reaches the window's `onModels`. */
export function pushDictationModels(window: BrowserWindow | null, models: DictationModelStatus[]): void {
  if (window !== null && !window.isDestroyed()) window.webContents.send(DICTATION_MODELS_CHANNEL, models)
}

export function registerDictationIpc(options: {
  owner: () => BrowserWindow | null
  store: DictationModelStore
  service: DictationService
}): void {
  const { store, service } = options
  const fromManor = (event: IpcMainInvokeEvent) => {
    const window = options.owner()
    if (window === null || window.isDestroyed() || event.sender.id !== window.webContents.id) {
      throw new Error('Dictation IPC came from outside the Manor window.')
    }
  }
  const modelId = (value: unknown) => {
    if (!isDictationModelId(value)) throw new Error('Unknown dictation model.')
    return value
  }
  ipcMain.handle(DICTATION_MODELS_CHANNEL, (event) => {
    fromManor(event)
    return store.statuses()
  })
  ipcMain.handle(DICTATION_DOWNLOAD_CHANNEL, async (event, id: unknown) => {
    fromManor(event)
    await store.download(modelId(id))
  })
  ipcMain.handle(DICTATION_CANCEL_CHANNEL, async (event, id: unknown) => {
    fromManor(event)
    await store.cancelDownload(modelId(id))
  })
  ipcMain.handle(DICTATION_REMOVE_CHANNEL, async (event, id: unknown) => {
    fromManor(event)
    const model = modelId(id)
    service.stopFor(model)
    await store.remove(model)
  })
  ipcMain.handle(DICTATION_WARM_CHANNEL, async (event, model: unknown, language: unknown) => {
    fromManor(event)
    if (isDictationModelId(model) && isDictationLanguage(language)) await service.warm(model, language)
  })
  ipcMain.handle(DICTATION_TRANSCRIBE_CHANNEL, async (event, request: unknown): Promise<DictationResult> => {
    fromManor(event)
    const { model, language, samples } = typeof request === 'object' && request !== null ? request as Record<string, unknown> : {}
    if (!isDictationModelId(model) || !isDictationLanguage(language) || !(samples instanceof Float32Array) || samples.length > MAX_SAMPLES) {
      return { ok: false, reason: 'failed', message: TRANSCRIPTION_FAILED }
    }
    return service.transcribe({ model, language, samples })
  })
  ipcMain.handle(DICTATION_MICROPHONE_CHANNEL, (event) => {
    fromManor(event)
    return microphoneAccess(process.platform, () => systemPreferences.getMediaAccessStatus('microphone'))
  })
  ipcMain.handle(DICTATION_MICROPHONE_SETTINGS_CHANNEL, async (event) => {
    fromManor(event)
    await shell.openExternal(MICROPHONE_SETTINGS)
  })
}
