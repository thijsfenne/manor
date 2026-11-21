import { describe, expect, it } from 'vitest'
import { joinParts, SAMPLE_RATE, speechSpan, splitAtQuiet } from './dictationAudio'

/** `seconds` of a 220 Hz tone at `amplitude`, or of a steady room noise (about -50 dBFS) when the amplitude is 0. */
function sound(seconds: number, amplitude: number): Float32Array {
  const samples = new Float32Array(Math.round(seconds * SAMPLE_RATE))
  let seed = 1
  for (let index = 0; index < samples.length; index += 1) {
    seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0
    samples[index] = amplitude > 0 ? amplitude * Math.sin((2 * Math.PI * 220 * index) / SAMPLE_RATE) : (seed / 4_294_967_296 - 0.5) * 0.02
  }
  return samples
}

function joined(...pieces: Float32Array[]): Float32Array {
  const out = new Float32Array(pieces.reduce((total, piece) => total + piece.length, 0))
  let offset = 0
  for (const piece of pieces) {
    out.set(piece, offset)
    offset += piece.length
  }
  return out
}

/** Byte equality; a deep `toEqual` over a minute of samples takes seconds. */
function sameSamples(a: Float32Array, b: Float32Array): boolean {
  return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength))
}

describe('speechSpan', () => {
  it('finds nothing in silence, digital or a steady noise floor', () => {
    expect(speechSpan(new Float32Array(SAMPLE_RATE * 2))).toBeNull()
    expect(speechSpan(sound(2, 0))).toBeNull()
    expect(speechSpan(new Float32Array(0))).toBeNull()
  })

  it('does not take scattered clicks for speech', () => {
    const samples = sound(3, 0)
    for (const second of [0.5, 1, 1.5, 2, 2.5]) samples.fill(0.5, second * SAMPLE_RATE, second * SAMPLE_RATE + 100)
    expect(speechSpan(samples)).toBeNull()
  })

  it('spans a recording that is loud sound from start to end', () => {
    const samples = sound(3, 0.15)
    expect(speechSpan(samples)).toEqual({ start: 0, end: samples.length })
  })

  it('finds nothing in a steady quiet sound over the whole recording', () => {
    expect(speechSpan(sound(3, 0.005))).toBeNull()
  })

  it('spans a tone between silences, with the margin either side', () => {
    const span = speechSpan(joined(sound(2, 0), sound(1, 0.3), sound(2, 0)))
    expect(span).not.toBeNull()
    expect(span?.start).toBeGreaterThanOrEqual(1.6 * SAMPLE_RATE)
    expect(span?.start).toBeLessThanOrEqual(1.71 * SAMPLE_RATE)
    expect(span?.end).toBeGreaterThanOrEqual(3.29 * SAMPLE_RATE)
    expect(span?.end).toBeLessThanOrEqual(3.4 * SAMPLE_RATE)
  })
})

describe('splitAtQuiet', () => {
  it('returns the input as one part when it fits', () => {
    const samples = sound(10, 0.3)
    const parts = splitAtQuiet(samples, 28, 3)
    expect(parts).toHaveLength(1)
    expect(parts[0]).toBe(samples)
  })

  it('cuts in the silent gap inside the window, and keeps every sample once', () => {
    // 50 s of tone with a 0.4 s gap 0.8 s after the even cut point at 25 s.
    const samples = joined(sound(25.6, 0.3), new Float32Array(0.4 * SAMPLE_RATE), sound(24, 0.3))
    const parts = splitAtQuiet(samples, 28, 3)
    expect(parts).toHaveLength(2)
    const cut = parts[0]?.length ?? 0
    expect(cut).toBeGreaterThanOrEqual(25.6 * SAMPLE_RATE)
    expect(cut).toBeLessThanOrEqual(26 * SAMPLE_RATE)
    expect(sameSamples(joined(...parts), samples)).toBe(true)
  })

  it('never returns a part over the maximum, even when the quiet lies beyond it', () => {
    // Three parts; the only quiet stretches sit where a cut would make a part too long.
    const samples = joined(sound(29.5, 0.3), new Float32Array(SAMPLE_RATE), sound(29.5, 0.3), new Float32Array(SAMPLE_RATE), sound(19, 0.3))
    const parts = splitAtQuiet(samples, 28, 6)
    expect(parts).toHaveLength(3)
    for (const part of parts) expect(part.length).toBeLessThanOrEqual(28 * SAMPLE_RATE)
    expect(sameSamples(joined(...parts), samples)).toBe(true)
  })
})

describe('joinParts', () => {
  it('joins trimmed part texts with one space and drops empty ones', () => {
    expect(joinParts([' Hallo daar.', '', '  En verder. '])).toBe('Hallo daar. En verder.')
  })

  it('drops the period at a cut inside a sentence and keeps other endings', () => {
    expect(joinParts(['Of een huis.', 'die gekoppeld is.'])).toBe('Of een huis die gekoppeld is.')
    expect(joinParts(['Of een huis.', 'Die gekoppeld is.'])).toBe('Of een huis. Die gekoppeld is.')
    expect(joinParts(['Of een huis?', 'die gekoppeld is.'])).toBe('Of een huis? die gekoppeld is.')
    expect(joinParts(['Of een huis...', 'die gekoppeld is.'])).toBe('Of een huis... die gekoppeld is.')
  })
})
