import { Text } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { applyChanges, diffNote, insertedSpans, textLines } from './noteAi'

const NOTE = '---\ntype: note\n---\n\n# Kickoff\n\nWe hebben eigenlijk veel input gekregen.\n\n- een\n- twee\n\nDaarna gaan we schetsen.\n'

describe('diffNote', () => {
  it('finds nothing in a note that came back unchanged', () => {
    expect(diffNote(NOTE, NOTE)).toEqual([])
  })

  it('makes a rewritten line one change and leaves the rest of the note alone', () => {
    const after = NOTE.replace('eigenlijk veel input', 'veel input')
    const from = NOTE.indexOf('We hebben')
    expect(diffNote(NOTE, after)).toEqual([{ from, to: from + 'We hebben eigenlijk veel input gekregen.'.length, insert: 'We hebben veel input gekregen.' }])
  })

  it('leaves a shared list marker out of a rewritten item', () => {
    const from = NOTE.indexOf('een')
    expect(diffNote(NOTE, NOTE.replace('- een', '- eerst'))).toEqual([{ from, to: from + 3, insert: 'eerst' }])
    // A marker that itself changed is part of the change.
    expect(diffNote(NOTE, NOTE.replace('- een', '1. een'))[0]).toMatchObject({ from: from - 2, insert: '1. een' })
  })

  it.each([
    ['two rewritten lines', NOTE.replace('eigenlijk ', '').replace('schetsen', 'tekenen')],
    ['an added paragraph', NOTE.replace('- twee\n', '- twee\n- drie\n')],
    ['a line added at the end', `${NOTE}Tot slot.`],
    ['a dropped line', NOTE.replace('- een\n', '')],
    ['a dropped last line', NOTE.replace('\nDaarna gaan we schetsen.\n', '')],
    ['a paragraph split in two', NOTE.replace('veel input gekregen.', 'veel input.\n\nGekregen van het team.')],
    ['everything replaced', 'Iets heel anders.'],
    ['an emptied note', ''],
  ])('gives back exactly the edited note for %s', (_name, after) => {
    const changes = diffNote(NOTE, after)
    expect(changes.length).toBeGreaterThan(0)
    expect(applyChanges(NOTE, changes)).toBe(after)
  })
})

describe('applying a proposal', () => {
  it('reads every offset against the original text, whatever order the changes come in', () => {
    expect(applyChanges('one two three', [{ from: 8, to: 13, insert: '3' }, { from: 0, to: 3, insert: '1' }])).toBe('1 two 3')
  })

  it('knows where the new text stands afterwards, for the settle tint', () => {
    const changes = [{ from: 0, to: 3, insert: 'first' }, { from: 4, to: 7, insert: '' }, { from: 8, to: 13, insert: '3' }]
    const text = applyChanges('one two three', changes)
    expect(insertedSpans(changes).map((span) => text.slice(span.from, span.to))).toEqual(['first', '3'])
  })
})

it('shimmers the lines that have text and skips the empty ones', () => {
  const doc = Text.of(['# Title', '', '  ', 'Body'])
  expect(textLines(doc)).toEqual([{ from: 0, to: 7 }, { from: 12, to: 16 }])
})
