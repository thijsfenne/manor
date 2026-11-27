import { describe, expect, it } from 'vitest'
import {
  attachments,
  gmailThreadIdForImap,
  gmailThreadUrl,
  headerValue,
  htmlToText,
  mailEnvKeys,
  mailEnvPrefix,
  recipient,
  replyHeadersFor,
  stripQuotes,
  textNode,
} from '../src/mcp/mailMcp.js'

/** The real shape of the reply that read as empty and was not: text, html, one .docx. */
const replyWithDocx = {
  type: 'multipart/mixed',
  childNodes: [
    {
      part: '1',
      type: 'multipart/alternative',
      childNodes: [
        { part: '1.1', type: 'text/plain', parameters: { charset: 'us-ascii' }, size: 1413 },
        { part: '1.2', type: 'text/html', parameters: { charset: 'us-ascii' }, size: 4695 },
      ],
    },
    {
      part: '2',
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      parameters: { name: 'afmetingen posters.docx' },
      disposition: 'attachment',
      dispositionParameters: { filename: 'afmetingen posters.docx' },
      size: 1_936_852,
    },
  ],
} as never

describe('mailEnvPrefix', () => {
  it('defaults to the personal mailbox when the flag is absent', () => {
    expect(mailEnvPrefix(['node', 'mailMcp.ts'])).toBe('MANOR_MAIL')
  })

  it('reads the prefix that distinguishes a second mailbox', () => {
    expect(mailEnvPrefix(['node', 'mailMcp.ts', '--env-prefix=MANOR_MAIL_OTHER'])).toBe('MANOR_MAIL_OTHER')
    expect(mailEnvKeys('MANOR_MAIL_OTHER')).toEqual(['MANOR_MAIL_OTHER_IMAP_USER', 'MANOR_MAIL_OTHER_IMAP_PASSWORD'])
  })

  it('refuses a prefix that cannot be an environment name', () => {
    expect(() => mailEnvPrefix(['--env-prefix=manor-mail'])).toThrow(/uppercase/)
    expect(() => mailEnvPrefix(['--env-prefix='])).toThrow(/uppercase/)
  })
})

describe('gmailThreadUrl', () => {
  it('turns Gmail IMAP decimal thread ids into an account-scoped web link', () => {
    expect(gmailThreadUrl('26', 'sam@example.invalid')).toBe(
      'https://mail.google.com/mail/u/?authuser=sam%40example.invalid#all/1a',
    )
    expect(gmailThreadUrl('not-a-number', 'sam@example.invalid')).toBeUndefined()
  })
})

describe('Gmail reply threading', () => {
  it('reads a Gmail API hex thread id and an IMAP decimal id as the same thread', () => {
    expect(gmailThreadIdForImap('1a11577524273408')).toBe('1878378680219546632')
    expect(gmailThreadIdForImap('1878378680219546632')).toBe('1878378680219546632')
    expect(gmailThreadIdForImap('thread-1a11')).toBeUndefined()
  })

  it('chains the parent onto its References and drops anything that could inject a header', () => {
    const raw = 'References: <root@example.com>\r\n <mid@example.com> garbage\r\n\tBcc: x@y.z\r\nSubject: Hi\r\n'
    expect(replyHeadersFor('<parent@example.com>', raw)).toEqual({
      inReplyTo: '<parent@example.com>',
      references: ['<root@example.com>', '<mid@example.com>', '<parent@example.com>'],
    })
    expect(replyHeadersFor('<parent@example.com>\r\nBcc: x@y.z', '')).toEqual({
      inReplyTo: '<parent@example.com>',
      references: ['<parent@example.com>'],
    })
    expect(replyHeadersFor(undefined, raw)).toBeUndefined()
  })
})

describe('textNode', () => {
  it('prefers the plain text alternative over html', () => {
    const node = textNode({
      type: 'multipart/alternative',
      childNodes: [
        { part: '1', type: 'text/html', parameters: { charset: 'utf-8' } },
        { part: '2', type: 'text/plain', parameters: { charset: 'utf-8' } },
      ],
    } as never)
    expect(node).toEqual({ part: '2', type: 'text/plain' })
  })

  it('addresses a single-part body as part 1', () => {
    const node = textNode({ type: 'text/plain', parameters: { charset: 'iso-8859-1' } } as never)
    expect(node).toEqual({ part: '1', type: 'text/plain' })
  })

  it('never picks an attachment, which is the point of fetching selectively', () => {
    const node = textNode({
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain', parameters: {} },
        { part: '2', type: 'text/html', disposition: 'attachment', parameters: {} },
        { part: '3', type: 'image/jpeg', parameters: {} },
      ],
    } as never)
    expect(node?.part).toBe('1')
  })

  it('returns nothing when a message carries no readable text node', () => {
    expect(textNode({ type: 'multipart/mixed', childNodes: [{ part: '1', type: 'application/pdf' }] } as never)).toBeUndefined()
  })
})

describe('attachments', () => {
  it('names the file that made a body-less mail look empty', () => {
    expect(attachments(replyWithDocx)).toEqual([
      {
        name: 'afmetingen posters.docx',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        kb: 1891,
      },
    ])
  })

  it('reaches the text part of that same nested structure', () => {
    expect(textNode(replyWithDocx)).toEqual({ part: '1.1', type: 'text/plain' })
  })

  it('does not report the body itself as an attachment', () => {
    expect(attachments({ type: 'text/plain', parameters: { charset: 'utf-8' }, size: 40 } as never)).toEqual([])
  })

  it('gives a base64 attachment the size of the file, not of its encoded form', () => {
    const pdf = { part: '2', type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: 'scan.pdf' } }
    // 16 MB of file travels as almost 22 MB of base64.
    expect(attachments({ ...pdf, encoding: 'base64', size: 22_958_032 })).toEqual([{ name: 'scan.pdf', type: 'application/pdf', kb: 16_384 }])
    expect(attachments({ ...pdf, encoding: '8bit', size: 2_048 })).toEqual([{ name: 'scan.pdf', type: 'application/pdf', kb: 2 }])
  })

  it('ignores an inline signature image that carries no filename', () => {
    const structure = {
      type: 'multipart/related',
      childNodes: [
        { part: '1', type: 'text/plain', parameters: {}, size: 10 },
        { part: '2', type: 'image/png', disposition: 'inline', parameters: {}, size: 900 },
      ],
    } as never
    expect(attachments(structure)).toEqual([])
  })
})

describe('stripQuotes', () => {
  it('cuts at the Dutch reply header, not only at the quoted lines under it', () => {
    const text = ['Ja doe die tweede maar.', '', 'Op 13 aug 2026 om 09:12 schreef Robin:', '> welke lijst wil je', '> laat even weten'].join('\n')
    expect(stripQuotes(text)).toBe('Ja doe die tweede maar.')
  })

  it('cuts at the English reply header', () => {
    const text = ['Sounds good.', 'On Mon, 11 Aug 2026 at 10:04, Someone <a@b.nl> wrote:', '> original'].join('\n')
    expect(stripQuotes(text)).toBe('Sounds good.')
  })

  it('drops a mobile signature trailer', () => {
    expect(stripQuotes('Prima.\n\nVerstuurd vanaf mijn iPhone')).toBe('Prima.')
  })

  it('leaves a mail with no quoted history alone', () => {
    expect(stripQuotes('Regel een.\n\nRegel twee.')).toBe('Regel een.\n\nRegel twee.')
  })
})

describe('htmlToText', () => {
  it('keeps the words and drops the markup', () => {
    const html = '<html><head><style>p{color:red}</style></head><body><p>Hoi&nbsp;Sam</p><br><div>Groet &amp; dank</div></body></html>'
    expect(htmlToText(html).split('\n').map((line) => line.trim()).filter((line) => line !== '')).toEqual(['Hoi Sam', 'Groet & dank'])
  })
})

describe('headerValue', () => {
  it('leaves an ascii subject untouched', () => {
    expect(headerValue('Re: fotolijstjes')).toBe('Re: fotolijstjes')
  })

  it('encodes a subject that would otherwise arrive as mojibake', () => {
    expect(headerValue('Kraamzorg intake — bevestiging')).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/)
  })

  it('encodes a subject carrying a newline, so it cannot become a second header', () => {
    expect(headerValue('Prints\r\nBcc: someone@else.nl')).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/)
  })
})

describe('recipient', () => {
  it('accepts a bare address and a display name', () => {
    expect(recipient(' robin@example.invalid ')).toBe('robin@example.invalid')
    expect(recipient('Robin Example <robin@example.invalid>')).toBe('Robin Example <robin@example.invalid>')
  })

  it('refuses an address that smuggles a second header past the To line', () => {
    expect(() => recipient('alice@x.nl\r\nBcc: someone@else.nl')).toThrow(/more than one line/)
  })

  it('refuses a bare newline as well as a full CRLF', () => {
    expect(() => recipient('alice@x.nl\nBcc: someone@else.nl')).toThrow(/more than one line/)
  })

  it('refuses text that is not an address at all', () => {
    expect(() => recipient('Robin')).toThrow(/not an email address/)
    expect(() => recipient('   ')).toThrow(/empty recipient/)
  })
})
