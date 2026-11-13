import { describe, expect, it } from 'vitest'
import { DocumentUploadSchema, FileAttachmentSchema } from '@manor/contracts'
import { DOCUMENT_FILE_EXTENSIONS, TEXT_FILE_EXTENSIONS, base64Bytes, describeBytes, documentMime, textFileMime } from './attachments'

/**
 * The one rule this module exists for: whatever it hands back has to pass the wire's
 * own check. A type the picker invents that the server then refuses would fail after
 * the file was read and shown as attached, which is the worst place to find out.
 */
describe('the text file type a composer sends', () => {
  it('is one the contract accepts, for every extension offered', () => {
    for (const extension of TEXT_FILE_EXTENSIONS) {
      const mime = textFileMime(`notes${extension}`)
      expect(mime, extension).not.toBeNull()
      expect(FileAttachmentSchema.safeParse({ name: `notes${extension}`, mime, content: 'x' }).success, extension).toBe(true)
    }
  })

  it('reads the extension over what the platform claims', () => {
    // iOS Files hands a markdown file over as a binary blob, and a `.ts` is a video
    // to every mime table that predates TypeScript.
    expect(textFileMime('brief.md', 'application/octet-stream')).toBe('text/markdown')
    expect(textFileMime('state.ts', 'video/mp2t')).toBe('text/plain')
  })

  it('believes a text-like claim only where the extension says nothing', () => {
    expect(textFileMime('LICENSE', 'text/plain')).toBe('text/plain')
    expect(textFileMime('archive', 'application/zip')).toBeNull()
    expect(textFileMime('shot.png', 'image/png')).toBeNull()
  })

  it('reads a size the way a person does', () => {
    expect(describeBytes(640)).toBe('640 B')
    expect(describeBytes(12_400)).toBe('12.4 KB')
    expect(describeBytes(1_240_000)).toBe('1.2 MB')
  })
})

describe('the document type a composer sends', () => {
  it('is one the contract accepts, and the extension wins over an octet-stream claim', () => {
    for (const extension of DOCUMENT_FILE_EXTENSIONS) {
      const mime = documentMime(`brief${extension}`, 'application/octet-stream')
      expect(DocumentUploadSchema.safeParse({ name: `brief${extension}`, mime, data: 'JVBERg==' }).success, extension).toBe(true)
    }
    expect(documentMime('scan', 'application/pdf')).toBe('application/pdf')
    expect(documentMime('sheet.xlsx')).toBeNull()
    expect(documentMime('notes.md')).toBeNull()
  })

  it('knows a staged document’s size from its base64', () => {
    expect(base64Bytes(btoa('%PDF-1'))).toBe(6)
    expect(base64Bytes(btoa('%PDF'))).toBe(4)
    expect(base64Bytes(btoa('%PD'))).toBe(3)
  })
})
