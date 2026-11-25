import { ImageAttachmentSchema, MessageAttachmentsSchema } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { NO_MARKS, hasMarks, marksOf, stagedFromWire, wireImages, type DraftImage } from './imageMarks'

const png = (body: string) => `data:image/png;base64,${body}`

describe('wireImages', () => {
  it('keeps each picture in place and appends the originals of marked ones', () => {
    const marks = { pins: [{ x: 0.62, y: 0.18, comment: 'too little contrast' }], shapes: [] }
    const staged: DraftImage[] = [
      { name: 'plain.png', dataUrl: png('AAAA') },
      { name: 'login.png', dataUrl: png('BBBB'), annotation: marks, original: png('CCCC') },
    ]

    const sent = wireImages(staged)

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

  it('sends eight marked pictures, each with its original after them all', () => {
    const marks = { pins: [], shapes: [], strokes: [[[0.1, 0.2], [0.3, 0.4]] as [number, number][]] }
    const staged: DraftImage[] = Array.from({ length: 8 }, (_, index) => ({ name: `shot-${index}.png`, dataUrl: png('BBBB'), annotation: marks, original: png('CCCC') }))

    const sent = wireImages(staged)

    expect(sent).toHaveLength(16)
    expect(sent.slice(0, 8).map((image) => image.annotation?.original)).toEqual([8, 9, 10, 11, 12, 13, 14, 15])
    expect(MessageAttachmentsSchema.safeParse({ images: sent }).success).toBe(true)
    expect(wireImages(stagedFromWire(sent))).toEqual(sent)
  })

  it('reopens freehand lines intact and counts a picture with only lines as marked', () => {
    const strokes: [number, number][][] = [[[0.1, 0.2], [0.15, 0.25], [0.2, 0.3]], [[0.5, 0.5]]]
    const annotation = { pins: [], shapes: [], strokes }
    expect(marksOf(annotation)).toEqual({ pins: [], shapes: [], strokes })
    expect(hasMarks(marksOf(annotation))).toBe(true)
    // A stored annotation from before the pen reads as no lines.
    expect(marksOf({ pins: [], shapes: [] })).toEqual(NO_MARKS)
    expect(hasMarks(NO_MARKS)).toBe(false)
  })

  it('lets a client that predates marks read the picture without them', () => {
    const marked = { name: 'login.png', dataUrl: png('BBBB'), annotation: { original: 1, pins: [], shapes: [] } }
    const older = ImageAttachmentSchema.omit({ annotation: true })
    expect(older.parse(marked)).toEqual({ name: 'login.png', dataUrl: png('BBBB') })
  })
})
