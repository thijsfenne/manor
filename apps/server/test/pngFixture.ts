import { crc32, deflateSync } from 'node:zlib'

/** One PNG chunk: its length, type, body and CRC. */
export const chunk = (type: string, body: Buffer) => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(body.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), body])))
  return Buffer.concat([length, Buffer.from(type, 'latin1'), body, crc])
}

/**
 * A complete PNG of `rows` (raw pixel bytes, `bpp` bytes a pixel), each stored under `filter`
 * or the filters in turn, with `extra` chunks before the data. `height` may claim more rows
 * than are given, as in a file cut short.
 */
const encodePng = (
  [width, height, depth, colour]: number[],
  rows: Buffer[],
  bpp: number,
  { filter, extra = [] }: { filter?: number | undefined; extra?: Buffer[] } = {},
) => {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width!, 0)
  header.writeUInt32BE(height!, 4)
  header[8] = depth!
  header[9] = colour!
  const stored: Buffer[] = []
  let previous: Buffer = Buffer.alloc(rows[0]?.length ?? 0)
  for (const [y, current] of rows.entries()) {
    const used = filter ?? y % 5
    const out = Buffer.alloc(current.length)
    for (let i = 0; i < current.length; i++) {
      const a = i >= bpp ? current[i - bpp]! : 0
      const b = previous[i]!
      const c = i >= bpp ? previous[i - bpp]! : 0
      const p = a + b - c
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c
      out[i] = (current[i]! - [0, a, b, (a + b) >> 1, paeth][used]!) & 0xff
    }
    stored.push(Buffer.from([used]), out)
    previous = current
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    ...extra,
    chunk('IDAT', deflateSync(Buffer.concat(stored))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * A complete PNG, transparent except for a solid block `margins` pixels in from each edge
 * (top, right, bottom, left). Alpha is noisy on both sides of half and the rows are stored
 * under `filter` (each in turn when absent), so a wrong unfilter misreads it. `missing`
 * rows are left out of the stream, as in a file cut short; `accent` adds one solid pixel
 * at that x, y.
 */
export const framedPng = (
  side: number,
  [top, right, bottom, left]: number[],
  { format = 'rgba', missing = 0, filter, accent }: { format?: 'rgba' | 'rgba16' | 'palette' | 'palette4'; missing?: number; filter?: number; accent?: [number, number] } = {},
) => {
  const solid = (x: number, y: number) =>
    (x >= left! && x < side - right! && y >= top! && y < side - bottom!) || (accent !== undefined && x === accent[0] && y === accent[1])
  const alpha = (x: number, y: number) => (solid(x, y) ? 128 + ((x * 7 + y * 13) % 128) : (x * 5 + y * 3) % 100)
  const row = (y: number) => {
    if (format === 'palette4') {
      // Two pixels a byte, the first in the high half.
      return Buffer.from(Array.from({ length: Math.ceil(side / 2) }, (_, i) => ((solid(2 * i, y) ? 1 : 0) << 4) | (solid(2 * i + 1, y) ? 1 : 0)))
    }
    return Buffer.from(Array.from({ length: side }, (_, x) =>
      format === 'palette' ? [solid(x, y) ? 1 : 0] : format === 'rgba16' ? [255, 0, 255, 0, 255, 0, alpha(x, y), (x * 3) & 0xff] : [255, 255, 255, alpha(x, y)]).flat())
  }
  const palette = format.startsWith('palette')
  return encodePng(
    [side, side, format === 'rgba16' ? 16 : format === 'palette4' ? 4 : 8, palette ? 3 : 6],
    Array.from({ length: side - missing }, (_, y) => row(y)),
    format === 'rgba16' ? 8 : format === 'rgba' ? 4 : 1,
    { filter, extra: palette ? [chunk('PLTE', Buffer.from([0, 0, 0, 255, 255, 255])), chunk('tRNS', Buffer.from([0, 255]))] : [] },
  )
}

/**
 * A complete RGB PNG, `side` square: a grey plate with corners rounded by `radius` pixels on
 * a near-black square, `margin` pixels in from each edge. `square` corners (0 to 3, from the
 * top left clockwise) stay sharp, `panels` cuts each corner square instead, `below` adds
 * near-black rows under it, and `keyed` marks the near-black as transparent.
 */
export const platePng = (
  side: number,
  radius: number,
  { margin = 0, square = [], panels = false, below = 0, keyed = false }: { margin?: number; square?: number[]; panels?: boolean; below?: number; keyed?: boolean } = {},
) => {
  const onPlate = (x: number, y: number) => {
    const [px, py] = [x + 0.5, y + 0.5]
    if (px < margin || py < margin || px > side - margin || py > side - margin) return false
    const corner = (px < side / 2 ? 0 : 1) + (py < side / 2 ? 0 : 2)
    if (square.includes([0, 1, 3, 2][corner]!)) return true
    const [cx, cy] = [Math.min(Math.max(px, margin + radius), side - margin - radius), Math.min(Math.max(py, margin + radius), side - margin - radius)]
    return panels ? cx === px || cy === py : Math.hypot(px - cx, py - cy) <= radius
  }
  const rows = Array.from({ length: side + below }, (_, y) =>
    Buffer.from(Array.from({ length: side }, (_, x) => (y < side && onPlate(x, y) ? [40 + (x % 9), 42, 44] : [10, 10, 10])).flat()))
  return encodePng([side, side + below, 8, 2], rows, 3, { extra: keyed ? [chunk('tRNS', Buffer.from([0, 10, 0, 10, 0, 10]))] : [] })
}
