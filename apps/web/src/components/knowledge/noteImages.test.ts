import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { livePreviewExtensions } from './livePreview'
import { addPending, dropSpot, imageLines, landing, moveLine, noteImageConfig, noteImageExtensions } from './noteImages'

const images = { '+/shot.png': '/media/vault/sig/%2B/shot.png', 'inbox/local.png': '/media/vault/sig/inbox/local.png' }

function note(doc: string) {
  const state = EditorState.create({
    doc,
    extensions: [
      livePreviewExtensions(),
      noteImageExtensions(),
      noteImageConfig.of({ notePath: 'inbox/note.md', images, attachmentFolder: '+', save: null }),
    ],
  })
  ensureSyntaxTree(state, state.doc.length, 5000)
  return state.update({}).state
}

describe('note pictures', () => {
  it('draws a line that is one resolved embed as a picture, and leaves the rest as text', () => {
    const state = note('Intro\n![[shot.png|400]]\n  ![alt](local.png)\nText ![[shot.png]] inline\n![[missing.png]]\n```\n![[shot.png]]\n```')
    expect(imageLines(state).map((line) => ({ src: line.src, width: line.embed.width, text: state.sliceDoc(line.embed.from, line.embed.to) }))).toEqual([
      { src: images['+/shot.png'], width: 400, text: '![[shot.png|400]]' },
      { src: images['inbox/local.png'], width: undefined, text: '![alt](local.png)' },
    ])
  })

  it('moves an image line before another line, or to the end', () => {
    const state = note('one\n![[shot.png]]\ntwo\nthree')
    const line = imageLines(state)[0]!
    const before = moveLine(state, line, 0)!
    expect(state.update(before).state.doc.toString()).toBe('![[shot.png]]\none\ntwo\nthree')
    const end = moveLine(state, line, state.doc.length)!
    expect(state.update(end).state.doc.toString()).toBe('one\ntwo\nthree\n![[shot.png]]')
    expect(moveLine(state, line, line.from)).toBeNull()
  })

  it('replaces a pasted-over selection when the picture lands, and keeps text written inside it meanwhile', () => {
    const saved = { status: 'saved', name: 'shot.png' } as const
    const start = note('Keep this line\nReplace me\n')
    const held = start.update({ effects: addPending.of({ id: 'a', from: 15, to: 25 }) }).state
    expect(held.update(landing(held, 'a', saved)!).state.doc.toString()).toBe('Keep this line\n![[shot.png]]\n\n')

    const typed = held.update({ changes: { from: 22, insert: 'X' } }).state
    expect(typed.update(landing(typed, 'a', saved)!).state.doc.toString()).toBe('Keep this line\nReplaceX me\n![[shot.png]]\n\n')
    const before = held.update({ changes: { from: 14, insert: '!' } }).state
    expect(before.update(landing(before, 'a', saved)!).state.doc.toString()).toBe('Keep this line!\n![[shot.png]]\n\n')
    expect(landing(typed, 'missing', saved)).toBeNull()
  })
  it('lands a dropped picture between lines, never inside a line, table, code block or the properties', () => {
    const dropped = (doc: string, over: string) => {
      const state = note(doc)
      const at = dropSpot(state, doc.indexOf(over))
      const held = state.update({ effects: addPending.of({ id: 'a', from: at, to: at }) }).state
      return held.update(landing(held, 'a', { status: 'saved', name: 'shot.png' })!).state.doc.toString()
    }
    expect(dropped('# Short\n\nOne line.\n', 'Short')).toBe('# Short\n![[shot.png]]\n\nOne line.\n')
    expect(dropped('# Short\n\nOne line.', 'line.')).toBe('# Short\n\nOne line.\n![[shot.png]]\n')
    expect(dropped('---\ntags: [trip]\n---\nBody', 'tags')).toBe('---\ntags: [trip]\n---\n![[shot.png]]\nBody')
    expect(dropped('Intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter', '| a')).toBe('Intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n![[shot.png]]\n\nAfter')
    const underTable = dropped('| a | b |\n| - | - |\n| 1 | 2 |', '| 1')
    expect(underTable).toBe('| a | b |\n| - | - |\n| 1 | 2 |\n\n![[shot.png]]\n')
    // Without the blank line the parser reads the embed as one more row.
    const tableEnd = (doc: string) => {
      let end = -1
      syntaxTree(note(doc)).iterate({ enter: (node) => { if (node.name === 'Table') end = node.to } })
      return end
    }
    expect(tableEnd('| a | b |\n| - | - |\n| 1 | 2 |\n![[shot.png]]\n')).toBeGreaterThan(underTable.indexOf('![['))
    expect(tableEnd(underTable)).toBeLessThan(underTable.indexOf('![['))
    // Inside a middle row no blank line is added, so the later rows stay in the table.
    const rows = '| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |'
    const at = rows.indexOf(' | 2')
    const held = note(rows).update({ effects: addPending.of({ id: 'a', from: at, to: at }) }).state
    expect(held.update(landing(held, 'a', { status: 'saved', name: 'shot.png' })!).state.doc.toString()).toBe('| a | b |\n| - | - |\n| 1\n![[shot.png]]\n | 2 |\n| 3 | 4 |')
    expect(dropped('Title\n=====\nNext', 'Title')).toBe('Title\n=====\n![[shot.png]]\nNext')
    expect(dropped('Intro\n\n    code one\n    code two\nAfter', '    code one')).toBe('Intro\n\n    code one\n    code two\n![[shot.png]]\nAfter')
    expect(dropped('```\ncode\n```\nAfter', 'code')).toBe('```\ncode\n```\n![[shot.png]]\nAfter')
  })
})
