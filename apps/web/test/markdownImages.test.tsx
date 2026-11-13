import { renderToStaticMarkup } from 'react-dom/server'
import { act, create } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import { REMOTE_IMAGE_PATH } from '@manor/contracts'
import { Markdown } from '../src/components/Markdown'

const PHOTO = 'https://example.com/bed bug.jpg'
const PROXIED = `${REMOTE_IMAGE_PATH}?url=${encodeURIComponent(new URL(PHOTO).href)}`
const PIXEL = 'data:image/png;base64,iVBORw0KGgo='

describe('markdown images', () => {
  it('loads a remote picture through Manor, holding its space while it loads', () => {
    const html = renderToStaticMarkup(<Markdown text={`![Volwassen bedwants](<${PHOTO}>)`} />)
    expect(html).toContain(`src="${PROXIED.replace(/&/g, '&amp;')}"`)
    expect(html).toContain('alt="Volwassen bedwants"')
    expect(html).toContain('h-[320px]')
    expect(html).not.toContain('!')
  })

  it('shows the picture in a reply that is still streaming', () => {
    const html = renderToStaticMarkup(<Markdown reveal text={'Kijk:\n\n![Volwassen bedwants](https://example.com/bug.jpg)\n\nDit is een'} />)
    expect(html).toContain(`src="${REMOTE_IMAGE_PATH}?url=${encodeURIComponent('https://example.com/bug.jpg')}"`)
    expect(html).toContain('aria-label="Enlarge Volwassen bedwants"')
  })

  it('falls back to a link with the alt text when the picture fails', () => {
    let tree: ReturnType<typeof create>
    act(() => { tree = create(<Markdown text={`![Volwassen bedwants](${'https://example.com/bug.jpg'})`} />) })
    act(() => tree.root.findByType('img').props.onError())
    expect(tree!.root.findAllByType('img')).toHaveLength(0)
    const link = tree!.root.findByType('a')
    expect(link.props.href).toBe('https://example.com/bug.jpg')
    expect(JSON.stringify(tree!.toJSON())).toContain('Volwassen bedwants')
    expect(JSON.stringify(tree!.toJSON())).not.toContain('!')
  })

  it('leaves the click to the link a picture sits inside', () => {
    const html = renderToStaticMarkup(<Markdown text={'[![logo](https://example.com/logo.png)](https://example.com)'} />)
    expect(html).toContain('<img')
    expect(html).not.toContain('<button')
  })

  it('shows a raster data URL as itself, and only the alt text for one that cannot load', () => {
    expect(renderToStaticMarkup(<Markdown text={`![dot](${PIXEL})`} />)).toContain(`src="${PIXEL}"`)
    const svg = renderToStaticMarkup(<Markdown text="![drawing](data:image/svg+xml;base64,PHN2Zz4=)" />)
    expect(svg).not.toContain('<img')
    expect(svg).toContain('drawing')
  })
})
