/** The rate the speech models read, and so the rate a finished recording is decoded at. */
const SAMPLE_RATE = 16_000
/** How often the level is reported: about 15 times a second, enough for a calm waveform. */
const LEVEL_INTERVAL_MS = 66
/** The quiet end of the level scale in dBFS: room noise sits under it, speech well above. */
const LEVEL_FLOOR_DB = -55
const LEVEL_RANGE_DB = 45

/** One recording in progress. Exactly one of `stop` and `cancel` ends it. */
export interface Recording {
  /** Ends the recording and resolves with its audio: mono, 16 kHz, -1 to 1. Empty when nothing was captured. */
  stop(): Promise<Float32Array>
  /** Ends the recording and drops what it holds. */
  cancel(): void
}

export interface RecordingOptions {
  /** The saved input's `deviceId`; empty records from the system default. */
  microphone: string
  /** The microphone level, 0 to 1, about 15 times a second while recording. */
  onLevel: (level: number) => void
}

/** How `useDictation` starts a recording; tests hand it a fake. */
export type StartRecording = (options: RecordingOptions) => Promise<Recording>

/** Why the microphone did not open: refused by the user or macOS, no input at all, or anything else. */
export type MicrophoneProblem = 'refused' | 'missing' | 'failed'

const errorName = (error: unknown) =>
  typeof error === 'object' && error !== null && 'name' in error && typeof error.name === 'string' ? error.name : ''

/** Sorts a `getUserMedia` rejection into the notice the composer shows for it. */
export function microphoneProblem(error: unknown): MicrophoneProblem {
  const name = errorName(error)
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'refused'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'missing'
  return 'failed'
}

/** The saved input, or the default one when that device is gone. */
async function openMicrophone(microphone: string): Promise<MediaStream> {
  const devices = navigator.mediaDevices
  if (microphone !== '') {
    try {
      return await devices.getUserMedia({ audio: { deviceId: { exact: microphone } } })
    } catch (error) {
      if (microphoneProblem(error) !== 'missing') throw error
    }
  }
  return devices.getUserMedia({ audio: true })
}

/** Root mean square of one analyser frame, mapped from decibels onto 0 to 1. */
function levelOf(frame: Float32Array): number {
  let sum = 0
  for (const sample of frame) sum += sample * sample
  const rms = Math.sqrt(sum / Math.max(frame.length, 1))
  if (rms <= 0) return 0
  const db = 20 * Math.log10(rms)
  return Math.min(Math.max((db - LEVEL_FLOOR_DB) / LEVEL_RANGE_DB, 0), 1)
}

/** Every channel of a decoded buffer averaged into one. */
function mono(buffer: AudioBuffer): Float32Array {
  if (buffer.numberOfChannels === 1) return buffer.getChannelData(0).slice()
  const mixed = new Float32Array(buffer.length)
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel)
    for (let index = 0; index < data.length; index += 1) mixed[index]! += data[index]! / buffer.numberOfChannels
  }
  return mixed
}

async function decode(blob: Blob): Promise<Float32Array> {
  if (blob.size === 0) return new Float32Array(0)
  const context = new AudioContext({ sampleRate: SAMPLE_RATE })
  try {
    return mono(await context.decodeAudioData(await blob.arrayBuffer()))
  } finally {
    void context.close().catch(() => {})
  }
}

/**
 * Opens the microphone and records until `stop` or `cancel`. The level comes from an
 * analyser on the live stream; the audio itself goes through a `MediaRecorder` and is
 * decoded to 16 kHz mono only at the end. Either way out stops the tracks and closes
 * the level's audio context, so the macOS microphone indicator goes out at once.
 */
export const startRecording: StartRecording = async ({ microphone, onLevel }) => {
  const stream = await openMicrophone(microphone)
  let meter: AudioContext | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let released = false
  const release = () => {
    if (released) return
    released = true
    clearInterval(timer)
    for (const track of stream.getTracks()) track.stop()
    void meter?.close().catch(() => {})
  }

  try {
    meter = new AudioContext()
    const analyser = meter.createAnalyser()
    analyser.fftSize = 1024
    meter.createMediaStreamSource(stream).connect(analyser)
    const frame = new Float32Array(analyser.fftSize)
    timer = setInterval(() => {
      analyser.getFloatTimeDomainData(frame)
      onLevel(levelOf(frame))
    }, LEVEL_INTERVAL_MS)

    const recorder = new MediaRecorder(stream)
    const chunks: Blob[] = []
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    })
    // Listened for from the start: an input unplugged mid-way stops the recorder on its
    // own, and what it captured until then is still what ✓ transcribes.
    const stopped = new Promise<void>((resolve) => {
      recorder.addEventListener('stop', () => {
        release()
        resolve()
      }, { once: true })
    })
    recorder.start()

    return {
      stop: async () => {
        if (recorder.state !== 'inactive') recorder.stop()
        await stopped
        return decode(new Blob(chunks, { type: recorder.mimeType }))
      },
      cancel: () => {
        chunks.length = 0
        if (recorder.state !== 'inactive') recorder.stop()
        release()
      },
    }
  } catch (error) {
    release()
    throw error
  }
}
