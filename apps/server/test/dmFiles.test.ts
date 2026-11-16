import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { DOCX_MIME, PDF_MIME, ServerMessageSchema, type ServerMessage } from '@manor/contracts'
import { ChatModule } from '../src/chatModule.js'
import { createChatMedia } from '../src/chatMedia.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { roster, seededChat } from './helpers.js'

const picture = `data:image/png;base64,${Buffer.from('not really a png').toString('base64')}`
const extraction = { status: 'complete' as const }

/** A DM that holds one file of every kind, and the module that lists it. */
async function library() {
  const store = createMemoryStore({ agents: roster })
  const session = await seededChat(store)
  const dm = await store.createChat({ kind: 'dm', memberIds: ['sage'] })
  const asked = await store.appendEvent(dm.id, {
    type: 'user_message', text: 'Read these', mentions: [],
    images: [{ name: 'receipt.png', dataUrl: picture }],
    files: [{ name: 'notes.md', mime: 'text/markdown', content: '# Notes\n\nTwo lines.' }],
    documents: [
      { id: 'doc_kept', name: 'contract.pdf', mime: PDF_MIME, size: 4, extraction, text: 'kept' },
      { id: 'doc_gone', name: 'letter.docx', mime: DOCX_MIME, size: 9, extraction, text: 'gone' },
    ],
  }, [{ id: 'doc_kept', bytes: Buffer.from('%PDF') }])
  const drawn = await store.appendEvent(dm.id, {
    type: 'agent_message', agentId: 'sage', turnId: 't1', text: 'Here is a chart.', images: [{ name: 'chart.png', dataUrl: picture }],
  })
  await store.appendEvent(dm.id, {
    type: 'file_delivery', agentId: 'sage', turnId: 't1', file: { id: 'file_page', name: 'report.html', mime: 'text/html', size: 6 },
  }, [{ id: 'file_page', bytes: Buffer.from('<p>ok') }])
  await store.appendEvent(dm.id, {
    type: 'file_delivery', agentId: 'sage', turnId: 't2', file: { id: 'file_clip', name: 'clip.mp4', mime: 'video/mp4', size: 10 },
  }, [{ id: 'file_clip', bytes: Buffer.from('0123456789') }])
  await store.appendEvent(dm.id, {
    type: 'file_delivery', agentId: 'sage', turnId: 't2', file: { id: 'file_lost', name: 'lost.zip', mime: 'application/zip', size: 3 },
  })
  const replies: ServerMessage[] = []
  const chats = new ChatModule({
    store, agents: () => roster, orchestrator: {} as never, broadcast: () => undefined, broadcastDirectory: async () => undefined,
  })
  const list = async (chatId: string) => {
    await chats.handle({ type: 'get_dm_files', chatId, requestId: 'files-1' }, (message) => replies.push(message), () => undefined)
    return replies.at(-1)!
  }
  return { store, dm, session, asked, drawn, list }
}

let server: Server | undefined
afterEach(() => new Promise<void>((resolve) => (server === undefined ? resolve() : server.close(() => resolve()))))

describe('a DM\'s file library', () => {
  it('lists what the user attached and what the agent made, newest first, with author and message', async () => {
    const { dm, asked, drawn, list } = await library()
    const reply = await list(dm.id)
    if (reply.type !== 'dm_files') throw new Error('not a file list')
    expect(reply).toMatchObject({ chatId: dm.id, requestId: 'files-1' })
    expect(reply.files.map((file) => [file.name, file.kind, file.agentId ?? 'user', file.messageId ?? null])).toEqual([
      // A delivery whose turn said nothing has no message to show.
      ['lost.zip', 'file', 'sage', null],
      ['clip.mp4', 'video', 'sage', null],
      ['report.html', 'file', 'sage', drawn.id],
      ['chart.png', 'image', 'sage', drawn.id],
      ['receipt.png', 'image', 'user', asked.id],
      ['notes.md', 'file', 'user', asked.id],
      ['contract.pdf', 'pdf', 'user', asked.id],
      ['letter.docx', 'file', 'user', asked.id],
    ])
    expect(new Set(reply.files.map((file) => file.id)).size).toBe(reply.files.length)
    expect(reply.files.find((file) => file.name === 'report.html')?.page).toBe(true)
    expect(reply.files.find((file) => file.name === 'notes.md')?.size).toBe(19)
    expect(reply.files.find((file) => file.name === 'receipt.png')).toMatchObject({ mime: 'image/png', size: 16 })
    expect(JSON.stringify(reply)).not.toContain('base64')
  })

  it('lists a file whose bytes are gone without a link, and keeps the rest', async () => {
    const { dm, list } = await library()
    const reply = await list(dm.id)
    if (reply.type !== 'dm_files') throw new Error('not a file list')
    const linked = (name: string) => reply.files.find((file) => file.name === name)?.src !== undefined
    expect(['lost.zip', 'letter.docx'].map(linked)).toEqual([false, false])
    expect(['clip.mp4', 'report.html', 'chart.png', 'receipt.png', 'notes.md', 'contract.pdf'].map(linked)).toEqual([true, true, true, true, true, true])
  })

  it('answers only for a DM', async () => {
    const { session, list } = await library()
    for (const id of ['missing', session.chatId]) expect(await list(id)).toMatchObject({ type: 'notice', kind: 'error' })
  })

  it('hands out links that pass the wire schema and serve each file', async () => {
    const { store, dm, list } = await library()
    const media = createChatMedia({
      loadEvents: (chatId) => store.loadEvents(chatId),
      loadDocument: (chatId, documentId) => store.loadDocument(chatId, documentId),
    })
    const sent = ServerMessageSchema.parse(media.forClient(await list(dm.id)))
    if (sent.type !== 'dm_files') throw new Error('not a file list')
    server = createServer((request, response) => void media.handle(request, response))
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    const origin = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
    const fetched = (name: string, init?: RequestInit) => fetch(`${origin}${sent.files.find((file) => file.name === name)!.src}`, init)

    const note = await fetched('notes.md')
    expect(note.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await note.text()).toBe('# Notes\n\nTwo lines.')
    expect((await fetched('receipt.png')).headers.get('content-type')).toBe('image/png')
    expect(await (await fetched('contract.pdf')).text()).toBe('%PDF')
    expect(await (await fetched('report.html')).text()).toBe('<p>ok')

    // A video player seeks by range.
    const part = await fetched('clip.mp4', { headers: { range: 'bytes=2-5' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 2-5/10')
    expect(await part.text()).toBe('2345')
    const rest = await fetched('clip.mp4', { headers: { range: 'bytes=8-' } })
    expect(await rest.text()).toBe('89')
    expect((await fetched('clip.mp4', { headers: { range: 'bytes=40-' } })).status).toBe(200)
  })
})
