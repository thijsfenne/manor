import { DictationModelIdSchema } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { DICTATION_MODEL_IDS, formatModelSize, modelStatus } from '../src/dictation/models'

describe('dictation models', () => {
  it('formats a size in decimal units, one decimal for GB and whole MB', () => {
    expect(formatModelSize(1_036_613_791)).toBe('1.0 GB')
    expect(formatModelSize(670_576_784)).toBe('671 MB')
    expect(formatModelSize(999_400_000)).toBe('999 MB')
    expect(formatModelSize(999_600_000)).toBe('1.0 GB')
    expect(formatModelSize(1_550_000_000)).toBe('1.6 GB')
  })

  it('lists every model id, the default first', () => {
    expect([...DICTATION_MODEL_IDS].sort()).toEqual([...DictationModelIdSchema.options].sort())
    expect(DICTATION_MODEL_IDS[0]).toBe('whisper-turbo')
  })

  it('finds one model status, or nothing before the first push', () => {
    const ready = { id: 'parakeet-tdt-v3', bytes: 670_576_784, state: 'ready', progress: 0 } as const
    expect(modelStatus([ready], 'parakeet-tdt-v3')).toBe(ready)
    expect(modelStatus([ready], 'whisper-turbo')).toBeUndefined()
    expect(modelStatus(null, 'whisper-turbo')).toBeUndefined()
  })
})
