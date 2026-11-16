import { PDF_MIME, type DmFile, type DmFileKind, type ThreadEvent } from '@manor/contracts'
import { mediaPath } from './chatMedia.js'

const kindOf = (mime: string): DmFileKind =>
  mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime === PDF_MIME ? 'pdf' : 'file'

/** Type and byte size of a stored picture, read off its data URL without decoding it. */
function pictureOf(dataUrl: string): { mime: string; size: number } {
  const comma = dataUrl.indexOf(',')
  const base64 = dataUrl.length - comma - 1
  const padding = dataUrl.endsWith('==') ? 2 : dataUrl.endsWith('=') ? 1 : 0
  return { mime: dataUrl.slice('data:'.length, dataUrl.indexOf(';')), size: Math.max(0, (base64 / 4) * 3 - padding) }
}

/**
 * Every file in one DM's transcript, newest first: what the user attached (pictures, text
 * files, PDF and Word documents) and what the agent made (pictures in a reply, delivered
 * files). `documents` are the ids whose original bytes the store still holds; a document
 * or delivery outside it lists without a link, as unavailable. Each `src` is the unsigned
 * media path of the file's slot, which `ChatMedia.forClient` signs on the way out.
 */
export function listDmFiles(chatId: string, events: readonly ThreadEvent[], documents: ReadonlySet<string>): DmFile[] {
  // A delivered file sits under its turn's answer, so Show in chat lands on what the agent last said there.
  const lastSaid = new Map<string, string>()
  for (const event of events) if (event.type === 'agent_message') lastSaid.set(event.turnId, event.id)

  const perEvent: DmFile[][] = []
  for (const event of events) {
    const at = (slot: string) => ({ id: `${event.id}:${slot}`, ts: event.ts })
    const link = (slot: string) => ({ src: mediaPath(chatId, event.id, slot) })
    if (event.type === 'file_delivery') {
      const { file } = event
      const messageId = lastSaid.get(event.turnId)
      perEvent.push([{
        ...at('f0'), name: file.name, mime: file.mime, kind: kindOf(file.mime), size: file.size, agentId: event.agentId,
        ...(messageId === undefined ? {} : { messageId }),
        ...(documents.has(file.id) ? link('f0') : {}),
        ...(file.mime === 'text/html' ? { page: true as const } : {}),
      }])
      continue
    }
    if (event.type !== 'user_message' && event.type !== 'agent_message') continue
    const agentId = event.type === 'agent_message' ? event.agentId : event.authorAgentId
    const own = { messageId: event.id, ...(agentId === undefined ? {} : { agentId }) }
    const found: DmFile[] = (event.images ?? []).map((image, index) => {
      const picture = image.dataUrl === undefined ? undefined : pictureOf(image.dataUrl)
      return {
        ...at(String(index)), ...own, name: image.name, kind: 'image' as const,
        mime: picture?.mime ?? 'image/png', size: picture?.size ?? 0,
        ...(picture === undefined ? {} : link(String(index))),
      }
    })
    if (event.type === 'user_message') {
      event.files?.forEach((file, index) => found.push({
        ...at(`t${index}`), ...own, name: file.name, mime: file.mime, kind: kindOf(file.mime),
        size: Buffer.byteLength(file.content), ...link(`t${index}`),
      }))
      event.documents?.forEach((document, index) => found.push({
        ...at(`d${index}`), ...own, name: document.name, mime: document.mime, kind: kindOf(document.mime),
        size: document.size, ...(documents.has(document.id) ? link(`d${index}`) : {}),
      }))
    }
    if (found.length > 0) perEvent.push(found)
  }
  return perEvent.reverse().flat()
}
