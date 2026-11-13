import { buildNoteIndex, resolveNote } from '@manor/client-runtime/vault-notes'
import { describe, expect, it } from 'vitest'
import {
  bodyOffset,
  calloutTone,
  MISSING_HREF,
  NOTE_HREF,
  noteTarget,
  parseNote,
  readProperties,
  remarkCallouts,
  remarkWikilinks,
} from '../src/vaultNotes'

const frontmatter = [
  '---',
  'type: meeting',
  'status: done',
  'tags:',
  '  - client/acme',
  '  - topic/ai',
  'date: 2026-05-28',
  'granola: https://notes.granola.ai/d/abc',
  '---',
  '',
  '# Design team block',
  '',
  'We agreed on the split.',
].join('\n')

describe('parseNote', () => {
  it('lifts the four chip fields out of a block-list frontmatter and drops the rest', () => {
    const note = parseNote('meetings/2026-05-28-design-team-block.md', frontmatter)
    expect(note.frontmatter).toEqual({
      type: 'meeting',
      status: 'done',
      date: '2026-05-28',
      tags: ['client/acme', 'topic/ai'],
    })
    expect(note.body).toBe('We agreed on the split.')
  })

  it('reads the inline tag list the vault also uses', () => {
    const note = parseNote('a.md', '---\ntype: note\ntags: [job-application, "topic/ai"]\n---\n\nBody.')
    expect(note.frontmatter?.tags).toEqual(['job-application', 'topic/ai'])
  })

  it('takes the title from the opening heading, and does not render it twice', () => {
    const note = parseNote('people/robin.md', '---\ntype: note\n---\n\n# Robin Example\n\n**Role:** adviseur')
    expect(note.title).toBe('Robin Example')
    expect(note.body).toBe('**Role:** adviseur')
  })

  it('falls back to the filename when the note opens with prose', () => {
    const note = parseNote('life/minor.md', '---\ntype: note\n---\n\nDiafragma en sluitertijd.')
    expect(note.title).toBe('minor')
    expect(note.body).toBe('Diafragma en sluitertijd.')
  })

  it('leaves a note without frontmatter alone', () => {
    const note = parseNote('AGENTS.md', '# Vault context\n\nRead this first.')
    expect(note.frontmatter).toBeNull()
    expect(note.title).toBe('Vault context')
    expect(note.body).toBe('Read this first.')
  })

  it('treats an unterminated block as prose, not as frontmatter', () => {
    const text = '---\ntype: note\n\nStill going.'
    expect(parseNote('a.md', text)).toMatchObject({ frontmatter: null, body: text })
  })
})

describe('remarkWikilinks', () => {
  const index = buildNoteIndex(['research/wiki/context-engineering.md'])
  const transform = remarkWikilinks((target) => resolveNote(index, target))()

  const paragraph = (value: string) => ({
    type: 'root',
    children: [{ type: 'paragraph', children: [{ type: 'text', value }] }],
  })
  const linksOf = (tree: ReturnType<typeof paragraph>) =>
    (tree.children[0] as { children: { type: string; url?: string; children?: { value?: string }[] }[] }).children

  it('turns a resolved link into a note href carrying the path', () => {
    const tree = paragraph('See [[context-engineering]] for more.')
    transform(tree)
    const [before, link, after] = linksOf(tree)
    expect(before).toMatchObject({ type: 'text', value: 'See ' })
    expect(link?.type).toBe('link')
    expect(noteTarget(link?.url)).toBe('research/wiki/context-engineering.md')
    expect(after).toMatchObject({ type: 'text', value: ' for more.' })
  })

  it('keeps the alias as the label', () => {
    const tree = paragraph('[[context-engineering|the wiki page]]')
    transform(tree)
    expect(linksOf(tree)[0]?.children?.[0]?.value).toBe('the wiki page')
  })

  it('marks a link to nothing as missing rather than resolving it somewhere', () => {
    const tree = paragraph('[[gone]]')
    transform(tree)
    expect(linksOf(tree)[0]?.url).toBe(MISSING_HREF)
    expect(noteTarget(MISSING_HREF)).toBeNull()
  })

  it('leaves brackets inside code alone', () => {
    const tree = {
      type: 'root',
      children: [{ type: 'inlineCode', value: '[[context-engineering]]' }],
    }
    transform(tree)
    expect(tree.children[0]).toEqual({ type: 'inlineCode', value: '[[context-engineering]]' })
  })

  it('encodes a path so a space in a note name survives the href', () => {
    const spaced = buildNoteIndex(['research/wiki/context engineering.md'])
    const tree = paragraph('[[context engineering]]')
    remarkWikilinks((target) => resolveNote(spaced, target))()(tree)
    const url = linksOf(tree)[0]?.url
    expect(url?.startsWith(NOTE_HREF)).toBe(true)
    expect(noteTarget(url)).toBe('research/wiki/context engineering.md')
  })
})

describe('frontmatter as properties', () => {
  const block = ['type: meeting', 'tags:', '  - client/acme', '  - topic/ai', 'granola: https://notes.granola.ai/d/abc', 'status:']

  it('keeps every key in file order, not just the four the chips use', () => {
    expect(readProperties(block)).toEqual([
      { key: 'type', values: ['meeting'] },
      { key: 'tags', values: ['client/acme', 'topic/ai'] },
      { key: 'granola', values: ['https://notes.granola.ai/d/abc'] },
      { key: 'status', values: [] },
    ])
  })

  it('does not mistake a bracketed scalar for a list, or a URL for one', () => {
    expect(readProperties(['title: [draft] the offer', 'tags: [a, b]'])).toEqual([
      { key: 'title', values: ['draft] the offer'] },
      { key: 'tags', values: ['a', 'b'] },
    ])
  })

  it('points the editor at the prose, past the frontmatter', () => {
    const note = '---\ntype: note\n---\n\nBody starts here.'
    expect(note.slice(bodyOffset(note))).toBe('\nBody starts here.')
    expect(bodyOffset('# No frontmatter\n')).toBe(0)
    expect(bodyOffset('---\nunterminated\n')).toBe(0)
  })
})

describe('remarkCallouts', () => {
  const transform = remarkCallouts()()

  /** One blockquote holding one paragraph, the way markdown folds a quote's lines. */
  const quote = (...paragraphLines: string[]) => ({
    type: 'root',
    children: [
      {
        type: 'blockquote',
        children: [{ type: 'paragraph', children: [{ type: 'text', value: paragraphLines.join('\n') }] }],
      },
    ],
  })
  const callout = (tree: ReturnType<typeof quote>) =>
    tree.children[0] as { type: string; data?: Record<string, unknown>; children: unknown[] }

  it('renames the quote and carries its type, so the renderer can style it', () => {
    const tree = quote('[!warning] Let op')
    transform(tree)
    expect(callout(tree).data).toMatchObject({
      hName: 'div',
      hProperties: { className: ['manor-callout'], 'data-callout': 'warning' },
    })
  })

  it('splits the title off the body markdown folded into one paragraph', () => {
    const tree = quote('[!warning] Let op', 'Python blokkeert de tak.')
    transform(tree)
    const [title, body] = callout(tree).children as { children: { value: string }[] }[]
    expect(title?.children[0]?.value).toBe('Let op')
    expect(body?.children[0]?.value).toBe('Python blokkeert de tak.')
  })

  it('names an untitled callout after its own type', () => {
    const tree = quote('[!tip]', 'Breed blijven.')
    transform(tree)
    const [title, body] = callout(tree).children as { children: { value: string }[] }[]
    expect(title?.children[0]?.value).toBe('Tip')
    expect(body?.children[0]?.value).toBe('Breed blijven.')
  })

  it('leaves an ordinary quote entirely alone', () => {
    const tree = quote('Gewoon een citaat.')
    transform(tree)
    expect(callout(tree).type).toBe('blockquote')
    expect(callout(tree).data).toBeUndefined()
  })

  it('reads twenty type words down to four tones, and never invents a red one', () => {
    expect(['tip', 'success', 'done'].map(calloutTone)).toEqual(['good', 'good', 'good'])
    expect(['warning', 'caution', 'faq'].map(calloutTone)).toEqual(['warn', 'warn', 'warn'])
    expect(['danger', 'bug', 'missing'].map(calloutTone)).toEqual(['bad', 'bad', 'bad'])
    expect(['abstract', 'note', 'wat-dan-ook'].map(calloutTone)).toEqual(['neutral', 'neutral', 'neutral'])
  })
})
