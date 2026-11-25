import {
  ClientMessageSchema,
  FileAttachmentSchema,
  ImageAnnotationSchema,
  MAX_MESSAGE_ATTACHMENTS,
  MAX_MESSAGE_IMAGES,
  MAX_MESSAGE_QUOTES,
  MAX_TEXT_FILE_BYTES,
  MessageAttachmentsSchema,
  ThreadEventSchema,
  UserMessageEventSchema,
} from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { WebSocketServer } from 'ws'

const image = { name: 'shot.png', dataUrl: 'data:image/png;base64,aW1hZ2U=' }
const file = { name: 'notes.md', mime: 'text/markdown', content: '# Notes' }

describe('message attachment contracts', () => {
  it('accepts text-like files and rejects binaries', () => {
    expect(FileAttachmentSchema.safeParse(file).success).toBe(true)
    expect(FileAttachmentSchema.safeParse({ ...file, name: 'data.json', mime: 'application/json' }).success).toBe(true)
    expect(FileAttachmentSchema.safeParse({ ...file, name: 'brief.pdf', mime: 'application/pdf' }).success).toBe(false)
  })

  it('measures the file cap in UTF-8 bytes rather than JavaScript characters', () => {
    const within = '€'.repeat(Math.floor(MAX_TEXT_FILE_BYTES / 3))
    const over = `${within}€`
    expect(FileAttachmentSchema.safeParse({ ...file, content: within }).success).toBe(true)
    expect(FileAttachmentSchema.safeParse({ ...file, content: over }).success).toBe(false)
  })

  it('caps images and files at eight combined on every user-message boundary', () => {
    const images = Array.from({ length: 4 }, () => image)
    const files = Array.from({ length: 4 }, () => file)
    const ninth = [...files, file]

    expect(MessageAttachmentsSchema.safeParse({ images, files }).success).toBe(true)
    expect(MessageAttachmentsSchema.safeParse({ images, files: ninth }).success).toBe(false)
    expect(UserMessageEventSchema.safeParse({
      id: 'evt_1',
      ts: 1,
      type: 'user_message',
      text: 'Read these.',
      mentions: [],
      images,
      files,
    }).success).toBe(true)
    expect(ThreadEventSchema.safeParse({
      id: 'evt_2',
      ts: 2,
      type: 'user_message',
      text: 'Too many.',
      mentions: [],
      images,
      files: ninth,
    }).success).toBe(false)

    expect(ClientMessageSchema.safeParse({
      type: 'send_message',
      chatId: 'chat_1',
      text: 'Read these.',
      images,
      files,
    }).success).toBe(true)
    expect(ClientMessageSchema.safeParse({
      type: 'send_message',
      chatId: 'chat_1',
      text: 'Too many.',
      images,
      files: ninth,
    }).success).toBe(false)
    expect(ClientMessageSchema.safeParse({
      type: 'create_chat',
      openingMessage: { text: 'Too many.', images, files: ninth },
    }).success).toBe(false)
    expect(images.length + files.length).toBe(MAX_MESSAGE_ATTACHMENTS)
  })

  // Eight marked pictures at the 2 MB limit with their originals: the largest message the
  // web composer can build. Each marked one is followed by its original at the end.
  const largest = (marked: number) => {
    const body = 'A'.repeat(2_000_000 - 'data:image/webp;base64,'.length)
    const dataUrl = `data:image/webp;base64,${body}`
    const annotation = (original: number) => ({ original, pins: [{ x: 0.5, y: 0.5, comment: 'here' }], shapes: [], strokes: [[[0.1, 0.1], [0.2, 0.3]] as [number, number][]] })
    return [
      ...Array.from({ length: marked }, (_, index) => ({ name: `shot-${index}.webp`, dataUrl, annotation: annotation(marked + index) })),
      ...Array.from({ length: marked }, (_, index) => ({ name: `shot-${index} (original)`, dataUrl })),
    ]
  }

  it('lets eight marked pictures carry their originals without a slot', () => {
    const images = largest(MAX_MESSAGE_ATTACHMENTS)
    expect(images).toHaveLength(MAX_MESSAGE_IMAGES)
    expect(MessageAttachmentsSchema.safeParse({ images }).success).toBe(true)
    expect(UserMessageEventSchema.safeParse({ id: 'evt_1', ts: 1, type: 'user_message', text: 'Look.', mentions: [], images }).success).toBe(true)
    const send = { type: 'send_message', chatId: 'chat_1', text: 'Look.', images }
    expect(ClientMessageSchema.safeParse(send).success).toBe(true)
    // The socket takes the whole frame: ws's own cap, which the server leaves at its default.
    const { options } = new WebSocketServer({ noServer: true })
    expect(Buffer.byteLength(JSON.stringify(send))).toBeLessThan(options.maxPayload!)
  })

  it('still counts every picture the user sees toward the eight', () => {
    const images = largest(MAX_MESSAGE_ATTACHMENTS)
    // One file more than the eight shown pictures.
    expect(MessageAttachmentsSchema.safeParse({ images, files: [file] }).success).toBe(false)
    // A picture with marks of its own is never hidden as another's original.
    const marks = { pins: [], shapes: [] }
    const disguised = [
      { ...image, annotation: marks },
      ...Array.from({ length: 7 }, () => image),
      { ...image, annotation: { ...marks, original: 0 } },
    ]
    expect(MessageAttachmentsSchema.safeParse({ images: disguised }).success).toBe(false)
    // An original always follows its marked picture, as the composer places it.
    const backwards = [...Array.from({ length: 8 }, () => image), { ...image, annotation: { original: 0, pins: [], shapes: [] } }]
    expect(MessageAttachmentsSchema.safeParse({ images: backwards }).success).toBe(false)
    // Session feedback takes the same rule as a send.
    const feedback = { type: 'revise_work_goal', handoffId: 'h1', version: 1, text: 'Again.' }
    expect(ClientMessageSchema.safeParse({ ...feedback, images: largest(MAX_MESSAGE_ATTACHMENTS) }).success).toBe(true)
    expect(ClientMessageSchema.safeParse({ ...feedback, images: Array.from({ length: 9 }, () => image) }).success).toBe(false)
  })

  it('keeps freehand lines as shares of the picture and reads a stored annotation without them', () => {
    expect(ImageAnnotationSchema.safeParse({ pins: [], shapes: [], strokes: [[[0, 0], [1, 1]]] }).success).toBe(true)
    expect(ImageAnnotationSchema.safeParse({ pins: [], shapes: [], strokes: [[[0, 1.2]]] }).success).toBe(false)
    expect(ImageAnnotationSchema.safeParse({ pins: [], shapes: [], strokes: [[]] }).success).toBe(false)
    expect(ImageAnnotationSchema.parse({ pins: [], shapes: [] })).toEqual({ pins: [], shapes: [] })
  })
})

describe('message reply contracts', () => {
  const replyTo = { turnId: 'turn_1', agentId: 'sage', text: 'The source answer.' }

  it('carries one complete reply target on the send and durable event', () => {
    expect(ClientMessageSchema.safeParse({
      type: 'send_message',
      chatId: 'chat_1',
      text: 'Why?',
      replyTo,
    }).success).toBe(true)
    expect(ThreadEventSchema.safeParse({
      id: 'evt_1',
      ts: 1,
      type: 'user_message',
      text: 'Why?',
      mentions: [],
      replyTo,
    }).success).toBe(true)
    expect(ClientMessageSchema.safeParse({
      type: 'send_message',
      chatId: 'chat_1',
      text: 'Why?',
      replyTo: { agentId: 'sage', text: 'No source turn.' },
    }).success).toBe(false)
  })
})


describe('inline quote contracts', () => {
  const message = { kind: 'message', eventId: 'evt_source', text: 'Selected words', agentId: 'sage' }
  const note = { kind: 'note', path: 'inbox/untitled.md', text: 'Selected words' }
  const quotes = [message, note]
  const send = { type: 'send_message', chatId: 'chat_1', text: 'Why [Quote #1] or [Quote #2]?', quotes }

  it('preserves each quote and its source on both wire boundaries', () => {
    expect(ClientMessageSchema.parse(send)).toMatchObject({ quotes })
    expect(ThreadEventSchema.parse({
      id: 'evt_reply', ts: 2, type: 'user_message', text: send.text, mentions: [], quotes,
    })).toMatchObject({ quotes })
  })

  it('still reads a stored single-quote message', () => {
    const quote = { eventId: 'evt_source', text: 'Selected words' }
    const noteQuote = { path: 'inbox/untitled.md', text: 'Selected words' }
    expect(ThreadEventSchema.parse({
      id: 'evt_old', ts: 1, type: 'user_message', text: 'Why?', mentions: [], quote, noteQuote,
    })).toMatchObject({ quote, noteQuote })
  })

  it.each([
    { kind: 'message', text: 'Missing source' },
    { kind: 'message', eventId: 'evt_source', text: '   ' },
    { kind: 'message', eventId: 'evt_source', text: 'x'.repeat(6_001) },
    { kind: 'note', text: 'Missing path' },
    { kind: 'note', path: 'inbox/untitled.md', text: '   ' },
    { kind: 'note', path: 'inbox/untitled.md', text: 'x'.repeat(6_001) },
    { eventId: 'evt_source', text: 'Missing kind' },
  ])('rejects an invalid quote: %o', (invalid) => {
    expect(ClientMessageSchema.safeParse({ ...send, quotes: [invalid] }).success).toBe(false)
  })

  it('caps how many quotes one message carries', () => {
    const tooMany = Array.from({ length: MAX_MESSAGE_QUOTES + 1 }, () => message)
    expect(ClientMessageSchema.safeParse({ ...send, quotes: tooMany }).success).toBe(false)
  })
})
