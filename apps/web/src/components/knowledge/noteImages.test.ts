import { ensureSyntaxTree } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { livePreviewExtensions } from './livePreview'
import { addPending, imageLines, landing, moveLine, noteImageConfig, noteImageExtensions } from './noteImages'

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
})
