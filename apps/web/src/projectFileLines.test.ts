import { describe, expect, it } from 'vitest'
import { fileLines, lineKeys } from './projectFileLines'

const PREFERENCES = '# Preferences for Manor\n\n- One rule.\n- Two rule\n  wrapped under it.\n- Three rule.'

describe('fileLines', () => {
  it('splits a heading and each list item, keeping indented text with its item', () => {
    expect(fileLines(PREFERENCES)!.map(({ text, item }) => ({ text, item }))).toEqual([
      { text: '# Preferences for Manor', item: false },
      { text: '- One rule.', item: true },
      { text: '- Two rule\n  wrapped under it.', item: true },
      { text: '- Three rule.', item: true },
    ])
  })

  it('keeps the keys of the other lines when one is added or removed', () => {
    const before = fileLines(PREFERENCES)!.map((line) => line.key)
    const added = fileLines(PREFERENCES.replace('- Two rule', '- New rule.\n- Two rule'))!.map((line) => line.key)
    expect(added.filter((key) => !before.includes(key))).toEqual(['0:- New rule.'])
    const removed = fileLines(PREFERENCES.replace('- One rule.\n', ''))!.map((line) => line.key)
    expect(before.filter((key) => !removed.includes(key))).toEqual(['0:- One rule.'])
  })

  it('leaves a file whole when cutting it into lines would draw it differently', () => {
    expect(fileLines('Intro\n\n```\na\n```')).toBeUndefined()
    expect(fileLines('1. One\n1. Two')).toBeUndefined()
    expect(fileLines('- Item\n\n  More under it')).toBeUndefined()
    expect(fileLines('See [the card][card].\n\n[card]: card.md')).toBeUndefined()
  })
})

describe('lineKeys', () => {
  it('counts a repeated text apart', () => {
    expect(lineKeys(['a', 'b', 'a'])).toEqual(['0:a', '0:b', '1:a'])
  })
})
