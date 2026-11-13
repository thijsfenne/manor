/**
 * Turning a file off someone's disk into a persona's portrait.
 *
 * The roster rides the wire to every client on every change, so the picture is
 * shrunk here rather than sent as picked: a 4MB photo would land on every open
 * tab every time any persona is edited. 128px square is what the UI actually
 * draws at (a 44px preview on a 2x screen and nothing larger), and WebP at that
 * size is a few kilobytes, so the whole roster stays smaller than one snapshot.
 *
 * The server caps what it accepts and answers anything over the cap with a
 * notice; that cap is the contract, this is the client keeping its side of it.
 */

/** Longest edge of the stored portrait. Nothing in the UI draws bigger than this. */
export const AVATAR_PX = 128

/** The server's hard cap on the data URI, in characters. Kept in step with it. */
export const AVATAR_MAX_CHARS = 96_000

/** What the file input offers, and what the server will accept back. */
export const AVATAR_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/avif,image/heic'

/**
 * Tried in order until one lands under the cap. Everything real gets in at the
 * first step; the ladder exists for the pathological case (a 128px square of
 * pure noise), so a bad picture degrades instead of being refused.
 */
const QUALITY = [0.82, 0.68, 0.5]

/**
 * WebP first, as the contract's preferred format. A browser without a WebP
 * encoder quietly hands back a PNG from toDataURL instead of failing, which is
 * how that fallback is detected below.
 */
const TYPES = ['image/webp', 'image/jpeg'] as const

/**
 * Draws the file square from the centre, at most AVATAR_PX across, and returns it
 * as a `data:image/…;base64,` URI. Rejects with a sentence the dialog can show.
 */
export async function shrinkToAvatar(file: File): Promise<string> {
  const bitmap = await readBitmap(file)
  try {
    const side = Math.min(bitmap.width, bitmap.height)
    if (side === 0) throw new Error('That file has no picture in it.')
    // Never upscaled: a 48px source stays 48px rather than being blown up soft.
    const size = Math.min(AVATAR_PX, side)
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const context = canvas.getContext('2d')
    if (context === null) throw new Error('This browser would not draw the picture.')
    // The centre square of whatever shape was picked; faces sit in the middle of
    // a portrait far more often than in a corner.
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      size,
      size,
    )

    for (const type of TYPES) {
      for (const quality of QUALITY) {
        const uri = canvas.toDataURL(type, quality)
        // No encoder for this type: the canvas fell back to PNG, so quality did
        // nothing and the next quality step would return the same bytes again.
        if (!uri.startsWith(`data:${type}`)) break
        if (uri.length <= AVATAR_MAX_CHARS) return uri
      }
    }
    throw new Error('Could not get that picture small enough. Try a simpler one.')
  } finally {
    bitmap.close()
  }
}

/**
 * `imageOrientation` is what keeps a phone photo from arriving on its side; the
 * EXIF rotation is not in the pixels. A file the decoder cannot read throws a
 * DOMException with no useful text, so it is restated here.
 */
async function readBitmap(file: File) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    throw new Error(`Could not read ${file.name || 'that file'} as a picture.`)
  }
}
