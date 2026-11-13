import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Markdown } from '../src/components/Markdown'

describe('single-use connect links in Markdown', () => {
  it('never loads a Composio sign-in link as an image, and still shows other images', () => {
    const html = renderToStaticMarkup(<Markdown text="![sign in](https://connect.composio.dev/link/lk_single_use)" />)
    expect(html).not.toContain('composio.dev')
    expect(html).not.toContain('<img')
    expect(renderToStaticMarkup(<Markdown text="![chart](https://example.com/chart.png)" />)).toContain(encodeURIComponent('https://example.com/chart.png'))
  })
})
