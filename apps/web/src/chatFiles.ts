import { DocumentUploadSchema, FileAttachmentSchema, MAX_DOCUMENT_BYTES, MAX_TEXT_FILE_BYTES, type DocumentUpload, type FileAttachment, type ImageAttachment } from '@manor/contracts'
import { DOCUMENT_FILE_EXTENSIONS, TEXT_FILE_EXTENSIONS, documentMime, documentTooLarge, textFileMime, utf8Size } from '@manor/client-runtime/attachments'
import { CHAT_IMAGE_ACCEPT, shrinkChatImage } from './chatImages'

/**
 * What the attach picker offers: pictures, plus the text formats a persona can
 * actually read. Extensions as well as types, because the same `.md` arrives as
 * `text/markdown` from Finder and as nothing at all from a download folder, and a
 * picker that greys out the file someone came for is worse than one that lets a
 * refusal happen a beat later with a reason.
 */
export const CHAT_ATTACH_ACCEPT = [CHAT_IMAGE_ACCEPT, ...TEXT_FILE_EXTENSIONS, ...DOCUMENT_FILE_EXTENSIONS].join(',')

export const isImageFile = (file: File) => file.type.startsWith('image/')

/** True for anything this composer will take at all: image, text, PDF or Word. */
export const isAttachable = (file: File) =>
  isImageFile(file) || textFileMime(file.name, file.type) !== null || documentMime(file.name, file.type) !== null

/**
 * A PDF or Word file as its original bytes. The server extracts the text, so all
 * this checks is what the wire checks: type, size and name.
 */
export async function readChatDocument(file: File): Promise<DocumentUpload> {
  const mime = documentMime(file.name, file.type)
  if (mime === null) throw new Error(`${file.name} is not a PDF or Word file.`)
  if (file.size > MAX_DOCUMENT_BYTES) throw new Error(documentTooLarge(file.name))
  const bytes = new Uint8Array(await file.arrayBuffer())
  // Chunked, because spreading megabytes into one `fromCharCode` call overflows the stack.
  let binary = ''
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000))
  const parsed = DocumentUploadSchema.safeParse({ name: file.name || 'document', mime, data: btoa(binary) })
  if (!parsed.success) throw new Error(`${file.name} cannot be attached: ${parsed.error.issues[0]?.message ?? 'the wire refused it'}.`)
  return parsed.data
}

/**
 * One text file as it goes on the wire. Rejects before reading where the size
 * already rules it out, so a 40 MB log is refused instantly rather than after the
 * browser has pulled it into memory.
 *
 * The wire's own schema has the last word, because everything it refuses the server
 * refuses by dropping the whole message without a word: a name past 160 characters
 * would otherwise sit in the composer looking attached and take the send with it.
 * Refusing here costs one file and says so; refusing there costs the message.
 */
export async function readChatFile(file: File): Promise<FileAttachment> {
  const mime = textFileMime(file.name, file.type)
  if (mime === null) throw new Error(`${file.name} is not a text file Manor can attach.`)
  if (file.size > MAX_TEXT_FILE_BYTES) throw new Error(`${file.name} is larger than ${Math.round(MAX_TEXT_FILE_BYTES / 1024)} KB.`)
  const content = await file.text()
  if (utf8Size(content) > MAX_TEXT_FILE_BYTES) {
    throw new Error(`${file.name} is larger than ${Math.round(MAX_TEXT_FILE_BYTES / 1024)} KB.`)
  }
  const parsed = FileAttachmentSchema.safeParse({ name: file.name || 'file', mime, content })
  if (!parsed.success) throw new Error(`${file.name} cannot be attached: ${parsed.error.issues[0]?.message ?? 'the wire refused it'}.`)
  return parsed.data
}

/** What one drop, paste or pick turned into. */
export interface AttachmentRead {
  images: ImageAttachment[]
  files: FileAttachment[]
  documents: DocumentUpload[]
  /** What went wrong, in the order it happened. The composer says the first one. */
  problems: string[]
  /**
   * How many of the slots reserved for this batch nothing ended up using, because
   * the file could not be read. The caller holds the count; this only reports.
   */
  slotsFreed: number
}

/**
 * Reads a batch of picked files into what the wire takes. Deliberately outside the
 * composer and deliberately ignorant of it: this is the slow half of attaching, and
 * whether its result is still wanted by the time it lands is a question about the
 * draft, which only the composer can answer.
 */
export async function readAttachments(picked: readonly File[]): Promise<AttachmentRead> {
  const images: ImageAttachment[] = []
  const files: FileAttachment[] = []
  const documents: DocumentUpload[] = []
  const problems: string[] = []
  let slotsFreed = 0
  for (const file of picked) {
    try {
      if (isImageFile(file)) images.push(await shrinkChatImage(file))
      else if (documentMime(file.name, file.type) !== null) documents.push(await readChatDocument(file))
      else files.push(await readChatFile(file))
    } catch (error) {
      slotsFreed += 1
      problems.push((error as Error).message)
    }
  }
  return { images, files, documents, problems, slotsFreed }
}
