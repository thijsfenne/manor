import { strToU8, zipSync } from 'fflate'
import { expect, test } from 'vitest'
import { DOCX_MIME, MAX_DOCUMENT_BYTES, MAX_PDF_PAGES, PDF_MIME, ServerMessageSchema } from '@manor/contracts'
import { docxParagraphs, extractDocument, pageRanges, readDocuments } from '../src/documentExtract.js'
import { docxFixture, pdfFixture } from './documentFixtures.js'

const para = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`

test('a PDF with a text layer on every page is complete, with page markers', async () => {
  const result = await extractDocument(PDF_MIME, pdfFixture(['Client briefing for the Q4 launch', 'Budget and timeline section']))
  expect(result.extraction).toEqual({ status: 'complete', pageCount: 2 })
  expect(result.text).toBe('[Page 1]\nClient briefing for the Q4 launch\n\n[Page 2]\nBudget and timeline section')
})

test('pages without a text layer are named, and the document is partial rather than whole', async () => {
  const result = await extractDocument(PDF_MIME, pdfFixture(['Readable first page of the brief', null, null, 'Readable fourth page here', null]))
  expect(result.extraction.status).toBe('partial')
  expect(result.extraction.unreadablePages).toEqual([2, 3, 5])
  expect(result.extraction.detail).toContain('Pages 2–3, 5 gave no usable text')
  expect(result.text).toContain('[Page 2: no usable text layer]')
  expect(result.text).toContain('[Page 4]\nReadable fourth page here')
})

test('a fully scanned PDF fails honestly instead of passing for an empty document', async () => {
  const result = await extractDocument(PDF_MIME, pdfFixture([null, null]))
  expect(result.extraction).toMatchObject({ status: 'failed', pageCount: 2, unreadablePages: [1, 2] })
  expect(result.extraction.detail).toContain('does not run OCR')
  expect(result.text).toBe('')
})

test('text past the cap stops on a page boundary and says where', async () => {
  const result = await extractDocument(PDF_MIME, pdfFixture(['First page with enough words', 'Second page with enough words', 'Third page']), 60)
  expect(result.extraction).toMatchObject({ status: 'partial', truncated: true, pageCount: 3 })
  expect(result.extraction.detail).toContain('after page 1 of 3')
  expect(result.text).toBe('[Page 1]\nFirst page with enough words')
})

test('bytes that are not a PDF or a Word file fail without throwing', async () => {
  const junk = new TextEncoder().encode('definitely not a document')
  expect((await extractDocument(PDF_MIME, junk)).extraction).toMatchObject({ status: 'failed' })
  expect((await extractDocument(DOCX_MIME, junk)).extraction).toEqual({ status: 'failed', detail: 'The file could not be opened as a Word document.' })
  expect((await extractDocument(DOCX_MIME, zipSync({ 'other.xml': strToU8('<x/>') }))).extraction.status).toBe('failed')
})

test('a Word file reads paragraphs and table rows; embedded images make coverage unknown', async () => {
  const table = '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Phase</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Weeks</w:t></w:r></w:p></w:tc></w:tr></w:tbl>'
  const body = `${para('Scope &amp; goals')}${table}<w:p><w:r><w:delText>removed</w:delText><w:t>kept</w:t></w:r></w:p>`
  const plain = await extractDocument(DOCX_MIME, docxFixture(body))
  expect(plain).toEqual({ extraction: { status: 'complete' }, text: 'Scope & goals\nPhase\tWeeks\nkept' })

  const withImage = await extractDocument(DOCX_MIME, docxFixture(body, { 'word/media/image1.png': 'png' }))
  expect(withImage.extraction.status).toBe('unknown')
  expect(withImage.extraction.detail).toContain('1 image, chart or embedded object')

  const onlyImage = await extractDocument(DOCX_MIME, docxFixture('<w:p/>', { 'word/media/image1.png': 'png' }))
  expect(onlyImage.extraction.status).toBe('failed')
})

test('many scattered unreadable pages still fit the event and snapshot a client accepts', async () => {
  const pages = Array.from({ length: 240 }, (_, index) => index % 2 === 0 ? 'Readable briefing page with enough text' : null)
  const { extraction, text } = await extractDocument(PDF_MIME, pdfFixture(pages))
  expect(extraction).toMatchObject({ status: 'partial', pageCount: 240 })
  expect(extraction.unreadablePages).toHaveLength(120)
  expect(extraction.detail).toContain('and 108 more')
  const event = {
    id: 'evt_000001', ts: 1, type: 'user_message', text: 'Review', mentions: [],
    documents: [{ id: 'doc', name: 'brief.pdf', mime: PDF_MIME, size: 1, extraction, text }],
  }
  expect(ServerMessageSchema.safeParse({ type: 'event', chatId: 'chat', event }).success).toBe(true)
  expect(ServerMessageSchema.safeParse({ type: 'snapshot', chatId: 'chat', events: [event], usage: {} }).success).toBe(true)
})

test('a PDF past the page limit fails before extraction and keeps its original', async () => {
  const pdf = pdfFixture(Array.from({ length: MAX_PDF_PAGES + 1 }, () => null))
  expect(pdf.byteLength).toBeLessThan(MAX_DOCUMENT_BYTES)
  const { documents, originals } = await readDocuments([{ name: 'huge.pdf', mime: PDF_MIME, data: Buffer.from(pdf).toString('base64') }])
  expect(documents[0]).toMatchObject({
    text: '',
    extraction: { status: 'failed', pageCount: MAX_PDF_PAGES + 1, detail: 'The PDF has 10,001 pages; Manor reads at most 10,000.' },
  })
  // Buffer.compare, not toEqual: a deep equal walks the 2.3 MB original byte by byte, which
  // took seconds alone and over half a minute on a loaded machine in pre-commit.
  expect(originals).toEqual([{ id: documents[0]!.id, bytes: expect.any(Uint8Array) }])
  expect(Buffer.compare(originals[0]!.bytes, pdf)).toBe(0)
  const event = { id: 'evt_000001', ts: 1, type: 'user_message', text: 'Review', mentions: [], documents }
  expect(ServerMessageSchema.safeParse({ type: 'event', chatId: 'chat', event }).success).toBe(true)
  expect(ServerMessageSchema.safeParse({ type: 'snapshot', chatId: 'chat', events: [event], usage: {} }).success).toBe(true)
})

test('Word text left in footnotes or headers makes the extraction partial, empty ones do not', async () => {
  const footnotes = (text: string) => ({
    'word/footnotes.xml': `<w:footnotes><w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>${text}</w:footnotes>`,
  })
  const body = para('Body with a footnote')
  const skipped = await extractDocument(DOCX_MIME, docxFixture(body, {
    ...footnotes('<w:footnote w:id="1"><w:p><w:r><w:t>Required budget limitation</w:t></w:r></w:p></w:footnote>'),
    'word/header1.xml': `<w:hdr>${para('Confidential')}</w:hdr>`,
  }))
  expect(skipped.extraction).toMatchObject({ status: 'partial', detail: 'Text in its headers and footnotes was not read.' })
  expect(skipped.text).toBe('Body with a footnote')

  const empty = await extractDocument(DOCX_MIME, docxFixture(body, { ...footnotes(''), 'word/footer1.xml': '<w:ftr><w:p/></w:ftr>' }))
  expect(empty.extraction).toEqual({ status: 'complete' })
})

test('page ranges and paragraph parsing stay readable', () => {
  expect(pageRanges([1, 2, 3, 5, 7, 8])).toBe('1–3, 5, 7–8')
  expect(pageRanges([1, 3, 5, 7], 2)).toBe('1, 3 and 2 more')
  expect(docxParagraphs('<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t></w:r></w:p>')).toEqual(['a\tb'])
})
