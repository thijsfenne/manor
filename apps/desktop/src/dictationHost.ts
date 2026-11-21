import { DICTATION_CATALOG, isDictationLanguage, isDictationModelId } from './dictationCatalog'
import { loadRecognizer, transcribeSamples } from './dictationEngine'
import type { HostReply, HostRequest } from './dictationService'

/**
 * Entry of the `Manor dictation` utility process that `DictationService` forks. It
 * answers one message at a time over `process.parentPort`: `warm` loads the model,
 * `transcribe` turns samples into text. The decode blocks this process, never main.
 */
function parseRequest(message: unknown): HostRequest | null {
  if (typeof message !== 'object' || message === null) return null
  const { id, type, model, folder, language, samples } = message as Record<string, unknown>
  if (typeof id !== 'number' || !isDictationModelId(model) || typeof folder !== 'string' || !isDictationLanguage(language)) return null
  if (type === 'warm') return { id, type, model, folder, language }
  if (type === 'transcribe' && samples instanceof Float32Array) return { id, type, model, folder, language, samples }
  return null
}

function answer(request: HostRequest): HostReply {
  const model = DICTATION_CATALOG[request.model]
  try {
    if (request.type === 'warm') {
      loadRecognizer(request.folder, model, request.language)
      return { id: request.id, text: '' }
    }
    return { id: request.id, text: transcribeSamples(request.folder, model, request.language, request.samples) }
  } catch (error: unknown) {
    return { id: request.id, error: error instanceof Error ? error.message : String(error) }
  }
}

process.parentPort.on('message', (event) => {
  const request = parseRequest(event.data)
  if (request === null) {
    const id = (event.data as { id?: unknown } | null)?.id
    if (typeof id === 'number') process.parentPort.postMessage({ id, error: 'Not a dictation request.' })
    return
  }
  process.parentPort.postMessage(answer(request))
})
