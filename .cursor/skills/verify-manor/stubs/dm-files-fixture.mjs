#!/usr/bin/env node
// Writes the files a DM's file library is verified with: pictures, a two-page PDF,
// markdown, an HTML page, a data file and, when ffmpeg is installed, a short video.
// Usage: node stubs/dm-files-fixture.mjs /tmp/<folder>
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'

const out = resolve(process.argv[2] ?? '')
if (!out.startsWith('/tmp/') && !out.startsWith(`${realpathSync('/tmp')}/`)) {
  console.error('Pass a folder under /tmp.')
  process.exit(1)
}
mkdirSync(out, { recursive: true })
const write = (name, body) => writeFileSync(join(out, name), body)

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data])
  let crc = 0xffffffff
  for (const byte of body) crc = CRC[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  return Buffer.concat([head, body, tail])
}

// A diagonal blend between two colours with a soft disc on it, so thumbnails differ.
function picture(width, height, from, to, disc) {
  const rows = Buffer.alloc((width * 3 + 1) * height)
  const radius = Math.min(width, height) * 0.22
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1)
    for (let x = 0; x < width; x += 1) {
      const t = (x / width + y / height) / 2
      const inDisc = Math.hypot(x - width * 0.68, y - height * 0.38) < radius
      for (let c = 0; c < 3; c += 1) {
        rows[row + 1 + x * 3 + c] = inDisc ? disc[c] : Math.round(from[c] + (to[c] - from[c]) * t)
      }
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const PICTURES = {
  'moodboard.png': [1200, 800, [43, 58, 103], [232, 168, 124], [246, 236, 214]],
  'garden-sketch.png': [900, 1200, [31, 78, 61], [242, 233, 220], [226, 149, 84]],
  'cover-idea.png': [1200, 675, [122, 59, 105], [245, 195, 107], [45, 106, 142]],
  'logo-draft.png': [800, 800, [253, 246, 227], [217, 83, 79], [36, 41, 51]],
  'receipt-photo.png': [1000, 700, [11, 19, 43], [91, 192, 190], [250, 250, 245]],
  'floor-plan.png': [1280, 720, [226, 232, 240], [100, 116, 139], [239, 68, 68]],
  'colour-test.png': [1000, 1000, [15, 118, 110], [253, 224, 71], [30, 27, 75]],
}
for (const [name, args] of Object.entries(PICTURES)) write(name, picture(...args))

function pdf(pages) {
  const objects = []
  const add = (body) => objects.push(body)
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>')
  const pagesId = objects.length + 2 * pages.length + 1
  const kids = []
  for (const [title, ...lines] of pages) {
    const text = ['BT', '/F2 20 Tf', '72 760 Td', `(${title}) Tj`, '/F1 12 Tf', ...lines.flatMap((line) => ['0 -22 Td', `(${line}) Tj`]), 'ET'].join('\n')
    const content = add(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`)
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Contents ${content} 0 R /Resources << /Font << /F1 1 0 R /F2 2 0 R >> >> >>`))
  }
  add(`<< /Type /Pages /Kids [${kids.map((kid) => `${kid} 0 R`).join(' ')}] /Count ${kids.length} >>`)
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`)
  let file = '%PDF-1.4\n'
  const offsets = objects.map((body, index) => {
    const at = file.length
    file += `${index + 1} 0 obj\n${body}\nendobj\n`
    return at
  })
  const xref = file.length
  file += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}`
  return `${file}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
}

write('invoice-kitchen.pdf', pdf([
  ['Invoice 2026-031', '', 'Kitchen renovation, first instalment', '', 'Cabinet fronts, oak veneer        2 400,00', 'Worktop, composite, 3.2 m         1 150,00', 'Fitting, two days                   960,00', '', 'Total excl. VAT                   4 510,00'],
  ['Terms', '', 'Payment within 14 days of the invoice date.', 'Delivery of the fronts is planned for week 49.', 'Questions go to the workshop, not the showroom.'],
]))
write('contract-draft.pdf', pdf([['Contract draft', '', 'Scope, planning and payment in three parts.'], ['Annex', '', 'Drawings and the list of materials.']]))
write('trip-notes.md', '# Trip notes\n\nThree days in Lisbon, mostly on foot.\n\n## Day one\n\n- Arrive before noon, drop the bags at the flat.\n- Walk up to the viewpoint for the late light.\n\n## Day two\n\n| When | What |\n|---|---|\n| Morning | Tile museum |\n| Afternoon | Tram 28, then the market |\n\n> Book the dinner place a week ahead.\n')
write('packing-list.md', '# Packing list\n\n- Passport\n- Charger\n- Rain jacket\n')
write('measurements.csv', 'wall,width_cm,height_cm\nnorth,412,260\neast,298,260\nsouth,412,260\n')
write('budget-overview.html', "<!doctype html><meta charset='utf-8'><title>Budget overview</title><style>body{font:15px/1.5 system-ui;margin:32px;color:#222}h1{font-weight:500}table{border-collapse:collapse;width:100%}td,th{padding:8px 12px;border-bottom:1px solid #ddd;text-align:left}td:last-child,th:last-child{text-align:right}</style><h1>Budget overview</h1><table><tr><th>Post</th><th>Amount</th></tr><tr><td>Cabinet fronts</td><td>2 400</td></tr><tr><td>Worktop</td><td>1 150</td></tr><tr><td>Fitting</td><td>960</td></tr><tr><th>Total</th><th>4 510</th></tr></table>")

let video = false
try {
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=24:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', join(out, 'walkthrough.mp4')])
  video = true
} catch {
  // No ffmpeg on this machine: the library is verified without a video.
}
console.log(JSON.stringify({ ok: true, dir: out, video }))
