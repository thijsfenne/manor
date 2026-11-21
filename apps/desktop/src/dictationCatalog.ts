import type { DictationLanguage, DictationModelId } from '@manor/contracts'

/** `role` is how the engine finds the file for each slot of its recognizer config. */
export interface DictationFile {
  name: string
  role: 'encoder' | 'decoder' | 'joiner' | 'tokens'
  bytes: number
  sha256: string
}

export interface DictationModel {
  /** The model repository; files download from `https://huggingface.co/<repo>/resolve/<revision>/<file>`. */
  repo: string
  revision: string
  files: readonly DictationFile[]
  /** `whisper` takes a language; `transducer` finds it itself and ignores the setting. */
  engine: 'whisper' | 'transducer'
  /** The longest part one decode gets; longer audio is split at a quiet moment. */
  maxPartSeconds: number
  /** How far around an even cut point the split looks for the quietest moment. */
  windowSeconds: number
}

/** Typed by the contract's id, so a new model id does not compile until it has an entry here. */
export type DictationCatalog = Record<DictationModelId, DictationModel>

export const DICTATION_CATALOG: DictationCatalog = {
  'whisper-turbo': {
    repo: 'csukuangfj/sherpa-onnx-whisper-turbo',
    revision: '2ca6ff69fc878651b770880507669577ac41c2ff',
    files: [
      { name: 'turbo-encoder.int8.onnx', role: 'encoder', bytes: 674_716_297, sha256: 'b02dcdf54f348741e93fe732b67d933c8dcb6735655f710640143081db38878b' },
      { name: 'turbo-decoder.int8.onnx', role: 'decoder', bytes: 361_080_764, sha256: '20accd02388482eb3a46bd615631adfdc85e1eb2c7db9ea3f02a40ffe6b81547' },
      { name: 'turbo-tokens.txt', role: 'tokens', bytes: 816_730, sha256: 'b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126' },
    ],
    engine: 'whisper',
    maxPartSeconds: 28,
    windowSeconds: 3,
  },
  'parakeet-tdt-v3': {
    repo: 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8',
    revision: 'ed5d745623472f97cfc2e6c2916ee248798fc5a8',
    files: [
      { name: 'encoder.int8.onnx', role: 'encoder', bytes: 652_282_294, sha256: '1afbe69c1ffdabee94755f42e4daf1d93549131a3da11356bda84fcef0f2c479' },
      { name: 'decoder.int8.onnx', role: 'decoder', bytes: 11_845_274, sha256: '0222a86147299d4dee90edf95b6d13827edb42ad8b7c9cf0b2582f030937c0b5' },
      { name: 'joiner.int8.onnx', role: 'joiner', bytes: 6_355_277, sha256: 'cbd02f3696e9944970111fb439d9c3fd365a80374565f13f2b9c7007d253fc98' },
      { name: 'tokens.txt', role: 'tokens', bytes: 93_939, sha256: 'd58544679ea4bc6ac563d1f545eb7d474bd6cfa467f0a6e2c1dc1c7d37e3c35d' },
    ],
    engine: 'transducer',
    maxPartSeconds: 60,
    windowSeconds: 5,
  },
}

/** What Whisper is told per language setting; empty lets it find the language itself. */
export const WHISPER_LANGUAGE: Record<DictationLanguage, string> = { auto: '', nl: 'nl', en: 'en' }

/** The download size Settings shows, and the denominator of download progress. */
export function modelBytes(model: DictationModel): number {
  return model.files.reduce((total, file) => total + file.bytes, 0)
}

export function fileUrl(model: DictationModel, file: DictationFile): string {
  return `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file.name}`
}

/** Main validates renderer input with these, since a value import of the contract is not allowed here. */
export function isDictationModelId(value: unknown): value is DictationModelId {
  return typeof value === 'string' && Object.hasOwn(DICTATION_CATALOG, value)
}

export function isDictationLanguage(value: unknown): value is DictationLanguage {
  return typeof value === 'string' && Object.hasOwn(WHISPER_LANGUAGE, value)
}
