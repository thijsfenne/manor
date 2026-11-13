import {
  ClientMessageSchema,
  FileAttachmentSchema,
  MAX_MESSAGE_ATTACHMENTS,
  MAX_MESSAGE_QUOTES,
  MAX_TEXT_FILE_BYTES,
  MessageAttachmentsSchema,
  ThreadEventSchema,
  UserMessageEventSchema,
} from '@manor/contracts'
import { describe, expect, it } from 'vitest'

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
