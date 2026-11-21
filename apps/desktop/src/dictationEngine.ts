import path from 'node:path'
import type { DictationLanguage } from '@manor/contracts'
import { joinParts, SAMPLE_RATE, speechSpan, splitAtQuiet } from './dictationAudio'
import { WHISPER_LANGUAGE, type DictationFile, type DictationModel } from './dictationCatalog'

/** The slice of `sherpa-onnx-node` dictation uses; the package ships no types. */
interface SherpaStream {
  acceptWaveform(wave: { samples: Float32Array; sampleRate: number }): void
}
interface SherpaRecognizer {
  createStream(): SherpaStream
  decode(stream: SherpaStream): void
  getResult(stream: SherpaStream): { text: string }
}
interface Sherpa {
  OfflineRecognizer: new (config: object) => SherpaRecognizer
}

/**
 * Runs inside the dictation utility process (`dictationHost.ts`) and in the engine
 * smoke under plain Node; no Electron here. One recognizer per process: a dropped one
 * gives back its 1 to 2.5 GB only when the process exits, so the service restarts the
 * host rather than asking for a second model here.
 */
let loaded: { key: string; recognizer: SherpaRecognizer } | null = null

export function recognizerConfig(folder: string, model: DictationModel, language: DictationLanguage): object {
  const file = (role: DictationFile['role']) => {
    const entry = model.files.find((candidate) => candidate.role === role)
    if (entry === undefined) throw new Error(`The model has no ${role} file.`)
    return path.join(folder, entry.name)
  }
  const common = { tokens: file('tokens'), numThreads: 4, provider: 'cpu', debug: 0 }
  const featConfig = { sampleRate: SAMPLE_RATE, featureDim: 80 }
  if (model.engine === 'whisper') {
    // The model is trained on 30 second windows: padding the features to the full window
    // (the engine clamps 3000 to it) keeps a recording that ends mid-word from looping or losing text.
    return {
      featConfig,
      modelConfig: {
        whisper: { encoder: file('encoder'), decoder: file('decoder'), language: WHISPER_LANGUAGE[language], task: 'transcribe', tailPaddings: 3000 },
        ...common,
      },
    }
  }
  return {
    featConfig,
    modelConfig: {
      transducer: { encoder: file('encoder'), decoder: file('decoder'), joiner: file('joiner') },
      modelType: 'nemo_transducer',
      ...common,
    },
  }
}

/** Loads the model if this process has not yet; the host's `warm` is exactly this. */
export function loadRecognizer(folder: string, model: DictationModel, language: DictationLanguage): SherpaRecognizer {
  const key = `${folder}\n${model.engine === 'whisper' ? language : ''}`
  if (loaded?.key === key) return loaded.recognizer
  // Required here rather than imported, so loading this module costs nothing until a model is used.
  const sherpa = require('sherpa-onnx-node') as Sherpa
  loaded = { key, recognizer: new sherpa.OfflineRecognizer(recognizerConfig(folder, model, language)) }
  return loaded.recognizer
}

/** Speech only, split into parts the model takes, each decoded as it is, joined. */
export function transcribeSamples(folder: string, model: DictationModel, language: DictationLanguage, samples: Float32Array): string {
  const span = speechSpan(samples)
  if (span === null) return ''
  const recognizer = loadRecognizer(folder, model, language)
  const texts = splitAtQuiet(samples.subarray(span.start, span.end), model.maxPartSeconds, model.windowSeconds).map((part) => {
    const stream = recognizer.createStream()
    stream.acceptWaveform({ samples: part, sampleRate: SAMPLE_RATE })
    recognizer.decode(stream)
    return recognizer.getResult(stream).text
  })
  return joinParts(texts)
}
