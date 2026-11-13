import { randomUUID } from 'node:crypto'
import { unzipSync } from 'fflate'
import { getDocumentProxy } from 'unpdf'
import {
  MAX_DOCUMENT_BYTES, MAX_PDF_PAGES, MAX_TEXT_FILE_BYTES, PDF_MIME,
  type DocumentExtraction, type DocumentMime, type DocumentUpload, type EventDocument,
} from '@manor/contracts'
import type { DocumentOriginal } from './store.js'

/**
 * Local text extraction for an attached PDF or Word file. Nothing leaves the machine
 * and nothing is OCR'd: a page without a text layer is named as unreadable rather
 * than guessed at, and the result says how much it covered so the persona can say
 * the same instead of treating a partial read as the whole document.
 */
export interface ExtractedDocument {
  extraction: DocumentExtraction
  text: string
}

/**
 * Turns the documents a message carries into what its stored event holds, the
 * extracted text and its coverage, plus the originals the store writes together with
 * that event. One at a time, so eight long PDFs never sit decoded in memory together.
 */
export async function readDocuments(uploads: readonly DocumentUpload[]): Promise<{ documents: EventDocument[], originals: DocumentOriginal[] }> {
  const documents: EventDocument[] = []
  const originals: DocumentOriginal[] = []
  for (const upload of uploads) {
    const bytes = Buffer.from(upload.data, 'base64')
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new Error(`${upload.name} is larger than ${MAX_DOCUMENT_BYTES / 1_024 / 1_024} MB.`)
    const { extraction, text } = await extractDocument(upload.mime, bytes)
    const id = randomUUID()
    originals.push({ id, bytes })
    documents.push({ id, name: upload.name, mime: upload.mime, size: bytes.byteLength, extraction, text })
  }
  return { documents, originals }
}

/** A page with fewer visible characters than this reads as blank, scanned or image-only. */
const MIN_PAGE_CHARS = 16
/** An inflated `document.xml` past this is refused before it is unpacked. */
const MAX_DOCX_XML_BYTES = 64 * 1_024 * 1_024

export async function extractDocument(mime: DocumentMime, bytes: Uint8Array, maxTextBytes = MAX_TEXT_FILE_BYTES): Promise<ExtractedDocument> {
  return mime === PDF_MIME ? extractPdf(bytes, maxTextBytes) : extractDocx(bytes, maxTextBytes)
}

const failed = (detail: string, pageCount?: number): ExtractedDocument => ({
  extraction: { status: 'failed', detail, ...(pageCount === undefined ? {} : { pageCount }) },
  text: '',
})

const utf8 = (value: string) => Buffer.byteLength(value, 'utf8')

/**
 * `3, 5–7, 9`, the way someone reads a page list. Past `limit` ranges the rest is
 * counted instead of listed, so a detail line stays inside its contract cap; the
 * full list lives in `unreadablePages`.
 */
export function pageRanges(pages: readonly number[], limit = 12): string {
  const ranges: string[] = []
  let listed = 0
  for (let index = 0; index < pages.length && ranges.length < limit; index += 1) {
    const start = pages[index]!
    let end = start
    while (pages[index + 1] === end + 1) end = pages[++index]!
    ranges.push(start === end ? String(start) : `${start}–${end}`)
    listed = index + 1
  }
  const rest = pages.length - listed
  return ranges.join(', ') + (rest === 0 ? '' : ` and ${rest} more`)
}

async function extractPdf(bytes: Uint8Array, maxTextBytes: number): Promise<ExtractedDocument> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>
  try {
    // A fresh copy: pdf.js takes ownership of what it is handed, and a Node Buffer's
    // `slice` is a view into a shared pool it would read from the wrong offset.
    pdf = await getDocumentProxy(new Uint8Array(bytes))
  } catch (error) {
    return failed((error as Error | undefined)?.name === 'PasswordException'
      ? 'The PDF is password protected, so no text could be read.'
      : 'The file could not be opened as a PDF.')
  }
  try {
    const pageCount = pdf.numPages
    if (pageCount > MAX_PDF_PAGES) {
      return failed(`The PDF has ${pageCount.toLocaleString('en')} pages; Manor reads at most ${MAX_PDF_PAGES.toLocaleString('en')}.`, pageCount)
    }
    const unreadable: number[] = []
    const chunks: string[] = []
    let used = 0
    let lastIncluded = 0
    for (let number = 1; number <= pageCount; number += 1) {
      const page = await pdf.getPage(number)
      const content = await page.getTextContent()
      page.cleanup()
      const text = content.items
        .map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : ''))
        .join('')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
      const readable = text.replace(/\s/g, '').length >= MIN_PAGE_CHARS
      if (!readable) unreadable.push(number)
      const chunk = readable ? `[Page ${number}]\n${text}` : `[Page ${number}: no usable text layer]`
      if (lastIncluded === number - 1 && used + utf8(chunk) + 2 <= maxTextBytes) {
        chunks.push(chunk)
        used += utf8(chunk) + 2
        lastIncluded = number
      }
      // Parsing is synchronous inside pdf.js; yielding per page keeps every other
      // chat's stream moving while a long document is read.
      await new Promise((resolve) => setImmediate(resolve))
    }
    if (pageCount === 0) return failed('The PDF has no pages.', 0)
    if (unreadable.length === pageCount) {
      return {
        extraction: {
          status: 'failed', pageCount, unreadablePages: unreadable,
          detail: `${pageCount === 1 ? 'Its one page has no' : `None of its ${pageCount} pages has a`} usable text layer. It looks scanned or image-only, and Manor does not run OCR.`,
        },
        text: '',
      }
    }
    const truncated = lastIncluded < pageCount
    const problems = [
      ...(unreadable.length === 0 ? [] : [`${unreadable.length === 1 ? 'Page' : 'Pages'} ${pageRanges(unreadable)} gave no usable text (blank, scanned or image-only).`]),
      ...(truncated ? [`Text stops after page ${lastIncluded} of ${pageCount} at the size cap.`] : []),
    ]
    return {
      extraction: {
        status: problems.length === 0 ? 'complete' : 'partial',
        pageCount,
        ...(unreadable.length === 0 ? {} : { unreadablePages: unreadable }),
        ...(truncated ? { truncated: true } : {}),
        ...(problems.length === 0 ? {} : { detail: problems.join(' ') }),
      },
      text: chunks.join('\n\n'),
    }
  } catch {
    return failed('The PDF could not be read to the end.', pdf.numPages)
  } finally {
    void pdf.loadingTask.destroy()
  }
}

/** Folders a Word package keeps non-text content in; anything there is invisible to text extraction. */
const EMBEDDED = /^word\/(?:media|charts|embeddings|diagrams)\//
/** Word parts that can hold text but are left out of the body; each is only checked for text. */
const SKIPPED_PARTS = [
  ['headers', /^word\/header\d*\.xml$/],
  ['footers', /^word\/footer\d*\.xml$/],
  ['footnotes', /^word\/footnotes\.xml$/],
  ['endnotes', /^word\/endnotes\.xml$/],
  ['comments', /^word\/comments\.xml$/],
] as const

function extractDocx(bytes: Uint8Array, maxTextBytes: number): ExtractedDocument {
  let embedded = 0
  let oversized = false
  let entries: Record<string, Uint8Array>
  try {
    entries = unzipSync(bytes, {
      filter: (file) => {
        if (EMBEDDED.test(file.name)) embedded += 1
        if (file.name !== 'word/document.xml' && !SKIPPED_PARTS.some(([, part]) => part.test(file.name))) return false
        if (file.originalSize > MAX_DOCX_XML_BYTES) oversized = true
        return !oversized
      },
    })
  } catch {
    return failed('The file could not be opened as a Word document.')
  }
  if (oversized) return failed('The Word document is too large to read.')
  const xml = entries['word/document.xml']
  if (xml === undefined) return failed('The file is not a Word document; it has no document body.')
  // A separator footnote or an empty header is normal; only parts that hold text count as missed.
  const missed = SKIPPED_PARTS
    .filter(([, part]) => Object.entries(entries).some(([name, content]) =>
      part.test(name) && docxParagraphs(new TextDecoder().decode(content)).length > 0))
    .map(([label]) => label)

  const paragraphs = docxParagraphs(new TextDecoder().decode(xml))
  const kept: string[] = []
  let used = 0
  for (const paragraph of paragraphs) {
    const cost = utf8(paragraph) + 1
    if (used + cost > maxTextBytes) break
    kept.push(paragraph)
    used += cost
  }
  const text = kept.join('\n').trim()
  const objects = embedded === 1 ? '1 image, chart or embedded object' : `${embedded} images, charts or embedded objects`
  if (text.length === 0) {
    return failed(embedded === 0 ? 'The Word document contains no text.' : `The Word document has no text, only ${objects}.`)
  }
  const truncated = kept.length < paragraphs.length
  const problems = [
    ...(truncated ? [`Text stops after paragraph ${kept.length} of ${paragraphs.length} at the size cap.`] : []),
    ...(missed.length === 0 ? [] : [`Text in its ${listOf(missed)} was not read.`]),
    ...(embedded === 0 ? [] : [`It contains ${objects}; anything inside them was not read.`]),
  ]
  return {
    extraction: {
      status: truncated || missed.length > 0 ? 'partial' : embedded > 0 ? 'unknown' : 'complete',
      ...(truncated ? { truncated: true } : {}),
      ...(problems.length === 0 ? {} : { detail: problems.join(' ') }),
    },
    text,
  }
}

const listOf = (items: readonly string[]) =>
  items.length === 1 ? items[0]! : `${items.slice(0, -1).join(', ')} and ${items.at(-1)!}`

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decodeXml = (value: string) => value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
  if (name[0] === '#') {
    const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1))
    return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole
  }
  return ENTITY[name.toLowerCase()] ?? whole
})

/**
 * Body paragraphs in reading order; a table row is one line with its cells joined by
 * tabs. Only `w:t` runs are text: deleted revisions (`w:delText`) and field codes
 * (`w:instrText`) are not what the reader of the document sees, so they stay out.
 */
export function docxParagraphs(xml: string): string[] {
  const paragraphs: string[] = []
  let current = ''
  let inText = false
  let cellDepth = 0
  const flush = () => {
    if (current.trim().length > 0) paragraphs.push(current.trim())
    current = ''
  }
  const token = /<(\/?)w:(p|t|tab|br|cr|tc|tr)\b[^>]*?(\/?)>|<[^>]*>|([^<]+)/g
  for (let match = token.exec(xml); match !== null; match = token.exec(xml)) {
    const [, closing, tag, selfClosing, content] = match
    if (content !== undefined) {
      if (inText) current += decodeXml(content)
    } else if (tag === 't') inText = closing !== '/' && selfClosing !== '/'
    else if (tag === 'tab' || tag === 'br' || tag === 'cr') current += tag === 'tab' ? '\t' : '\n'
    else if (tag === 'tc' && selfClosing !== '/') {
      if (closing === '/') {
        cellDepth = Math.max(0, cellDepth - 1)
        current = `${current.trimEnd()}\t`
      } else cellDepth += 1
    } else if (closing === '/' && tag === 'tr') flush()
    else if (closing === '/' && tag === 'p') {
      if (cellDepth > 0) current += ' '
      else flush()
    }
  }
  flush()
  return paragraphs
}
