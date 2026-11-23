import { describe, expect, it } from 'vitest'
import { markLetters, projectLetters } from './projectLetters'

describe('projectLetters', () => {
  it('takes the first letter of two words, or two letters of one word', () => {
    expect(projectLetters('Shot Journal')).toBe('SJ')
    expect(projectLetters('Manor')).toBe('MA')
    expect(projectLetters('client work for the bank')).toBe('CW')
    expect(projectLetters('  shot-journal ')).toBe('SJ')
    expect(projectLetters('X')).toBe('X')
    expect(projectLetters('élan vital')).toBe('ÉV')
    expect(projectLetters('2026 taxes')).toBe('2T')
    expect(projectLetters('e\u0301clair')).toBe('ÉC')
    expect(projectLetters('ßa')).toBe('ßA')
    expect(projectLetters('\uFB03 works')).toBe('FW')
  })

  it('is empty without a letter or digit, so the glyph stands in', () => {
    expect(projectLetters('')).toBe('')
    expect(projectLetters('— · —')).toBe('')
    expect(markLetters({ name: '—', letters: true })).toBeUndefined()
    expect(markLetters({ name: 'Manor' })).toBeUndefined()
    expect(markLetters({ name: 'Manor', letters: true })).toBe('MA')
  })
})
