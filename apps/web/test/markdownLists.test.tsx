import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from '../src/components/Markdown'

/**
 * The shape agents actually send: numbered steps with their bullets written flush
 * left instead of indented. CommonMark reads that as three separate ordered lists,
 * the second starting at 2, so the renderer has to carry `start` or every step
 * renders as step one.
 */
const CHECKLIST = [
  '1. Inbox',
  '',
  '- Wissel tussen Projects en Inbox.',
  '',
  '2. Projectkiezer',
  '',
  '- Open en zoek op projectnaam.',
  '',
  '3. Regressies',
  '',
  '- Project-hovercard openen.',
].join('\n')

describe('markdown lists', () => {
  it('keeps the numbering of steps split apart by their own bullets', () => {
    const html = renderToStaticMarkup(<Markdown text={CHECKLIST} />)
    expect(html).toContain('<ol start="2"')
    expect(html).toContain('<ol start="3"')
    // The first list is the only one that may omit it.
    expect(html.match(/<ol\b/g)).toHaveLength(3)
  })

  it('indents a bullet list that continues the numbered item above it', () => {
    const html = renderToStaticMarkup(<Markdown text={CHECKLIST} />)
    expect(html).toContain('[&amp;&gt;ol+ul]:ml-5')
  })

  it('leaves a properly nested list alone', () => {
    const html = renderToStaticMarkup(<Markdown text={'1. One\n   - nested\n2. Two'} />)
    expect(html.match(/<ol\b/g)).toHaveLength(1)
    expect(html).not.toContain('<ol start=')
  })
})
