import { ImageAttachmentSchema, type ImageAttachment } from '@manor/contracts'

/**
 * What the attach picker offers. Narrower than what a paste can carry on purpose:
 * these three are the formats `shrinkChatImage` re-encodes without surprises.
 */
export const CHAT_IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp'

export async function shrinkChatImage(file: File): Promise<ImageAttachment> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  try {
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('This browser could not prepare the image.')
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const dataUrl = canvas.toDataURL('image/webp', 0.82)
    if (dataUrl.length > 2_000_000) throw new Error(`${file.name} is still too large after resizing.`)
    // The wire's own schema decides, for the same reason the text picker asks it: a
    // name it refuses (past 160 characters) would take the whole message down with
    // it, silently, long after the picture looked attached.
    const parsed = ImageAttachmentSchema.safeParse({ name: file.name || 'image', dataUrl })
    if (!parsed.success) throw new Error(`${file.name} cannot be attached: ${parsed.error.issues[0]?.message ?? 'the wire refused it'}.`)
    return parsed.data
  } finally {
    bitmap.close()
  }
}
