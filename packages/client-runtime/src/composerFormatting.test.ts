import { describe, expect, it } from 'vitest'
import { caretAfterEdit, composerCaret, continueComposerList, editComposerText, normalizeComposerLists, startComposerList } from './composerFormatting'

describe('composer list shortcuts', () => {
  it('turns a hyphen and space at the start of a line into a visible bullet', () => {
    expect(startComposerList('Intro\n- ', 8)).toEqual({
      text: 'Intro\n• ',
      selectionStart: 8,
      selectionEnd: 8,
    })
    expect(startComposerList('not - ', 6)).toBeNull()
  })

  it('continues bullets', () => {
    expect(continueComposerList('• first', 7)).toEqual({
      text: '• first\n• ',
      selectionStart: 10,
      selectionEnd: 10,
    })
  })

  it('treats numbered prefixes as ordinary text', () => {
    expect(startComposerList('1. ', 3)).toBeNull()
    expect(continueComposerList('8. eighth', 9)).toBeNull()
    expect(continueComposerList('1. ', 3)).toBeNull()
  })

  it('leaves the list when Enter is pressed on an empty item', () => {
    expect(continueComposerList('• first\n• ', 10)).toEqual({
      text: '• first\n',
      selectionStart: 8,
      selectionEnd: 8,
    })
  })

  it('sends visible bullets as Markdown', () => {
    expect(normalizeComposerLists('• one\n  • two\n1. three')).toBe('- one\n  - two\n1. three')
  })
})

describe('the native composer edit path', () => {
  it('reads the caret back off an insertion in the middle of a draft', () => {
    expect(caretAfterEdit('review dit', 'review het dit')).toBe(11)
  })

  it('reads the caret back off a backspace', () => {
    expect(caretAfterEdit('bullet', 'bulet')).toBe(3)
  })

  it('continues a bullet when Enter lands inside an item', () => {
    const edited = editComposerText('• eerste', '• eerste\n')
    expect(edited.text).toBe('• eerste\n• ')
    expect(edited.selectionStart).toBe(11)
  })

  it('inserts an ordinary newline after numbered text', () => {
    expect(editComposerText('1. eerste', '1. eerste\n').text).toBe('1. eerste\n')
  })

  it('leaves the list when Enter lands on an empty item', () => {
    const edited = editComposerText('• eerste\n• ', '• eerste\n• \n')
    expect(edited.text).toBe('• eerste\n')
    expect(edited.selectionStart).toBe(9)
  })

  it('opens a bullet from a typed hyphen and space', () => {
    expect(editComposerText('- ', '- ').text).toBe('• ')
  })

  it('leaves an ordinary keystroke and a paste alone', () => {
    expect(editComposerText('hoi', 'hoi!')).toEqual({ text: 'hoi!', selectionStart: 4, selectionEnd: 4 })
    expect(editComposerText('', 'een\ntwee').text).toBe('een\ntwee')
  })

  it('does not continue a list from prose that merely wrapped', () => {
    expect(editComposerText('gewone regel', 'gewone regel\n').text).toBe('gewone regel\n')
  })
})

describe('the caret an edit landed on', () => {
  it('trusts the input over the diff where a typed character neighbours its twin', () => {
    // The diff cannot tell these apart: the newline typed at the end of the bullet
    // and one typed after the newline already there produce the same string.
    expect(caretAfterEdit('\u2022 item\nnext', '\u2022 item\n\nnext')).toBe(8)
    expect(composerCaret('\u2022 item\nnext', '\u2022 item\n\nnext', 6)).toBe(7)
    expect(composerCaret('\u2022 item\nnext', '\u2022 item\n\nnext', 7)).toBe(8)
  })

  it('cannot tell a one-longer selection replacement from a typed character', () => {
    // Selecting the newline in `\u2022 item\nnext` and pasting two leaves both ends of
    // the string intact, so the strings alone read as one newline typed at 6. The
    // caller withholds `before` whenever the selection was not collapsed, which is
    // the only thing that separates the two cases.
    const previous = '\u2022 item\nnext'
    const next = '\u2022 item\n\nnext'
    expect(composerCaret(previous, next, 6)).toBe(7)
    expect(editComposerText(previous, next, undefined).text).toBe(next)
  })

  it('falls back to the diff for anything but a single character typed at that caret', () => {
    // A stale caret the strings do not bear out, a backspace, and a paste.
    expect(composerCaret('hoi', 'hoi!', 99)).toBe(4)
    expect(composerCaret('bullet', 'bulet', 3)).toBe(3)
    expect(composerCaret('', 'een\ntwee', 0)).toBe(8)
  })

  it('continues the bullet when Enter lands at the end of an item mid-draft', () => {
    const edited = editComposerText('\u2022 item\nnext', '\u2022 item\n\nnext', 6)
    expect(edited.text).toBe('\u2022 item\n\u2022 \nnext')
    expect(edited.selectionStart).toBe(9)
  })

  it('leaves the line alone when Enter lands after the newline instead', () => {
    expect(editComposerText('\u2022 item\nnext', '\u2022 item\n\nnext', 7).text).toBe('\u2022 item\n\nnext')
  })

  it('still reads the caret off the strings when the input reports nothing', () => {
    expect(editComposerText('\u2022 eerste', '\u2022 eerste\n').text).toBe('\u2022 eerste\n\u2022 ')
  })
})
