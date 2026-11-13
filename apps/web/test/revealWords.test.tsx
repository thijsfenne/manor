import type { AgentConfig } from '@manor/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { describe, expect, it } from 'vitest'
import { AgentBubble } from '../src/components/Bubbles'
import { remarkAgentMentions } from '../src/mentions'
import { rehypeRevealWords, type RevealCount } from '../src/revealWords'

const agent = (name: string, color: string): AgentConfig =>
  ({ id: name.toLowerCase(), name, color }) as AgentConfig

const ROSTER = [agent('Smith', '#f59e0b')]

const live = (text: string) =>
  renderToStaticMarkup(<AgentBubble color="#3b82f6" text={text} agents={ROSTER} live />)

const settled = (text: string) =>
  renderToStaticMarkup(<AgentBubble color="#3b82f6" text={text} agents={ROSTER} />)

const wrapped = (html: string) => html.match(/class="reveal-word/g)?.length ?? 0
const animated = (html: string) => html.match(/reveal-word reveal-word-new/g)?.length ?? 0

/** One pass of the plugin at a stated boundary, which is what a re-render hands it. */
const pass = (text: string, from: number) => {
  const count: RevealCount = { words: 0 }
  const html = renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRevealWords(from, count)]}>
      {text}
    </ReactMarkdown>,
  )
  return { html, count: count.words }
}

describe('the word reveal on a live reply', () => {
  it('wraps each word of text that is still arriving', () => {
    expect(wrapped(live('one two three'))).toBe(3)
  })

  it('leaves a finished reply as plain text', () => {
    // The animation is the whole reason for the spans, and a settled reply has
    // nothing left to animate. Several hundred elements per message is the cost.
    expect(wrapped(settled('one two three'))).toBe(0)
    expect(settled('one two three')).toContain('one two three')
  })

  it('keeps the words readable in order, spaces and all', () => {
    const html = live('a short sentence')
    expect(html.replace(/<[^>]+>/g, '')).toContain('a short sentence')
  })

  it('never splits inside code, where the whitespace is the content', () => {
    expect(wrapped(live('```\nconst a = 1\n```'))).toBe(0)
    // Only the prose around it: the three words inside the backticks stay one run.
    expect(wrapped(live('call `npm run dev` first'))).toBe(2)
    expect(live('call `npm run dev` first')).toContain('npm run dev')
  })

  it('leaves a mention whole, so it still becomes a chip', () => {
    const html = live('@Smith kijk hier even naar')
    // The chip's own padding, the one thing nothing else in a bubble wears.
    expect(html).toContain('pr-[7px] pl-[4px]')
    expect(html).not.toContain('@Smith')
  })

  it('reveals words inside headings, lists and emphasis too', () => {
    expect(wrapped(live('## Two words'))).toBe(2)
    expect(wrapped(live('- one\n- two'))).toBe(2)
    expect(wrapped(live('**bold** and *not*'))).toBe(3)
  })
})

describe('the boundary that stops a word settling in twice', () => {
  it('animates only the words past it', () => {
    const { html } = pass('one two three four', 2)
    expect(wrapped(html)).toBe(4)
    expect(animated(html)).toBe(2)
  })

  it('animates everything on the first pass, and nothing once it has caught up', () => {
    expect(animated(pass('one two three', 0).html)).toBe(3)
    expect(animated(pass('one two three', 3).html)).toBe(0)
  })

  it('reports the words it found, which is where the next pass starts', () => {
    expect(pass('one two three', 0).count).toBe(3)
    // Code is not wrapped, but it is counted: it held those indices as prose while
    // the closing backtick was still missing, and the words after it keep theirs.
    const code = pass('one `two three` four', 0)
    expect(code.count).toBe(4)
    expect(wrapped(code.html)).toBe(2)
  })

  /**
   * The index has to mean the same thing before and after markdown recognises
   * something. A backtick closing turns prose into an element this skips, and
   * without counting the skipped words every word behind it slides down an index,
   * lands under the boundary, and arrives without ever settling in.
   */
  it('holds the index steady when an unclosed code span finally closes', () => {
    const before = pass('before `code', 0)
    expect(before.count).toBe(2)
    const after = pass('before `code` after', before.count)
    // "after" is the only new word, and it is past the boundary where it belongs.
    expect(animated(after.html)).toBe(1)
    expect(after.html).toContain('<code>')
  })

  it('counts a mention as the one word it renders as', () => {
    const count: RevealCount = { words: 0 }
    renderToStaticMarkup(
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkAgentMentions(ROSTER)]}
        rehypePlugins={[rehypeRevealWords(0, count)]}
      >
        {'ask @Smith later'}
      </ReactMarkdown>,
    )
    expect(count.words).toBe(3)
  })

  /**
   * The defect this whole boundary exists for. Emphasis closing mid-stream moves
   * the word under a `<strong>` and shifts every sibling after it, so React
   * remounts words that were already on screen. Position cannot tell them apart;
   * the boundary can, and it is what keeps the paragraph from flashing back in.
   */
  it('keeps old words silent through a markdown restructure', () => {
    const before = pass('the answer is **bo', 0)
    expect(before.count).toBe(4)
    const after = pass('the answer is **bold** and done', before.count)
    // Only "and" and "done" are new. "bold" sat there as "**bo" already.
    expect(animated(after.html)).toBe(2)
    expect(after.html).toContain('<strong>')
  })

  it('still wraps the old words, so crossing the boundary is one class and not a remount', () => {
    const { html } = pass('one two three four', 2)
    expect(html.match(/<span class="reveal-word">/g)?.length).toBe(2)
  })
})
