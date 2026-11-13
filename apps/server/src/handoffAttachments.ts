import path from 'node:path'
import {
  FileAttachmentSchema,
  ImageAttachmentSchema,
  MAX_MESSAGE_ATTACHMENTS,
  MAX_TEXT_FILE_BYTES,
  type FileAttachment,
  type ImageAttachment,
  type ThreadEvent,
  type WorkAttachment,
} from '@manor/contracts'
import type { Store } from './store.js'

/**
 * Images and files a handoff carries (2026-10-14). `start_work` names them; Manor finds
 * each in the conversation's own record, so a scratch folder cleaned up later loses
 * nothing, and copies the bytes onto the kickoff message in the next room as ordinary
 * message attachments. Every refusal is written for the author, who corrects the call.
 */

/** What lands on a kickoff message, in the order the author named them. */
export interface HandoffAttachmentContent {
  images: ImageAttachment[]
  files: FileAttachment[]
}

type Loaded = { image: ImageAttachment } | { file: FileAttachment }

/** How `materialiseImages` names a message's picture on disk: `<eventId>-<index>.<ext>`. */
const MATERIALISED_IMAGE = /^(.+)-(\d+)\.(?:png|jpg|webp)$/
/** The pictures a provider CLI can open; `materialiseImages` skips the rest. */
const RASTER_MIME = /^image\/(?:png|jpeg|webp)$/
const RASTER_DATA_URL = /^data:image\/(?:png|jpeg|webp);/
/** The longest data URL a message image may hold, as raw bytes. */
const MAX_IMAGE_BYTES = Math.floor((ImageAttachmentSchema.shape.dataUrl.maxLength ?? 2_000_000) * 3 / 4) - 64

const megabytes = (bytes: number): string => `${(bytes / 1_024 / 1_024).toFixed(1)} MB`
const SUPPORTED = 'A handoff carries PNG, JPEG or WebP images and text files such as HTML, Markdown, CSV or JSON.'

/** A message's picture, refused when the receiving model could not open it. */
function messageImage(chatId: string, event: ThreadEvent, index: number): WorkAttachment | undefined {
  const image = event.type === 'user_message' || event.type === 'agent_message' ? event.images?.[index] : undefined
  if (image?.dataUrl === undefined) return undefined
  if (!RASTER_DATA_URL.test(image.dataUrl)) throw new Error(`${JSON.stringify(image.name)} is not a PNG, JPEG or WebP picture. ${SUPPORTED}`)
  return { name: image.name, kind: 'image', chatId, eventId: event.id, index }
}

/** One reference from `start_work`, found in the chat it was proposed in. */
function find(chatId: string, events: readonly ThreadEvent[], reference: string): WorkAttachment {
  const base = path.basename(reference)
  const picture = MATERIALISED_IMAGE.exec(base)
  if (picture !== null) {
    const event = events.find((row) => row.id === picture[1])
    const image = event === undefined ? undefined : messageImage(chatId, event, Number(picture[2]))
    if (image !== undefined) return image
  }
  const named = (name: string) => name === reference || name === base
  // Newest first: a file delivered again under the same name is its current version.
  for (const event of [...events].reverse()) {
    if (event.type === 'file_delivery' && named(event.file.name)) {
      const { file } = event
      const kind = RASTER_MIME.test(file.mime) ? 'image' : FileAttachmentSchema.shape.mime.safeParse(file.mime).success ? 'file' : undefined
      if (kind === undefined) throw new Error(`${JSON.stringify(file.name)} is a ${file.mime} file. ${SUPPORTED}`)
      return { name: file.name, kind, chatId, eventId: event.id }
    }
    if (event.type !== 'user_message') continue
    const fileIndex = (event.files ?? []).findIndex((file) => named(file.name))
    const file = event.files?.[fileIndex]
    if (file !== undefined) {
      return { name: file.name, kind: 'file', chatId, eventId: event.id, index: fileIndex }
    }
    const image = messageImage(chatId, event, (event.images ?? []).findIndex((candidate) => named(candidate.name)))
    if (image !== undefined) return image
    if ((event.documents ?? []).some((document) => named(document.name))) {
      throw new Error(`${JSON.stringify(base)} is a PDF or Word file, which a handoff cannot carry. Put what the Session needs from it in task.`)
    }
  }
  throw new Error(`Nothing in this conversation matches ${JSON.stringify(reference)}. Name an image by the path Manor gave you under attachments/, or a file by the name the user attached it under or you delivered it as.`)
}

/**
 * Resolves `start_work`'s references, after any `inherited` from a forwarded brief, and
 * proves each still opens and fits a message, so a refusal reaches the author now rather
 * than the user at Accept. The same bytes named twice, also a brief's picture the thread
 * attaches again from its own copy, go along once.
 */
export async function resolveHandoffAttachments(
  store: Store,
  chatId: string,
  references: readonly string[],
  inherited: readonly WorkAttachment[] = [],
): Promise<WorkAttachment[]> {
  const named = [...inherited]
  if (references.length > 0) {
    const events = await store.loadEvents(chatId)
    named.push(...references.map((reference) => find(chatId, events, reference.trim())))
  }
  const loaded = await loadEach(store, named)
  const resolved = named.filter((_, index) => loaded.findIndex((other) => JSON.stringify(other) === JSON.stringify(loaded[index])) === index)
  if (resolved.length > MAX_MESSAGE_ATTACHMENTS) {
    throw new Error(`A handoff carries at most ${MAX_MESSAGE_ATTACHMENTS} images and files together; this one names ${resolved.length}.`)
  }
  return resolved
}

/** Reads each attachment's bytes from the chat that holds them, as message attachments. */
export async function loadHandoffAttachments(store: Store, attachments: readonly WorkAttachment[]): Promise<HandoffAttachmentContent> {
  const content: HandoffAttachmentContent = { images: [], files: [] }
  for (const loaded of await loadEach(store, attachments)) {
    if ('image' in loaded) content.images.push(loaded.image)
    else content.files.push(loaded.file)
  }
  return content
}

async function loadEach(store: Store, attachments: readonly WorkAttachment[]): Promise<Loaded[]> {
  const transcripts = new Map<string, readonly ThreadEvent[]>()
  const loaded: Loaded[] = []
  for (const attachment of attachments) {
    let events = transcripts.get(attachment.chatId)
    if (events === undefined) {
      events = await store.loadEvents(attachment.chatId).catch(() => [])
      transcripts.set(attachment.chatId, events)
    }
    loaded.push(await loadOne(store, attachment, events))
  }
  return loaded
}

async function loadOne(store: Store, attachment: WorkAttachment, events: readonly ThreadEvent[]): Promise<Loaded> {
  const gone = () => new Error(`${JSON.stringify(attachment.name)} is no longer in the conversation it came from.`)
  const event = events.find((row) => row.id === attachment.eventId)
  if (event === undefined) throw gone()
  if (event.type === 'file_delivery') {
    const bytes = await store.loadDocument(attachment.chatId, event.file.id)
    if (bytes === undefined) throw gone()
    if (attachment.kind === 'image') {
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        throw new Error(`${JSON.stringify(attachment.name)} is ${megabytes(bytes.byteLength)}; a handoff image may be at most ${megabytes(MAX_IMAGE_BYTES)}.`)
      }
      return { image: ImageAttachmentSchema.parse({ name: attachment.name, dataUrl: `data:${event.file.mime};base64,${Buffer.from(bytes).toString('base64')}` }) }
    }
    if (bytes.byteLength > MAX_TEXT_FILE_BYTES) {
      throw new Error(`${JSON.stringify(attachment.name)} is ${Math.ceil(bytes.byteLength / 1_024)} KB; a handoff text file may be at most ${MAX_TEXT_FILE_BYTES / 1_024} KB.`)
    }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new Error(`${JSON.stringify(attachment.name)} is not UTF-8 text. ${SUPPORTED}`)
    }
    return { file: FileAttachmentSchema.parse({ name: attachment.name, mime: event.file.mime, content: text }) }
  }
  if (attachment.kind === 'image') {
    const image = event.type === 'user_message' || event.type === 'agent_message' ? event.images?.[attachment.index ?? -1] : undefined
    if (image?.dataUrl === undefined) throw gone()
    return { image: { name: image.name, dataUrl: image.dataUrl } }
  }
  const file = event.type === 'user_message' ? event.files?.[attachment.index ?? -1] : undefined
  if (file === undefined) throw gone()
  return { file }
}

/** The kickoff fields for `content`, empty lists left out. */
export const attachmentFields = (content: HandoffAttachmentContent | undefined): Partial<HandoffAttachmentContent> => ({
  ...(content === undefined || content.images.length === 0 ? {} : { images: content.images }),
  ...(content === undefined || content.files.length === 0 ? {} : { files: content.files }),
})
