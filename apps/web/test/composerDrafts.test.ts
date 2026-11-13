import { beforeEach, describe, expect, it } from 'vitest'
import { EMPTY_DRAFT, clearDrafts, insertQuoteIntoDraft, readDraft, subscribeDraftInsert, writeDraft } from '../src/composerDrafts'

const PIXEL = { name: 'shot.png', dataUrl: 'data:image/webp;base64,UklGRg==' }

/**
 * The store behind "your half-typed message is still there". What it guards is
 * the pair of failures it replaced: a draft that followed you into the next chat,
 * and one that was thrown away the moment the composer left the screen.
 */
describe('composer drafts', () => {
  beforeEach(clearDrafts)

  it('hands each chat back its own draft, and nothing to a chat with none', () => {
    writeDraft('chat-a', { text: 'half a thought', images: [], files: [] })

    expect(readDraft('chat-a').text).toBe('half a thought')
    expect(readDraft('chat-b')).toEqual(EMPTY_DRAFT)
  })

  it('places a quote at the end of a parked draft, and hands it to a composer on screen', () => {
    const quote = { kind: 'note' as const, path: 'inbox/a.md', text: 'Words' }
    writeDraft('chat-a', { text: 'see', images: [], files: [] })
    insertQuoteIntoDraft('chat-a', quote)
    expect(readDraft('chat-a')).toMatchObject({ text: 'see [Quote #1] ', quotes: [quote] })

    const seen: unknown[] = []
    const stop = subscribeDraftInsert('chat-a', (insert) => seen.push(insert))
    insertQuoteIntoDraft('chat-a', quote)
    stop()
    expect(seen).toEqual([{ kind: 'quote', quote }])
    expect(readDraft('chat-a').quotes).toEqual([quote])
  })

  it('keeps attached images with the text they were attached to', () => {
    writeDraft('chat-a', { text: 'look at this', images: [PIXEL], files: [] })

    expect(readDraft('chat-a').images).toEqual([PIXEL])
  })

  // Sending writes the empty draft back, and an empty one is the same as none —
  // otherwise a sent message's pictures would sit in memory for the whole session.
  it('forgets a draft emptied out', () => {
    writeDraft('chat-a', { text: 'typed', images: [PIXEL], files: [] })
    writeDraft('chat-a', EMPTY_DRAFT)

    expect(readDraft('chat-a')).toEqual(EMPTY_DRAFT)
  })

  // A composer with no identity — nothing in the app today, but the prop is
  // optional and a silent write under `undefined` would pool every such draft.
  it('remembers nothing for a composer without a key', () => {
    writeDraft(undefined, { text: 'nowhere', images: [], files: [] })

    expect(readDraft(undefined)).toEqual(EMPTY_DRAFT)
  })
})
