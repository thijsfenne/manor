import { DOCX_MIME, MAX_DOCUMENT_BYTES, PDF_MIME, type DocumentMime, type DocumentUpload, type FileAttachment, type ImageAttachment } from '@manor/contracts'

/**
 * Which files a composer may take, on both clients.
 *
 * The wire takes text, raster images, and PDF or Word originals the server extracts,
 * so the question every picker, drop and paste has to answer first is "which of
 * those is this file, and under what type does it go out". A browser and iOS
 * disagree about that far more than they agree: Finder reports `text/markdown` for
 * a `.md`, iOS Files reports `application/octet-stream` for the same bytes, and a
 * `.ts` gets `video/mp2t` from both because MPEG transport streams got the extension
 * first. So the extension is
 * the primary source and the reported type is only the fallback — the reverse of what
 * a browser API would suggest, and the reason this lives in one place.
 */

/** What a composer hands its send callback: everything staged on one message. */
export interface ComposerAttachments {
  images: ImageAttachment[]
  files: FileAttachment[]
  documents: DocumentUpload[]
}

/**
 * A file staged on a phone draft: text the app already read, or a PDF or Word
 * original. One list, so a draft and its screens track one set of chips; the send
 * splits it into the two wire fields.
 */
export type StagedFile = FileAttachment | DocumentUpload

export const isDocumentUpload = (file: StagedFile): file is DocumentUpload => 'data' in file

export function splitStagedFiles(staged: readonly StagedFile[]): { files: FileAttachment[]; documents: DocumentUpload[] } {
  return {
    files: staged.filter((file): file is FileAttachment => !isDocumentUpload(file)),
    documents: staged.filter(isDocumentUpload),
  }
}

/** What the server's contract allows through, restated for the picker's sake. */
const TEXT_MIME = /^(text\/[a-z0-9!#$&^_.+-]+|application\/(?:[a-z0-9!#$&^_.+-]+\+)?(?:json|xml)|application\/(?:x-)?(?:yaml|toml|javascript))$/i

/**
 * Extension to the type it goes out as. Only formats whose standard type survives the
 * contract's regex keep it; everything else is `text/plain`, which is the honest label
 * for a file whose bytes a persona reads as prose anyway. The list is the offer, not a
 * guess: an extension missing here is refused rather than sent as unknown text.
 */
const EXTENSION_MIME: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  mdx: 'text/markdown',
  txt: 'text/plain',
  text: 'text/plain',
  log: 'text/plain',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  jsonl: 'text/plain',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  toml: 'application/toml',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  ts: 'text/plain',
  tsx: 'text/plain',
  jsx: 'text/plain',
  py: 'text/plain',
  rb: 'text/plain',
  go: 'text/plain',
  rs: 'text/plain',
  java: 'text/plain',
  kt: 'text/plain',
  swift: 'text/plain',
  sh: 'text/plain',
  zsh: 'text/plain',
  sql: 'text/plain',
  c: 'text/plain',
  h: 'text/plain',
  cpp: 'text/plain',
  php: 'text/plain',
  ini: 'text/plain',
  conf: 'text/plain',
  srt: 'text/plain',
  vtt: 'text/plain',
}

/** Every extension the pickers offer, dot-prefixed, for a file input's `accept`. */
export const TEXT_FILE_EXTENSIONS = Object.keys(EXTENSION_MIME).map((extension) => `.${extension}`)

/**
 * The type this file goes out as, or null when it is not a text file Manor takes.
 * `reported` is what the platform claimed, believed only when the extension says
 * nothing and the claim itself is text-like.
 */
export function textFileMime(name: string, reported?: string): string | null {
  const cut = name.lastIndexOf('.')
  const extension = cut === -1 ? '' : name.slice(cut + 1).toLowerCase()
  const known = EXTENSION_MIME[extension]
  if (known !== undefined) return known
  if (reported !== undefined && TEXT_MIME.test(reported)) return reported
  return null
}

/**
 * PDF and Word files, which a composer sends as their original bytes for the server
 * to extract. Same rule as text: the extension first, the reported type only when
 * the extension says nothing, because iOS Files reports a `.docx` as octet-stream.
 */
const DOCUMENT_EXTENSION_MIME: Record<string, DocumentMime> = { pdf: PDF_MIME, docx: DOCX_MIME }

export const DOCUMENT_FILE_EXTENSIONS = Object.keys(DOCUMENT_EXTENSION_MIME).map((extension) => `.${extension}`)

/** The document type this file goes out as, or null when it is not a PDF or Word file. */
export function documentMime(name: string, reported?: string): DocumentMime | null {
  const cut = name.lastIndexOf('.')
  const known = DOCUMENT_EXTENSION_MIME[cut === -1 ? '' : name.slice(cut + 1).toLowerCase()]
  if (known !== undefined) return known
  return reported === PDF_MIME || reported === DOCX_MIME ? reported : null
}

/** The original size of a staged document, read off its base64 without decoding it. */
export const base64Bytes = (data: string): number =>
  Math.floor((data.length * 3) / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0)

/** What a composer says under a document it cannot take, shared by both clients. */
export const documentTooLarge = (name: string) => `${name} is larger than ${MAX_DOCUMENT_BYTES / 1_024 / 1_024} MB.`

/**
 * How many bytes this text is on the wire. Counted rather than taken from
 * `String.length`, which is UTF-16 code units: a chip on a Dutch note with a few
 * emoji in it would otherwise under-report the size the server caps.
 */
export function utf8Size(value: string): number {
  let bytes = 0
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code <= 0x7f) bytes += 1
    else if (code <= 0x7ff) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

/** A rounded size for a chip, in the units someone reads a file size in. */
export function describeBytes(bytes: number): string {
  if (bytes < 1_000) return `${bytes} B`
  if (bytes < 1_000_000) return `${Math.round(bytes / 100) / 10} KB`
  return `${Math.round(bytes / 100_000) / 10} MB`
}
