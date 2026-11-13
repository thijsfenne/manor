import { describe, expect, it } from 'vitest'
import { sourceItemHref } from './sourceLinks'

describe('sourceItemHref', () => {
  it('reads an item that is only a web link, labelled or bare', () => {
    expect(sourceItemHref('[Healio, IBD flares](https://healio.com/a)')).toBe('https://healio.com/a')
    expect(sourceItemHref(' https://pubmed.ncbi.nlm.nih.gov/123/ ')).toBe('https://pubmed.ncbi.nlm.nih.gov/123/')
    expect(sourceItemHref('<https://pmc.ncbi.nlm.nih.gov/x>')).toBe('https://pmc.ncbi.nlm.nih.gov/x')
  })

  it('refuses an item that says more, or links somewhere that is not a web page', () => {
    for (const text of [
      '[Healio](https://healio.com/a), over flares', 'Zie [Healio](https://healio.com/a)', '[mail](mailto:a@b.nl)',
      '[dev](http://localhost:5173/)', '[file](apps/web/a.ts)', 'https://example.com,', '![logo](https://example.com/logo.png)', 'gewoon tekst',
    ]) expect(sourceItemHref(text), text).toBeUndefined()
  })
})
