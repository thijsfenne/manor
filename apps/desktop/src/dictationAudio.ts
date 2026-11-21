/**
 * Pure helpers the dictation host runs over a recording before and after the model:
 * mono samples from -1 to 1 at 16 kHz in, parts and text out.
 */
export const SAMPLE_RATE = 16_000
const FRAME = SAMPLE_RATE / 50
const MARGIN = Math.round(SAMPLE_RATE * 0.3)
/** About -60 dBFS: a recording that never rises above this is a muted or absent microphone. */
const DIGITAL_SILENCE = 0.001
/** Speech has to stand this far (about 10 dB) above the quietest tenth of the frames. */
const ABOVE_FLOOR = 3.2
/** About -30 dBFS per 20 ms frame: clearly sound, so speech that fills the whole recording still counts. */
const CLEAR_SOUND = 0.03
/** Speech holds a sound for at least this many frames in a row; a click or a bump does not. */
const MIN_SPEECH_RUN = 4

/** Root mean square of each 20 ms frame; the last frame may be shorter. */
function frameLevels(samples: Float32Array): number[] {
  const levels: number[] = []
  for (let start = 0; start < samples.length; start += FRAME) {
    levels.push(level(samples, start, Math.min(start + FRAME, samples.length)))
  }
  return levels
}

function level(samples: Float32Array, start: number, end: number): number {
  let sum = 0
  for (let index = start; index < end; index += 1) {
    const sample = samples[index] ?? 0
    sum += sample * sample
  }
  return end > start ? Math.sqrt(sum / (end - start)) : 0
}

/**
 * The stretch of the recording that holds speech, from the first to the last speech
 * frame with 300 ms either side, as sample offsets. A frame counts as speech when it
 * stands clearly above the noise floor or is clearly sound on its own. Null when no
 * frame does or everything is near digital silence, so the model never
 * runs on an empty recording (where it would invent a sentence).
 */
export function speechSpan(samples: Float32Array): { start: number; end: number } | null {
  const levels = frameLevels(samples)
  if (levels.every((value) => value < DIGITAL_SILENCE)) return null
  const sorted = [...levels].sort((a, b) => a - b)
  const floor = sorted[Math.floor(sorted.length * 0.1)] ?? 0
  const threshold = Math.max(Math.min(floor * ABOVE_FLOOR, CLEAR_SOUND), DIGITAL_SILENCE)
  const speech = levels.flatMap((value, index) => (value >= threshold ? [index] : []))
  const first = speech[0]
  const last = speech.at(-1)
  if (first === undefined || last === undefined || longestRun(speech) < MIN_SPEECH_RUN) return null
  return {
    start: Math.max(0, first * FRAME - MARGIN),
    end: Math.min(samples.length, (last + 1) * FRAME + MARGIN),
  }
}

/** The longest stretch of consecutive frame indexes in an ascending list. */
function longestRun(indexes: readonly number[]): number {
  let longest = 0
  let run = 0
  indexes.forEach((value, position) => {
    run = position > 0 && indexes[position - 1] === value - 1 ? run + 1 : 1
    longest = Math.max(longest, run)
  })
  return longest
}

/**
 * As few parts as fit `maxSeconds`, of about equal length (no tiny tail), each cut moved
 * to the quietest 20 ms within `windowSeconds` centred on the even cut point. A cut is
 * also kept where the parts on both sides still fit, so no part is ever over the maximum.
 * The parts are views of `samples` that together hold every sample once, in order.
 */
export function splitAtQuiet(samples: Float32Array, maxSeconds: number, windowSeconds: number): Float32Array[] {
  const max = Math.floor(maxSeconds * SAMPLE_RATE)
  const total = samples.length
  if (total <= max) return [samples]
  const count = Math.ceil(total / max)
  const halfWindow = Math.floor((windowSeconds * SAMPLE_RATE) / 2)
  const parts: Float32Array[] = []
  let previous = 0
  for (let index = 1; index < count; index += 1) {
    const even = Math.round((index * total) / count)
    const low = Math.max(even - halfWindow, total - (count - index) * max, previous + 1)
    const high = Math.min(even + halfWindow, previous + max)
    const cut = quietest(samples, low, high)
    parts.push(samples.subarray(previous, cut))
    previous = cut
  }
  parts.push(samples.subarray(previous))
  return parts
}

/** The cut point in `[low, high]` at the centre of the quietest 20 ms, checked every 10 ms. */
function quietest(samples: Float32Array, low: number, high: number): number {
  let best = low
  let bestLevel = Number.POSITIVE_INFINITY
  for (let cut = low; cut <= high; cut += FRAME / 2) {
    const value = level(samples, Math.max(0, cut - FRAME / 2), Math.min(samples.length, cut + FRAME / 2))
    if (value < bestLevel) {
      best = cut
      bestLevel = value
    }
  }
  return best
}

/**
 * The text of each decoded part, in order, as one line. The model ends every part with
 * a period, so where the next part starts in lowercase (a cut inside a sentence) the
 * single trailing period before it goes.
 */
export function joinParts(texts: readonly string[]): string {
  const parts = texts.map((text) => text.trim()).filter((text) => text.length > 0)
  return parts
    .map((text, index) => {
      const next = parts[index + 1]
      return next !== undefined && /^\p{Ll}/u.test(next) && /[^.]\.$/u.test(text) ? text.slice(0, -1) : text
    })
    .join(' ')
}
