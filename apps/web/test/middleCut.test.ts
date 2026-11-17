import { describe, expect, it } from 'vitest'
import { splitForMiddleCut } from '../src/components/MiddleCut'

describe('a file name cut in the middle', () => {
  it('keeps the end with the extension and joins back to the whole name', () => {
    const name = 'Schermafbeelding-2026-11-17-om-14.32.07-donker.png'
    const [head, tail] = splitForMiddleCut(name)
    expect(tail).toBe('7-donker.png')
    expect(head + tail).toBe(name)
  })

  it('keeps at most half of a short name, and never splits a character', () => {
    expect(splitForMiddleCut('a.md')).toEqual(['a.', 'md'])
    expect(splitForMiddleCut('季度报告审核.md')).toEqual(['季度报告审', '核.md'])
    expect(splitForMiddleCut('meeting\nnotes.pdf').join('')).toBe('meeting notes.pdf')
  })
})
