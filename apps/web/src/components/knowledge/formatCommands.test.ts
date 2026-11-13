import { undo } from '@codemirror/commands'
import { describe, expect, it } from 'vitest'
import { activeMarks, formatUrl, linkDestination, markAvailable, removeLink, setLink, toggleMark } from './formatCommands'
import { markStates } from './NoteFormatting'
import { apply, note, run, show } from './noteTestState'

describe('inline toggles', () => {
  it.each([
    ['bold', '**'],
    ['italic', '*'],
    ['strike', '~~'],
    ['code', '`'],
  ] as const)('%s wraps a selection and a second press unwraps it', (mark, token) => {
    const on = run('say «hello» there', toggleMark(mark))
    expect(on).toBe(`say ${token}«hello»${token} there`)
    expect(run(on!, toggleMark(mark))).toBe('say «hello» there')
  })

  it('unwraps when the selection includes the markers', () => {
    expect(run('say «**hello**» there', toggleMark('bold'))).toBe('say «hello» there')
  })

  it('leaves the spaces at the edges of a selection outside the marks', () => {
    expect(run('say« hello »there', toggleMark('bold'))).toBe('say« **hello** »there')
  })

  it('splits a run when part of it is unbolded', () => {
    expect(run('**hel«l»o**', toggleMark('bold'))).toBe('**hel**«l»**o**')
    expect(run('**«hel»lo**', toggleMark('bold'))).toBe('«hel»**lo**')
  })

  it('merges with a run the selection overlaps instead of nesting', () => {
    expect(run('**hel«lo** wor»ld', toggleMark('bold'))).toBe('**hel«lo wor»**ld')
    expect(run('«a **b** c»', toggleMark('bold'))).toBe('**«a b c»**')
  })

  it('toggles the word at a bare caret, keeping the caret in place', () => {
    expect(run('say hel‸lo there', toggleMark('bold'))).toBe('say **hel‸lo** there')
    expect(run('say **hel‸lo** there', toggleMark('bold'))).toBe('say hel‸lo there')
    expect(run('say ‸hello', toggleMark('italic'))).toBe('say *‸hello*')
  })

  it('inserts an empty pair where there is no word, and takes it back on a second press', () => {
    const once = run('say ‸', toggleMark('bold'))
    expect(once).toBe('say **‸**')
    expect(run(once!, toggleMark('bold'))).toBe('say ‸')
    expect(run('‸', toggleMark('code'))).toBe('`‸`')
  })

  it('formats a multi-line selection line by line, past each block mark', () => {
    expect(run('- «one\n- two»', toggleMark('bold'))).toBe('- **«one**\n- **two»**')
    expect(run('«one\n\ntwo»', toggleMark('strike'))).toBe('~~«one~~\n\n~~two»~~')
  })

  it('handles every cursor', () => {
    expect(run('al‸pha be‸ta', toggleMark('bold'))).toBe('**al‸pha** **be‸ta**')
  })

  it('declines inside a code block and the frontmatter', () => {
    expect(run('```\n«code»\n```', toggleMark('bold'))).toBeNull()
    expect(run('---\ntitle: «x»\n---\nbody', toggleMark('bold'))).toBeNull()
  })

  it('never writes a mark into a wikilink, a link target or inline code', () => {
    expect(run('see [[No«te|Lab»el]] x', toggleMark('bold'))).toBeNull()
    expect(run('see [[No«te»]]', setLink('http://y'))).toBeNull()
    expect(run('a `«code»` b', toggleMark('italic'))).toBeNull()
    expect(run('a `co«de` b» c', toggleMark('bold'))).toBeNull()
    expect(run('see [fo«o](http://x) o»k', toggleMark('bold'))).toBeNull()
    expect(run('see [foo](http://«x») ok', toggleMark('bold'))).toBeNull()
    expect(run('go www.exa‸mple.com', toggleMark('bold'))).toBeNull()
    expect(run('[[No‸te]]', toggleMark('bold'))).toBeNull()
  })

  it('formats inside a link label, takes code off inside code, and wraps whole atoms from outside', () => {
    expect(run('see [fo«o»](http://x) ok', toggleMark('bold'))).toBe('see [fo**«o»**](http://x) ok')
    expect(run('see [fo«o»](http://x) ok', toggleMark('code'))).toBe('see [fo`«o»`](http://x) ok')
    expect(run('a `«code»` b', toggleMark('code'))).toBe('a «code» b')
    expect(run('«see [[Note]] and `x`»', toggleMark('bold'))).toBe('**«see [[Note]] and `x`»**')
    expect(run('«see [foo](http://x)»', setLink('http://y'))).toBeNull()
  })

  it('reports a toggle that would decline, for the disabled toolbar control', () => {
    expect(markAvailable(note('a `«code»` b'), 'bold')).toBe(false)
    expect(markAvailable(note('a `«code»` b'), 'code')).toBe(true)
  })

  it('skips the toolbar states for a very long selection', () => {
    expect(markStates(note('**«a»**')).marks.bold).toBe(true)
    const long = note(`«**${'word '.repeat(1_200)}**»`)
    expect(markStates(long)).toEqual({
      marks: { bold: false, italic: false, strike: false, code: false },
      available: { bold: true, italic: true, strike: true, code: true },
      linkAvailable: true,
    })
    const tall = note(`«${'a\n'.repeat(250)}»`)
    expect(markStates(tall).available.code).toBe(true)
    expect(markStates(note('a `«code»` b')).available.bold).toBe(false)
  })

  it('upgrades a single-tilde mark instead of opening a tilde fence', () => {
    expect(run('~«a»~', toggleMark('strike'))).toBe('~~«a»~~')
    expect(run('«~a~» b', toggleMark('strike'))?.replace(/[«»]/g, '')).toBe('~~a~~ b')
  })

  it('declines a mark that would fuse with the same character next to it', () => {
    expect(run('a`«b»', toggleMark('code'))).toBeNull()
    expect(run('‸', toggleMark('strike'))).toBeNull()
    expect(run('‸', toggleMark('bold'))).toBeNull()
    expect(run('*«a»*', toggleMark('bold'))).toBe('***«a»***')
  })

  it('reports which marks the whole selection has', () => {
    expect(activeMarks(note('***«word»***'))).toEqual({ bold: true, italic: true, strike: false, code: false })
    expect(activeMarks(note('**«one** two»'))).toEqual({ bold: false, italic: false, strike: false, code: false })
  })

  it('is one undo step', () => {
    const state = note('say «hello»')
    const after = apply(state, toggleMark('bold')(state))
    let undone = after
    undo({ state: after, dispatch: (tr) => { undone = tr.state } })
    expect(undone.doc.toString()).toBe('say hello')
  })
})

describe('links', () => {
  it('wraps the selection with the url, adding https to a bare domain', () => {
    expect(run('see «the site» now', setLink('example.com'))).toBe('see [«the site»](https://example.com) now')
  })

  it('wraps the word at the caret', () => {
    expect(run('see si‸te now', setLink('https://a.b'))).toBe('see [«site»](https://a.b) now')
  })

  it('retargets a link the selection is in, and removes it', () => {
    expect(run('[«site»](https://a.com)', setLink('https://b.com'))).toBe('[«site»](https://b.com)')
    expect(run('a [«site»](https://a.com) b', removeLink)).toBe('a «site» b')
    expect(run('[«site»](https://a.com)', setLink(''))).toBe('«site»')
  })

  it('inserts the url as its own link where there is no text', () => {
    expect(run('see ‸', setLink('https://x.dev'))).toBe('see [https://x.dev](https://x.dev)‸')
  })

  it('keeps note paths and anchors as written and brackets the awkward ones', () => {
    expect(formatUrl('Projects/plan.md')).toBe('Projects/plan.md')
    expect(formatUrl('#questions')).toBe('#questions')
    expect(formatUrl('mailto:a@b.c')).toBe('mailto:a@b.c')
    expect(formatUrl('https://a.b/x y')).toBe('<https://a.b/x y>')
  })

  it('declines several selections', () => {
    expect(run('«a» «b»', setLink('https://x.dev'))).toBeNull()
  })

  it('opens websites and mail outside, notes inside, and refuses every other scheme', () => {
    expect(linkDestination('https://a.b/c')).toEqual({ kind: 'website', url: 'https://a.b/c' })
    expect(linkDestination('www.example.com')).toEqual({ kind: 'website', url: 'https://www.example.com' })
    expect(linkDestination('mailto:a@b.co')).toEqual({ kind: 'mail', url: 'mailto:a@b.co' })
    expect(linkDestination('a@b.co')).toEqual({ kind: 'mail', url: 'mailto:a@b.co' })
    expect(linkDestination('Projects/plan.md')).toEqual({ kind: 'note', target: 'Projects/plan.md' })
    for (const href of ['javascript:alert(1)', 'file:///etc/hosts', 'data:text/html,x', 'obsidian://open?x', 'vbscript:x']) {
      expect(linkDestination(href)).toEqual({ kind: 'refused' })
    }
  })

  it('round trips through show', () => {
    expect(show(note('a «b» c'))).toBe('a «b» c')
  })
})
