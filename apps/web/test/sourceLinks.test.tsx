import { renderToStaticMarkup } from 'react-dom/server'
import { act, create } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import { REMOTE_FAVICON_PATH } from '@manor/contracts'
import { Markdown } from '../src/components/Markdown'

const icon = (site: string) => `${REMOTE_FAVICON_PATH}?site=${encodeURIComponent(site)}`.replace(/&/g, '&amp;')
const render = (text: string, variant?: 'chat' | 'document') => renderToStaticMarkup(<Markdown text={text} variant={variant} />)

describe('web links in a reply', () => {
  it('draws a link inside a sentence as a pill with its site icon', () => {
    const html = render('Vooral E. coli ([Columbia-studie](https://www.cuimc.columbia.edu/news/x), [Healio](https://healio.com/a)).')
    expect(html).toContain(`src="${icon('https://www.cuimc.columbia.edu')}"`)
    expect(html).toContain(`src="${icon('https://healio.com')}"`)
    expect(html.match(/rounded-full/g)).toHaveLength(2)
  })

  it('gives a Sources list icons for bullets and plain links', () => {
    const html = render('Sources:\n\n- [Healio, IBD flares](https://healio.com/a)\n- https://pubmed.ncbi.nlm.nih.gov/123/\n')
    expect(html.match(/<li class="relative list-none/g)).toHaveLength(2)
    expect(html).toContain(`src="${icon('https://pubmed.ncbi.nlm.nih.gov')}"`)
    expect(html).not.toContain('rounded-full')
  })

  it('keeps a bullet and a pill for an item that says more than its link', () => {
    const html = render('- [Healio](https://healio.com/a), over flares\n- plain item')
    expect(html).not.toContain('relative list-none')
    expect(html.match(/rounded-full/g)).toHaveLength(1)
  })

  it('keeps numbered lists numbered', () => {
    const html = render('1. [Healio](https://healio.com/a)\n2. [PMC](https://pmc.ncbi.nlm.nih.gov/x)')
    expect(html).not.toContain('relative list-none')
    expect(html.match(/rounded-full/g)).toHaveLength(2)
  })

  it('leaves mail, local and picture links alone, and links in a note', () => {
    for (const text of [
      '[mail](mailto:a@b.nl)', '[dev](http://localhost:5173/x)', '[file](file:///Users/x/a.md)',
      '[![logo](https://example.com/logo.png)](https://example.com)',
    ]) expect(render(text), text).not.toContain(REMOTE_FAVICON_PATH)
    expect(render('Zie [Healio](https://healio.com/a)', 'document')).not.toContain(REMOTE_FAVICON_PATH)
  })

  it('falls back to a globe when the icon does not load', () => {
    let tree: ReturnType<typeof create>
    act(() => { tree = create(<Markdown text="Zie [Healio](https://healio.com/a)." />) })
    act(() => tree.root.findByType('img').props.onError())
    expect(tree!.root.findAllByType('img')).toHaveLength(0)
    expect(tree!.root.findAllByType('svg')).toHaveLength(1)
    expect(tree!.root.findByType('a').props.href).toBe('https://healio.com/a')
  })
})

describe('links in what the user wrote', () => {
  it('stay plain links, inline and in a list', () => {
    const html = renderToStaticMarkup(<Markdown text={'Zie [Healio](https://healio.com/a)\n\n- [PMC](https://pmc.ncbi.nlm.nih.gov/x)'} sources={false} />)
    expect(html).not.toContain(REMOTE_FAVICON_PATH)
    expect(html).toContain('list-disc')
  })
})
