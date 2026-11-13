import { strToU8, zipSync } from 'fflate'

/** A real PDF: one page per entry, a string draws that text, null leaves the page without a text layer. */
export function pdfFixture(pages: readonly (string | null)[]): Uint8Array {
  const objects: string[] = []
  const add = (body: string) => objects.push(body)
  add('<< /Type /Catalog /Pages 2 0 R >>')
  const kids = pages.map((_, index) => `${4 + index * 2} 0 R`).join(' ')
  add(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`)
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  for (const [index, text] of pages.entries()) {
    const stream = text === null ? '' : `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + index * 2} 0 R >>`)
    add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  }
  let out = '%PDF-1.4\n'
  const offsets = objects.map((body, index) => {
    const offset = out.length
    out += `${index + 1} 0 obj\n${body}\nendobj\n`
    return offset
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

export function docxFixture(body: string, extra: Record<string, string> = {}): Uint8Array {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
    'word/document.xml': strToU8(`<?xml version="1.0"?><w:document xmlns:w="w"><w:body>${body}</w:body></w:document>`),
  }
  for (const [name, content] of Object.entries(extra)) files[name] = strToU8(content)
  return zipSync(files)
}
