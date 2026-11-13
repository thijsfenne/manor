import { describe, expect, it } from 'vitest'
import { compactQuoteRefs, formatQuoteRef, imageRefSpans, MAX_MESSAGE_QUOTE_CHARS, MAX_MESSAGE_QUOTES, offsetQuoteRefs, quoteExcerpt, quoteRefSpans, snapRefDeletion, withQuoteExcerpts } from '@manor/contracts'
import type { AgentConfig, InlineQuote } from '@manor/contracts'
import { insertQuote, quoteAuthorName, quoteFromNote, quoteFromRange, quoteFromText, quoteNamesAuthor } from './messageQuotes'

describe('message quotes', () => {
  it('preserves the selected substring and source identity', () => {
    expect(quoteFromRange('event-1', 'Choose these words please', 7, 18, 'sage')).toEqual({
      eventId: 'event-1',
      text: 'these words',
      agentId: 'sage',
    })
  })

  it('normalises a backwards range and rejects blank or oversized selections', () => {
    expect(quoteFromRange('event-1', 'alpha beta', 10, 6)).toMatchObject({ text: 'beta' })
    expect(quoteFromRange('event-1', '   ', 0, 3)).toBeUndefined()
    expect(quoteFromRange('event-1', 'x'.repeat(MAX_MESSAGE_QUOTE_CHARS + 1), 0, MAX_MESSAGE_QUOTE_CHARS + 1)).toBeUndefined()
  })

  it('accepts the exact text returned by a DOM selection', () => {
    expect(quoteFromText('event-1', 'visible rendered words')).toEqual({ eventId: 'event-1', text: 'visible rendered words' })
  })

  it('keeps a note excerpt with its vault path and rejects a blank slice', () => {
    expect(quoteFromNote('inbox/untitled.md', '  keep this  ')).toEqual({
      path: 'inbox/untitled.md',
      text: '  keep this  ',
    })
    expect(quoteFromNote('inbox/untitled.md', '   ')).toBeUndefined()
  })
})

describe('sent quote author', () => {
  const roster = [{ id: 'sage', name: 'Sage' }] as AgentConfig[]

  it('names the author only in a room with several personas', () => {
    expect(quoteNamesAuthor({ kind: 'project', mode: 'house' }, false)).toBe(true)
    expect(quoteNamesAuthor({ kind: 'group', mode: 'house' }, false)).toBe(true)
    expect(quoteNamesAuthor({ kind: 'pair', mode: 'house' }, false)).toBe(true)
    expect(quoteNamesAuthor({ kind: 'dm', mode: 'house' }, false)).toBe(false)
    expect(quoteNamesAuthor({ kind: 'project', mode: 'single' }, false)).toBe(false)
    expect(quoteNamesAuthor({ kind: 'project', mode: 'house' }, true)).toBe(false)
  })

  it('prints a real persona name, never the session voice', () => {
    expect(quoteAuthorName({ eventId: 'e', text: 't', agentId: 'sage' }, roster, true)).toBe('Sage')
    expect(quoteAuthorName({ eventId: 'e', text: 't', agentId: 'sage' }, roster, false)).toBeUndefined()
    expect(quoteAuthorName({ eventId: 'e', text: 't', agentId: '__single__' }, roster, true)).toBeUndefined()
    expect(quoteAuthorName({ eventId: 'e', text: 't', agentId: 'gone' }, roster, true)).toBeUndefined()
    expect(quoteAuthorName({ eventId: 'e', text: 't' }, roster, true)).toBe('You')
  })
})

describe('insertQuote', () => {
  const note = (text: string): InlineQuote => ({ kind: 'note', path: 'inbox/a.md', text })
  const page = (id: string) => ({ kind: 'page', context: { id, kind: 'text', url: 'https://a.test', title: 'A', label: 'A', text: 'Words', html: '' } }) as InlineQuote

  it('sets the pill off from the words around it, with the caret past it', () => {
    expect(insertQuote('is better', [], note('a'), 2)).toEqual({ text: 'is [Quote #1] better', quotes: [note('a')], caret: 13 })
    expect(insertQuote('is ', [], note('a'), 3)).toEqual({ text: 'is [Quote #1] ', quotes: [note('a')], caret: 14 })
    expect(insertQuote('', [], note('a'), 0)).toEqual({ text: '[Quote #1] ', quotes: [note('a')], caret: 11 })
    expect(insertQuote('see.', [], note('a'), 3)?.text).toBe('see [Quote #1].')
  })

  it('numbers past a removed pill, whose quote undo may still want', () => {
    expect(insertQuote('[Quote #2] ', [note('gone'), note('kept')], note('new'), 11)).toEqual({
      text: '[Quote #2] [Quote #3] ', quotes: [note('gone'), note('kept'), note('new')], caret: 22,
    })
  })

  it('leaves a browser selection already in the draft alone, and places it again once removed', () => {
    expect(insertQuote('[Quote #1] ', [page('one')], page('one'), 11)).toEqual({ text: '[Quote #1] ', quotes: [page('one')], caret: 11 })
    expect(insertQuote('gone', [page('one')], page('one'), 4)?.text).toBe('gone [Quote #2] ')
  })

  it('refuses when the message is full', () => {
    const quotes = Array.from({ length: MAX_MESSAGE_QUOTES }, (_, index) => note(String(index)))
    expect(insertQuote(quotes.map((_, index) => formatQuoteRef(index + 1)).join(' '), quotes, note('more'), 0)).toBeNull()
  })
})

describe('quote references', () => {
  const note = (text: string): InlineQuote => ({ kind: 'note', path: 'inbox/a.md', text })

  it('count only numbers the message has quotes for', () => {
    expect(quoteRefSpans('[Quote #1] [Quote #2] [Quote #0]', 1).map((span) => span.number)).toEqual([1])
    expect(quoteRefSpans('[Quote #1]', 0)).toEqual([])
  })

  it('go out in reading order, without the quotes whose pill was removed', () => {
    expect(compactQuoteRefs('b [Quote #3] a [Quote #1] again [Quote #3]', [note('a'), note('gone'), note('b')])).toEqual({
      text: 'b [Quote #1] a [Quote #2] again [Quote #1]',
      quotes: [note('b'), note('a')],
    })
  })

  it('move up past the quotes put before them', () => {
    expect(offsetQuoteRefs('[Quote #1] and [Quote #2]', 1, 2)).toBe('[Quote #3] and [Quote #2]')
  })

  it('open with a quote mark and cut by characters', () => {
    expect(quoteExcerpt(note('Short'))).toBe('“Short')
    expect(quoteExcerpt(note('Het is in-house hebben we besloten'))).toBe('“Het is in-house he…')
    expect(quoteExcerpt(note('😀'.repeat(19)))).toBe(`“${'😀'.repeat(18)}…`)
  })

  it('read as their words where no pill is drawn', () => {
    expect(withQuoteExcerpts('is [Quote #1] it', [note('Words')])).toBe('is “Words it')
    expect(withQuoteExcerpts('is [Quote #1] it')).toBe('is [Quote #1] it')
  })

  it('go as one unit in a plain text field, beside pictures', () => {
    const before = 'see [Quote #1] and [Image #1]'
    const spans = [...imageRefSpans(before, 1), ...quoteRefSpans(before, 1)]
    expect(snapRefDeletion(before, 'see [Quote #1 and [Image #1]', spans)).toEqual({ text: 'see  and [Image #1]', caret: 4 })
  })
})
