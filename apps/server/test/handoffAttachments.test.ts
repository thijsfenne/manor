import { MAX_TEXT_FILE_BYTES } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { loadHandoffAttachments, resolveHandoffAttachments } from '../src/handoffAttachments.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'

const PNG = 'data:image/png;base64,iVBORw0KGgo='

async function chat() {
  const store = createMemoryStore()
  const { id } = await store.createChat({ kind: 'dm', memberIds: ['sage'], title: 'Sage' })
  const deliver = async (name: string, mime: string, bytes: Uint8Array) => {
    const fileId = `file_${name}`
    await store.appendEvent(id, { type: 'file_delivery', agentId: 'sage', turnId: 't', file: { id: fileId, name, mime, size: bytes.byteLength } }, [{ id: fileId, bytes }])
  }
  return { store, id, deliver }
}

describe('handoff attachments', () => {
  it('takes the same picture named two ways once', async () => {
    const { store, id } = await chat()
    const sent = await store.appendEvent(id, { type: 'user_message', text: 'Zo.', mentions: [], images: [{ name: 'screen.png', dataUrl: PNG }] })
    const resolved = await resolveHandoffAttachments(store, id, [`/scratch/attachments/${sent.id}-0.png`, 'screen.png'])
    expect(resolved).toHaveLength(1)
    expect(await loadHandoffAttachments(store, resolved)).toEqual({ images: [{ name: 'screen.png', dataUrl: PNG }], files: [] })
  })

  it('refuses what the receiving model could not open or a message could not hold', async () => {
    const { store, id, deliver } = await chat()
    await deliver('brief.pdf', 'application/pdf', new Uint8Array([37, 80, 68, 70]))
    await deliver('huge.html', 'text/html', new TextEncoder().encode('x'.repeat(MAX_TEXT_FILE_BYTES + 1)))
    await deliver('latin.txt', 'text/plain', new Uint8Array([0xff, 0xfe]))
    await store.appendEvent(id, { type: 'user_message', text: 'Logo', mentions: [], images: [{ name: 'logo.svg', dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' }] })
    await expect(resolveHandoffAttachments(store, id, ['brief.pdf'])).rejects.toThrow('is a application/pdf file')
    await expect(resolveHandoffAttachments(store, id, ['huge.html'])).rejects.toThrow('may be at most 200 KB')
    await expect(resolveHandoffAttachments(store, id, ['latin.txt'])).rejects.toThrow('is not UTF-8 text')
    await expect(resolveHandoffAttachments(store, id, ['logo.svg'])).rejects.toThrow('is not a PNG, JPEG or WebP picture')
  })

  it('refuses more than a message holds, and names a file that is gone', async () => {
    const { store, id, deliver } = await chat()
    const names = Array.from({ length: 9 }, (_, index) => `page-${index}.html`)
    for (const name of names) await deliver(name, 'text/html', new TextEncoder().encode(`<p>${name}</p>`))
    await expect(resolveHandoffAttachments(store, id, names)).rejects.toThrow('at most 8 images and files together')
    const [first] = await resolveHandoffAttachments(store, id, names.slice(0, 1))
    await store.deleteChat(id)
    await expect(loadHandoffAttachments(store, [first!])).rejects.toThrow('"page-0.html" is no longer in the conversation it came from.')
  })
})
