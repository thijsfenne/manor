import type { AgentConfig, EventDocument } from '@manor/contracts'
import { MAX_DOCUMENT_BYTES, MAX_TEXT_FILE_BYTES } from '@manor/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it } from 'vitest'
import { Composer } from '../src/components/Composer'
import { UserBubble } from '../src/components/Bubbles'
import { clearDrafts, writeDraft } from '../src/composerDrafts'
import { CHAT_ATTACH_ACCEPT, readAttachments, readChatDocument, readChatFile, refusedFilesNotice } from '../src/chatFiles'

const agent = (id: string, name: string): AgentConfig =>
  ({ id, name, color: '#8b5cf6', driver: 'claude', model: 'claude-opus-5', effort: 'high', allowedTools: [] }) as unknown as AgentConfig

const ROSTER = [agent('sage', 'Sage')]

const NOTE = { name: 'brief.md', mime: 'text/markdown', content: '# Brief\n' }

const render = (draftKey?: string) =>
  renderToStaticMarkup(
    <Composer
      agents={ROSTER}
      onSend={() => true}
      canSend
      blockedNote=""
      {...(draftKey === undefined ? {} : { draftKey })}
    />,
  )

afterEach(clearDrafts)

describe('what the composer takes', () => {
  // The menu itself only exists once it is opened, so what is asserted here is the
  // picker standing behind it: it is the promise the row makes, and the row's own
  // label is checked where the menu is rendered open.
  it('keeps one picker for pictures and text alike', () => {
    const html = render()

    expect(html).toContain(`accept="${CHAT_ATTACH_ACCEPT}"`)
    expect(html).not.toContain('Attach images')
  })

  it('gives the text box and the hidden picker a name for a screen reader', () => {
    const html = render()

    expect(html).toContain('aria-label="Attach files"')
    expect(html).toMatch(/aria-label="Ask anything…"/)
  })

  it('names the files it refused, at most two, with a long name cut in the middle', () => {
    expect(refusedFilesNotice(['clip.mov'])).toBe('clip.mov is not a picture, text, PDF or Word file.')
    expect(refusedFilesNotice(['a.mov', 'b.zip'])).toBe('2 files are not pictures, text, PDF or Word files: a.mov, b.zip')
    expect(refusedFilesNotice(['a.mov', 'b.zip', 'c.exe', 'd.dmg'])).toBe('4 files are not pictures, text, PDF or Word files: a.mov, b.zip and 2 more')
    const long = `${'x'.repeat(100)}-final.mov`
    const notice = refusedFilesNotice([long])
    expect(notice).toContain('…xx-final.mov is not')
    expect(notice.length).toBeLessThan(90)
  })

  // The picker is the promise; a format missing here is a file someone cannot pick
  // even though the server would have taken it.
  it('lets the picker show pictures and text alike', () => {
    expect(CHAT_ATTACH_ACCEPT).toContain('image/png')
    expect(CHAT_ATTACH_ACCEPT).toContain('.md')
    expect(CHAT_ATTACH_ACCEPT).toContain('.json')
  })

  it('shows a staged text file by name and size, and lets it be sent alone', () => {
    writeDraft('chat-a', { text: '', images: [], files: [NOTE] })

    const html = render('chat-a')

    expect(html).toContain('brief.md')
    expect(html).toContain('Remove brief.md')
    // A draft holding only a file is still a draft worth sending.
    expect(html).not.toContain('disabled=""')
  })

  it('says a drop lands here, without swallowing the drag it answers', () => {
    const html = render()

    expect(html).toContain('Drop to attach')
    expect(html).toContain('pointer-events-none')
  })
})

describe('reading a file for the wire', () => {
  it('names the type from the extension, whatever the platform claimed', async () => {
    const file = new File(['# Brief'], 'brief.md', { type: 'application/octet-stream' })

    await expect(readChatFile(file)).resolves.toEqual({ name: 'brief.md', mime: 'text/markdown', content: '# Brief' })
  })

  it('refuses what a persona could not read as text', async () => {
    const file = new File(['PK'], 'bundle.zip', { type: 'application/zip' })

    await expect(readChatFile(file)).rejects.toThrow(/not a text file/)
  })

  // Refused before the browser pulls it into memory, and named in the units the
  // person picking it thinks in.
  it('refuses a file past the wire’s size cap', async () => {
    const file = new File(['x'.repeat(MAX_TEXT_FILE_BYTES + 1)], 'huge.log', { type: 'text/plain' })

    await expect(readChatFile(file)).rejects.toThrow(/200 KB/)
  })

  /**
   * The failure this guards is silent by construction: the server drops a message
   * whose attachment its schema refuses, so anything the composer accepts that the
   * wire will not take costs the whole send, not the file.
   */
  it('refuses anything the wire’s own schema would', async () => {
    const file = new File(['# Brief'], `${'a'.repeat(200)}.md`, { type: 'text/markdown' })

    await expect(readChatFile(file)).rejects.toThrow(/cannot be attached/)
  })
})

/**
 * The slow half of attaching, lifted out of the composer so it can be run here at
 * all: the component's own copy of this loop could only be exercised through a DOM
 * this app's tests do not have.
 */
describe('reading a batch of picked files', () => {
  it('keeps what it can read and reports what it cannot, in order', async () => {
    const read = await readAttachments([
      new File(['# Brief'], 'brief.md', { type: 'text/markdown' }),
      new File(['x'.repeat(MAX_TEXT_FILE_BYTES + 1)], 'huge.log', { type: 'text/plain' }),
      new File(['a,b'], 'rows.csv', { type: 'text/csv' }),
    ])

    expect(read.files.map((file) => file.name)).toEqual(['brief.md', 'rows.csv'])
    expect(read.problems).toHaveLength(1)
    // The one slot the unreadable file was holding, so the composer can give it back
    // instead of counting room nobody is using.
    expect(read.slotsFreed).toBe(1)
  })

  it('frees every slot when nothing survives', async () => {
    const read = await readAttachments([new File(['PK'], 'a.zip', { type: 'application/zip' })])

    expect(read.files).toEqual([])
    expect(read.slotsFreed).toBe(1)
  })
})

describe('a sent message with a file on it', () => {
  it('names the file in the bubble rather than quoting it back', () => {
    const html = renderToStaticMarkup(
      <UserBubble text="lees dit even" agents={ROSTER} skills={[]} files={[NOTE]} />,
    )

    expect(html).toContain('brief.md')
    expect(html).not.toContain('# Brief')
  })
})

describe('a PDF or Word document', () => {
  it('is offered by the picker, read as its original bytes, and staged with a remove control', async () => {
    expect(CHAT_ATTACH_ACCEPT).toContain('.pdf')
    expect(CHAT_ATTACH_ACCEPT).toContain('.docx')
    const read = await readAttachments([new File(['%PDF-1.4'], 'brief.pdf', { type: 'application/octet-stream' })])
    expect(read.documents).toEqual([{ name: 'brief.pdf', mime: 'application/pdf', data: btoa('%PDF-1.4') }])
    expect(read.files).toEqual([])

    writeDraft('chat-d', { text: '', images: [], files: [], documents: read.documents })
    const html = render('chat-d')
    expect(html).toContain('brief.pdf')
    expect(html).toContain('Remove brief.pdf')
    expect(html).toContain('8 B')
    expect(html).not.toContain('disabled=""')
  })

  it('refuses one past the size cap before reading it', async () => {
    const file = new File([new Uint8Array(MAX_DOCUMENT_BYTES + 1)], 'deck.pdf', { type: 'application/pdf' })
    await expect(readChatDocument(file)).rejects.toThrow(/8 MB/)
  })

  it('shows in the bubble how much text came out, and links the original once stored', () => {
    const partial: EventDocument = {
      id: 'd1', name: 'scan.pdf', mime: 'application/pdf', size: 10, text: '', src: 'http://manor/media/c/e/d0/sig',
      extraction: { status: 'partial', pageCount: 4, unreadablePages: [2, 3], detail: 'Pages 2–3 gave no usable text (blank, scanned or image-only).' },
    }
    const html = renderToStaticMarkup(
      <UserBubble text="" agents={ROSTER} skills={[]} documents={[partial, { name: 'notes.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }]} />,
    )
    expect(html).toContain('4 pages, 2 unreadable')
    expect(html).toContain('href="http://manor/media/c/e/d0/sig"')
    expect(html).toContain('Pages 2–3 gave no usable text')
    expect(html).toContain('Reading…')
  })
})
