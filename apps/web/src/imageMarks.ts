import { ImageAttachmentSchema, MAX_MESSAGE_ATTACHMENTS, numberedMarks, type ImageAnnotation, type ImageAttachment, type NumberedMark } from '@manor/contracts'

/** Pins and outlined areas on one picture, positions as shares of its size. */
export type ImageMarks = Pick<ImageAnnotation, 'pins' | 'shapes'>
export type ImagePin = ImageMarks['pins'][number]
export type ImageShape = ImageMarks['shapes'][number]

export const NO_MARKS: ImageMarks = { pins: [], shapes: [] }

/**
 * A picture staged in the composer. After the editor's Done, `dataUrl` holds the
 * picture with its marks burned in, `annotation` the marks, and `original` the
 * picture as attached, so reopening the editor starts from the unmarked one.
 */
export type DraftImage = ImageAttachment & { original?: string }

/**
 * Where a mark's number sits, as shares of the picture: on a pin itself, on a frame's
 * top left corner, on a circle's line toward the top left.
 */
export function markAnchor(mark: NumberedMark): { x: number; y: number } {
  if (mark.kind === 'pin' || mark.kind === 'frame') return { x: mark.x, y: mark.y }
  return { x: mark.x + (mark.w / 2) * (1 - Math.SQRT1_2), y: mark.y + (mark.h / 2) * (1 - Math.SQRT1_2) }
}

export const hasMarks = (marks: ImageMarks): boolean => marks.pins.length > 0 || marks.shapes.length > 0

/** Wire slots one staged picture takes: a marked one also sends its original. */
export const imageSlots = (image: DraftImage): number => (image.original === undefined ? 1 : 2)

export const stagedImageSlots = (images: readonly DraftImage[]): number =>
  images.reduce((sum, image) => sum + imageSlots(image), 0)

/** What the unmarked picture is called on the wire, beside the marked one. */
const originalName = (name: string): string => {
  const cut = name.lastIndexOf('.')
  const stem = cut <= 0 ? name : name.slice(0, cut)
  return `${stem} (original)`.slice(0, 160)
}

/**
 * The staged pictures as the wire takes them. Each marked picture keeps its place, so
 * the `[Image #n]` references in the text still count right, and its original goes at
 * the end with `annotation.original` naming where.
 */
export function wireImages(images: readonly DraftImage[]): ImageAttachment[] {
  const originals: ImageAttachment[] = []
  const placed = images.map(({ original, annotation, ...image }): ImageAttachment => {
    if (original === undefined || annotation === undefined) return image
    const index = images.length + originals.length
    originals.push({ name: originalName(image.name), dataUrl: original })
    return { ...image, annotation: { ...annotation, original: index } }
  })
  return [...placed, ...originals]
}

/**
 * The reverse of `wireImages`, for a send that comes back unsent: each original folds
 * back into its marked picture, so the tray shows one picture the editor can reopen.
 */
export function stagedFromWire(images: readonly ImageAttachment[]): DraftImage[] {
  const folded = new Set<number>()
  const staged = images.map((image): DraftImage => {
    const at = image.annotation?.original
    const original = at === undefined ? undefined : images[at]
    if (at === undefined || original === undefined || original.annotation !== undefined) return image
    folded.add(at)
    return { ...image, original: original.dataUrl }
  })
  return staged.filter((_, index) => !folded.has(index))
}

/** True when the staged pictures still fit the wire once each original is added. */
export const fitsWire = (slots: number): boolean => slots <= MAX_MESSAGE_ATTACHMENTS

/** A theme token's value, so the burned picture wears the same colours as the editor. */
const themeColour = (token: '--color-mark' | '--color-on-media'): string =>
  getComputedStyle(document.documentElement).getPropertyValue(token).trim()

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new Image()
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('This picture could not be read.'))
    image.src = src
  })

/**
 * The picture with its marks drawn into the pixels, at the picture's own size. Every
 * provider reads pixels, so this is the one form of the marks they all see. Sizes
 * follow the picture's short side, so a pin reads the same on a phone screenshot and
 * on a wide desktop one.
 */
export async function burnMarks(original: string, name: string, marks: ImageMarks): Promise<ImageAttachment> {
  const picture = await loadImage(original)
  const canvas = document.createElement('canvas')
  canvas.width = picture.naturalWidth
  canvas.height = picture.naturalHeight
  const context = canvas.getContext('2d')
  if (!context) throw new Error('This browser could not draw the marks.')
  context.drawImage(picture, 0, 0)
  const { width, height } = canvas
  const unit = Math.max(1, Math.min(width, height) / 400)
  const colour = themeColour('--color-mark')
  const ink = themeColour('--color-on-media')
  context.strokeStyle = colour
  context.lineWidth = 3 * unit
  for (const shape of marks.shapes) {
    const x = shape.x * width
    const y = shape.y * height
    const w = shape.w * width
    const h = shape.h * height
    context.beginPath()
    if (shape.kind === 'frame') context.roundRect(x, y, w, h, 6 * unit)
    else context.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2)
    context.stroke()
  }
  const radius = 12 * unit
  context.font = `500 ${Math.round(13 * unit)}px system-ui, sans-serif`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  // A number at the very edge is drawn whole, nudged inside the picture.
  const ring = Math.min(radius + 2 * unit, width / 2, height / 2)
  for (const mark of numberedMarks(marks)) {
    const anchor = markAnchor(mark)
    const x = Math.min(Math.max(anchor.x * width, ring), width - ring)
    const y = Math.min(Math.max(anchor.y * height, ring), height - ring)
    context.beginPath()
    context.arc(x, y, radius + 2 * unit, 0, Math.PI * 2)
    context.fillStyle = ink
    context.fill()
    context.beginPath()
    context.arc(x, y, radius, 0, Math.PI * 2)
    context.fillStyle = colour
    context.fill()
    context.fillStyle = ink
    context.fillText(String(mark.number), x, y + unit)
  }
  const dataUrl = canvas.toDataURL('image/webp', 0.9)
  const parsed = ImageAttachmentSchema.safeParse({ name, dataUrl, annotation: marks })
  if (!parsed.success) throw new Error(`${name} is too large to send with its marks.`)
  return parsed.data
}

/**
 * A picture from the transcript as a staged one, read back through the same shrink a
 * picked file gets. An agent's picture reaches a client as a signed link, never bytes.
 */
export async function fetchImageAttachment(src: string, name: string, shrink: (file: File) => Promise<ImageAttachment>): Promise<ImageAttachment> {
  const response = await fetch(src)
  if (!response.ok) throw new Error(`${name} could not be loaded.`)
  const blob = await response.blob()
  return shrink(new File([blob], name, { type: blob.type }))
}
