import { ImageAttachmentSchema, MessageAttachmentsSchema } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { stagedFromWire, stagedImageSlots, wireImages, type DraftImage } from './imageMarks'

const png = (body: string) => `data:image/png;base64,${body}`

describe('wireImages', () => {
  it('keeps each picture in place and appends the originals of marked ones', () => {
    const marks = { pins: [{ x: 0.62, y: 0.18, comment: 'too little contrast' }], shapes: [] }
    const staged: DraftImage[] = [
      { name: 'plain.png', dataUrl: png('AAAA') },
      { name: 'login.png', dataUrl: png('BBBB'), annotation: marks, original: png('CCCC') },
    ]

    const sent = wireImages(staged)

    expect(stagedImageSlots(staged)).toBe(3)
    expect(sent).toEqual([
      { name: 'plain.png', dataUrl: png('AAAA') },
      { name: 'login.png', dataUrl: png('BBBB'), annotation: { ...marks, original: 2 } },
      { name: 'login (original)', dataUrl: png('CCCC') },
    ])
    // Nothing client-only leaks onto the wire, and the server's own rules take it.
    expect(sent.every((image) => !('original' in image))).toBe(true)
    expect(MessageAttachmentsSchema.safeParse({ images: sent }).success).toBe(true)
  })

  it('folds a refused send back into the pictures the tray staged', () => {
    const staged: DraftImage[] = [
      { name: 'login.png', dataUrl: png('BBBB'), annotation: { pins: [{ x: 0.5, y: 0.5, comment: '' }], shapes: [] }, original: png('CCCC') },
      { name: 'plain.png', dataUrl: png('AAAA') },
    ]
    expect(wireImages(stagedFromWire(wireImages(staged)))).toEqual(wireImages(staged))
    expect(stagedFromWire(wireImages(staged)).map((image) => image.name)).toEqual(['login.png', 'plain.png'])
  })

  it('lets a client that predates marks read the picture without them', () => {
    const marked = { name: 'login.png', dataUrl: png('BBBB'), annotation: { original: 1, pins: [], shapes: [] } }
    const older = ImageAttachmentSchema.omit({ annotation: true })
    expect(older.parse(marked)).toEqual({ name: 'login.png', dataUrl: png('BBBB') })
  })
})
