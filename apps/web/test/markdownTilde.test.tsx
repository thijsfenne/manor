import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from '../src/components/Markdown'

describe('markdown tildes', () => {
  it('leaves single tildes in a path as text and still strikes a double pair', () => {
    const path = renderToStaticMarkup(<Markdown text="Saved to ~/Library/Mobile Documents/com~apple~CloudDocs/notes" />)
    expect(path).not.toContain('<del')
    expect(path).toContain('com~apple~CloudDocs')
    expect(renderToStaticMarkup(<Markdown text="~~gone~~" />)).toMatch(/<del[^>]*>gone<\/del>/)
  })
})
