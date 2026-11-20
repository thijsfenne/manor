import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { ServerMessage, ThreadEvent } from '@manor/contracts'
import { createChatMedia, imageSize, injectManorPrelude } from '../src/chatMedia.js'

const png = (width: number, height: number) => {
  const bytes = Buffer.alloc(33)
  bytes.writeUInt32BE(0x89504e47, 0)
  bytes.writeUInt32BE(0x0d0a1a0a, 4)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(height, 20)
  return bytes
}
const dataUrl = (mime: string, bytes: Buffer) => `data:${mime};base64,${bytes.toString('base64')}`

const picture = dataUrl('image/png', png(640, 480))
const events: ThreadEvent[] = [
  { id: 'evt_000001', ts: 1, type: 'user_message', text: 'look', mentions: [], images: [{ name: 'shot.png', dataUrl: picture }] },
  { id: 'evt_000002', ts: 2, type: 'agent_message', agentId: 'smith', turnId: 't1', text: 'seen' },
]

const servers: Server[] = []
afterEach(() => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))))

const serve = async (media: ReturnType<typeof createChatMedia>) => {
  const server = createServer((request, response) => {
    if (!media.handle(request, response)) {
      response.writeHead(418)
      response.end()
    }
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

describe('chat media', () => {
  it('sends a snapshot without image bytes, with a sized link that serves the stored picture', async () => {
    const media = createChatMedia({ loadEvents: async () => events, loadDocument: async () => undefined })
    const snapshot = media.forClient({ type: 'snapshot', chatId: 'chat 1', events, usage: {} } as ServerMessage)
    if (snapshot.type !== 'snapshot') throw new Error('not a snapshot')
    const sent = snapshot.events[0]
    const image = sent?.type === 'user_message' ? sent.images?.[0] : undefined
    expect(image).toMatchObject({ name: 'shot.png', width: 640, height: 480 })
    expect(image?.dataUrl).toBeUndefined()
    expect(JSON.stringify(snapshot)).not.toContain('base64')
    expect(snapshot.events[1]).toBe(events[1])

    const origin = await serve(media)
    const response = await fetch(`${origin}${image!.src}?retry=1`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('image/png')
    expect(response.headers.get('cache-control')).toContain('immutable')
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png(640, 480))
  })

  it('refuses a link it did not sign, and one that points past the pictures', async () => {
    const media = createChatMedia({ loadEvents: async () => events, loadDocument: async () => undefined })
    const frame = media.forClient({ type: 'event', chatId: 'chat 1', event: events[0]! })
    const src = frame.type === 'event' && frame.event.type === 'user_message' ? frame.event.images![0]!.src! : ''
    const origin = await serve(media)
    const forged = src.replace(/\/[^/]+$/, '/AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    expect((await fetch(`${origin}${forged}`)).status).toBe(404)
    const otherKey = createChatMedia({ loadEvents: async () => events, loadDocument: async () => undefined })
    const foreign = otherKey.forClient({ type: 'event', chatId: 'chat 1', event: events[0]! })
    const foreignSrc = foreign.type === 'event' && foreign.event.type === 'user_message' ? foreign.event.images![0]!.src! : ''
    expect((await fetch(`${origin}${foreignSrc}`)).status).toBe(404)
    expect((await fetch(`${origin}/not-media`)).status).toBe(418)
  })

  it('links a stored document to its original, which a PDF opens inline and a Word file downloads', async () => {
    const extraction = { status: 'complete' as const }
    const withDocuments: ThreadEvent = {
      id: 'evt_000003', ts: 3, type: 'user_message', text: 'read', mentions: [],
      documents: [
        { id: 'doc-pdf', name: 'brief v2.pdf', mime: 'application/pdf', size: 4, extraction, text: '[Page 1]\nhi' },
        { id: 'doc-word', name: 'notes.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 2, extraction, text: 'hi' },
      ],
    }
    const originals = new Map([['doc-pdf', Buffer.from('%PDF')], ['doc-word', Buffer.from('PK')]])
    const media = createChatMedia({
      loadEvents: async () => [withDocuments],
      loadDocument: async (chatId, id) => (chatId === 'chat 1' ? originals.get(id) : undefined),
    })
    const frame = media.forClient({ type: 'event', chatId: 'chat 1', event: withDocuments })
    const documents = frame.type === 'event' && frame.event.type === 'user_message' ? frame.event.documents ?? [] : []
    expect(documents.map((document) => document.src?.split('/').slice(-2, -1)[0])).toEqual(['d0', 'd1'])

    const origin = await serve(media)
    const pdf = await fetch(`${origin}${documents[0]!.src}`)
    expect(pdf.status).toBe(200)
    expect(pdf.headers.get('content-type')).toBe('application/pdf')
    expect(pdf.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''brief%20v2.pdf")
    expect(Buffer.from(await pdf.arrayBuffer()).toString()).toBe('%PDF')
    const word = await fetch(`${origin}${documents[1]!.src}`)
    expect(word.headers.get('content-disposition')).toContain('attachment;')

    originals.delete('doc-pdf')
    expect((await fetch(`${origin}${documents[0]!.src}`)).status).toBe(404)
  })

  it('serves a delivered file to open or save, never as a page, and says when it is gone', async () => {
    const delivered = (id: string, name: string, mime: string): ThreadEvent => ({
      id, ts: 4, type: 'file_delivery', agentId: 'smith', turnId: 't1', file: { id: `file-${id}`, name, mime, size: 4 },
    })
    const stored = [
      delivered('evt_4', 'Q3 report.pdf', 'application/pdf'),
      delivered('evt_5', 'page.html', 'text/html'),
      delivered('evt_6', 'mark.svg', 'image/svg+xml'),
    ]
    const originals = new Map([['file-evt_4', Buffer.from('%PDF')], ['file-evt_5', Buffer.from('<p class="a">&amp; é</p>')], ['file-evt_6', Buffer.from('<svg/>')]])
    const media = createChatMedia({ loadEvents: async () => stored, loadDocument: async (_chat, id) => originals.get(id) })
    const src = (event: ThreadEvent) => {
      const frame = media.forClient({ type: 'event', chatId: 'chat 1', event })
      return frame.type === 'event' && frame.event.type === 'file_delivery' ? frame.event.file.src! : ''
    }
    const origin = await serve(media)

    const pdf = await fetch(`${origin}${src(stored[0]!)}`)
    expect(pdf.headers.get('content-disposition')).toBe("inline; filename*=UTF-8''Q3%20report.pdf")
    expect(pdf.headers.get('content-security-policy')).toContain('sandbox')
    expect(Buffer.from(await pdf.arrayBuffer()).toString()).toBe('%PDF')
    const saved = await fetch(`${origin}${src(stored[0]!)}?download=1`)
    expect(saved.headers.get('content-disposition')).toMatch(/^attachment;/)
    expect((await fetch(`${origin}${src(stored[1]!)}`)).headers.get('content-disposition')).toMatch(/^attachment;/)
    const viewed = await fetch(`${origin}${src(stored[1]!)}?view=1`)
    expect(viewed.headers.get('content-disposition')).toMatch(/^inline;/)
    expect(viewed.headers.get('content-type')).toBe('text/html; charset=utf-8')
    // A viewed page runs its own inline scripts in an opaque origin with nothing to reach,
    // inside a fixed wrapper whose policy refuses every navigation of that inner frame.
    const policy = viewed.headers.get('content-security-policy')!.split(';').map((directive) => directive.trim())
    expect(policy).toEqual(expect.arrayContaining([
      "default-src 'none'", "script-src 'unsafe-inline' 'unsafe-eval'", "connect-src 'none'", "frame-src 'none'", 'img-src data: blob:',
      'font-src data:', "form-action 'none'", "base-uri 'none'", 'sandbox allow-scripts',
    ]))
    const wrapper = await viewed.text()
    expect(wrapper).toMatch(/<iframe sandbox="allow-scripts" title="page\.html" srcdoc="&lt;head&gt;&lt;style id=&quot;manor-theme&quot;&gt;.*&lt;p class=&quot;a&quot;&gt;&amp;amp; é&lt;\/p&gt;"><\/iframe>/)
    expect(wrapper).not.toContain('<script')
    // Opened on its own, dark by default, with the stage colour behind the page.
    expect(wrapper).toContain('<meta name="color-scheme" content="dark"><meta name="manor-view" content="1">')
    expect(wrapper).toContain('background:#0f1011')
    expect(Number(viewed.headers.get('content-length'))).toBe(Buffer.byteLength(wrapper))
    expect(policy.join(';')).not.toMatch(/allow-same-origin|allow-popups|allow-forms|allow-top-navigation|https?:|\*/)
    // Light theme and the chat's embed mode change the wrapper and the prelude, never the policy.
    const light = await fetch(`${origin}${src(stored[1]!)}?view=1&theme=light&embed=1`)
    const lightWrapper = await light.text()
    expect(light.headers.get('content-security-policy')).toBe(viewed.headers.get('content-security-policy'))
    expect(lightWrapper).toContain('<meta name="color-scheme" content="light">')
    expect(lightWrapper).toContain('background:transparent')
    expect(lightWrapper).toContain('color-scheme:light;')
    expect(lightWrapper).toContain('--manor-text:#16181b')
    expect(lightWrapper).not.toContain('--manor-text:#f7f8f8')
    // Saved or opened without `view`, it stays a script-free download, and SVG never gains scripts.
    expect((await fetch(`${origin}${src(stored[1]!)}`)).headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox")
    expect((await fetch(`${origin}${src(stored[1]!)}?view=1&download=1`)).headers.get('content-security-policy')).not.toContain('allow-scripts')
    const svg = await fetch(`${origin}${src(stored[2]!)}?view=1`)
    expect(svg.headers.get('content-disposition')).toMatch(/^inline;/)
    expect(svg.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox")
    expect((await fetch(`${origin}${src(stored[1]!)}?view=1&download=1`)).headers.get('content-disposition')).toMatch(/^attachment;/)
    const head = await fetch(`${origin}${src(stored[0]!)}`, { method: 'HEAD' })
    expect(head.status).toBe(200)

    originals.delete('file-evt_4')
    const gone = await fetch(`${origin}${src(stored[0]!)}`)
    expect(gone.status).toBe(404)
    expect(await gone.text()).toContain('no longer available')
    expect((await fetch(`${origin}${src(stored[0]!)}`, { method: 'HEAD' })).status).toBe(404)
  })

  it('links the pictures a tool call read, but never one the user attached to their own message', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'manor-tool-images-'))
    const attachments = path.join(root, 'attachments')
    mkdirSync(attachments)
    const own = path.join(attachments, 'evt_000001-0.png')
    // The agent's own picture lands in the same folder; it belongs to no user message.
    const agents = path.join(attachments, 'evt_000002-0.png')
    const shot = path.join(root, 'shot.png')
    const notPicture = path.join(root, 'fake.png')
    for (const file of [own, agents, shot]) writeFileSync(file, png(8, 8))
    writeFileSync(notPicture, 'not a picture')
    const read = (id: string, targets: string[]): ThreadEvent =>
      ({ id, ts: 3, type: 'tool_use', agentId: 'smith', turnId: 't1', tool: 'Read', targets })
    const transcript = [
      ...events,
      read('evt_000003', [own]),
      read('evt_000004', [agents, shot, path.join(root, 'notes.md'), 'relative.png', notPicture, path.join(root, 'gone.png')]),
    ]
    const media = createChatMedia({ loadEvents: async () => transcript, loadDocument: async () => undefined })
    const snapshot = media.forClient({ type: 'snapshot', chatId: 'chat 1', events: transcript, usage: {} } as ServerMessage)
    if (snapshot.type !== 'snapshot') throw new Error('not a snapshot')
    const images = (index: number) => {
      const event = snapshot.events[index]
      return event?.type === 'tool_use' ? event.images : undefined
    }
    expect(images(2)).toBeUndefined()
    expect(images(3)?.map((image) => image.target)).toEqual([agents, shot, notPicture, path.join(root, 'gone.png')])

    // A message sent after the snapshot counts the same as one inside it.
    const later: ThreadEvent = { id: 'evt_000005', ts: 4, type: 'user_message', text: 'and this', mentions: [], images: [{ name: 'b.png', dataUrl: picture }] }
    media.forClient({ type: 'event', chatId: 'chat 1', event: later })
    const live = media.forClient({ type: 'event', chatId: 'chat 1', event: read('evt_000006', [path.join(attachments, 'evt_000005-0.png')]) })
    expect(live.type === 'event' && live.event.type === 'tool_use' ? live.event.images : 'missing').toBeUndefined()

    const origin = await serve(media)
    const status = async (src: string | undefined) => (await fetch(`${origin}${src ?? ''}`)).status
    const served = await fetch(`${origin}${images(3)![1]!.src}`)
    expect(served.status).toBe(200)
    expect(served.headers.get('content-type')).toBe('image/png')
    expect(await status(images(3)![0]!.src)).toBe(200)
    expect(await status(images(3)![2]!.src)).toBe(404)
    expect(await status(images(3)![3]!.src)).toBe(404)

    // Until a whole thread went out, nothing in an `attachments` folder gets a link; the end
    // of a thread (`after`) cannot start what the server knows.
    const cold = createChatMedia({ loadEvents: async () => transcript, loadDocument: async () => undefined })
    const coldTargets = (message: ServerMessage) =>
      message.type === 'event' && message.event.type === 'tool_use' ? message.event.images?.map((image) => image.target) : 'missing'
    cold.forClient({ type: 'snapshot', chatId: 'chat 1', events: transcript.slice(2), after: 'evt_000002', usage: {} } as ServerMessage)
    expect(coldTargets(cold.forClient({ type: 'event', chatId: 'chat 1', event: transcript[2]! }))).toBeUndefined()
    expect(coldTargets(cold.forClient({ type: 'event', chatId: 'chat 1', event: transcript[3]! }))).toEqual([shot, notPicture, path.join(root, 'gone.png')])

    // Serving judges from the stored thread, not from what went out: a snapshot that lacked
    // the user's message linked their picture, and the link still finds nothing.
    const misled = createChatMedia({ loadEvents: async () => transcript, loadDocument: async () => undefined })
    const partial = misled.forClient({ type: 'snapshot', chatId: 'chat 1', events: transcript.slice(1), usage: {} } as ServerMessage)
    const leaked = partial.type === 'snapshot' && partial.events[1]?.type === 'tool_use' ? partial.events[1].images?.[0]?.src : undefined
    expect(leaked).toBeDefined()
    expect((await fetch(`${await serve(misled)}${leaked}`)).status).toBe(404)
  })

  it('puts the theme prelude after the head, or the nearest tag that exists', () => {
    const style = '<style id="manor-theme">'
    const inHead = injectManorPrelude('<!DOCTYPE html><HTML><HEAD lang="x"><title>t</title></HEAD><body></body></HTML>', 'dark')
    expect(inHead).toMatch(/^<!DOCTYPE html><HTML><HEAD lang="x"><style id="manor-theme">.*<\/script><title>t<\/title>/)
    expect(injectManorPrelude('<header>x</header>', 'dark')).toMatch(/^<head><style id="manor-theme">.*<\/script><\/head><header>x<\/header>$/)
    expect(injectManorPrelude('<html lang="nl"><body>x</body></html>', 'dark')).toMatch(/^<html lang="nl"><head><style id="manor-theme">.*<\/head><body>/)
    expect(injectManorPrelude('<!doctype html>\n<p>x</p>', 'light')).toMatch(/^<!doctype html><head>.*<\/head>\n<p>x<\/p>$/s)
    expect(injectManorPrelude('<p>x</p>', 'light')).toContain(`<head>${style}`)
    expect(injectManorPrelude('<!-- styles go in <head> --><html><head><title>t</title>', 'dark')).toMatch(/^<!-- styles go in <head> --><html><head><style id="manor-theme">/)
    expect(injectManorPrelude('<head data-label="a > b"><title>t</title>', 'dark')).toMatch(/^<head data-label="a > b"><style id="manor-theme">/)
    // The house sans travels inside the page, so a widget needs no network for its font.
    expect(inHead).toMatch(/@font-face\{font-family:'Geist Variable'[^}]*url\(data:font\/woff2;base64,/)
    // The size reporter stays quiet at the top level and re-posts when only the viewport changed.
    expect(inHead).toContain('window.top===window')
    expect(inHead).toContain('type:"manor:size",height:a,width:b,viewport:c')
    // Escape and the side arrows pressed inside the page go to the app around it.
    expect(inHead).toContain('if(!e.defaultPrevented)window.top.postMessage({type:"manor:key",key:k},"*")')
  })

  it('reads the pixel size of PNG, JPEG and WebP headers', () => {
    expect(imageSize(dataUrl('image/png', png(3, 2)))).toEqual({ width: 3, height: 2 })
    const jpeg = Buffer.from([
      0xff, 0xd8,
      0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0 before the frame
      0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x01, 0x90, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ])
    expect(imageSize(dataUrl('image/jpeg', jpeg))).toEqual({ width: 400, height: 300 })
    const webp = Buffer.alloc(30)
    webp.write('RIFF', 0, 'ascii')
    webp.write('WEBP', 8, 'ascii')
    webp.write('VP8X', 12, 'ascii')
    webp.writeUIntLE(1919, 24, 3)
    webp.writeUIntLE(1079, 27, 3)
    expect(imageSize(dataUrl('image/webp', webp))).toEqual({ width: 1920, height: 1080 })
    expect(imageSize('data:image/svg+xml;base64,PHN2Zy8+')).toBeUndefined()
  })
})
