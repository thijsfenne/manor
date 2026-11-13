import { renderToStaticMarkup } from 'react-dom/server'
import { blobatar } from '@manor/blobatar'
import { _parts } from '@manor/blobatar/internal'
import { mad, sad } from '@manor/blobatar/expression'
import { Blobatar } from '@manor/blobatar/react'
import { describe, expect, it } from 'vitest'

const defined = (markup: string) => [...markup.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1])
const referenced = (markup: string) => [...markup.matchAll(/(?:url\(#|href="#)([^)"]+)/g)].map((match) => match[1])
const hexes = (markup: string) => new Set(markup.match(/#[0-9a-f]{6}\b/gi))

describe('the clay finish', () => {
  it('leaves the default output exactly as it was', () => {
    // FNV-1a over fifty default faces, taken from the output before `shading` existed.
    let hash = 2166136261
    for (let i = 0; i < 50; i++) for (const c of blobatar(`p${i}`, { size: 24 })) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0
    expect(hash.toString(16)).toBe('a5947cf1')
    expect(blobatar('Wren', { shading: undefined, idPrefix: 'x' })).toBe(blobatar('Wren'))
  })

  it('gives every render its own ids, and every reference a target', () => {
    const one = blobatar('Wren', { shading: 'clay' })
    const two = blobatar('Wren', { shading: 'clay' })
    expect(defined(one).length).toBeGreaterThan(0)
    expect(new Set(defined(one)).size).toBe(defined(one).length)
    expect(defined(one).filter((id) => defined(two).includes(id))).toEqual([])
    expect(referenced(one).every((id) => defined(one).includes(id))).toBe(true)
    expect(defined(blobatar('Wren', { shading: 'clay', idPrefix: 'r7' })).every((id) => id?.startsWith('sr7-'))).toBe(true)
  })

  it('keeps ids apart for two faces on one page, and stable across a pose change', () => {
    const page = renderToStaticMarkup(
      <>
        <Blobatar name="Wren" shading="clay" animate="always" />
        <Blobatar name="Wren" shading="clay" animate="always" />
      </>,
    )
    // Inline faces share one document; a still face is an <img>, a document of its own.
    const ids = defined(page)
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)

    // Still faces are <img>s with documents of their own, so identical ones share a URL.
    const still = renderToStaticMarkup(<><Blobatar name="Wren" shading="clay" /><Blobatar name="Wren" shading="clay" /></>)
    const [first, second] = [...still.matchAll(/src="([^"]+)"/g)].map((match) => match[1])
    expect(first).toBe(second)

    // The morph needs `inner` untouched by the expression, shading included.
    const rest = _parts('Wren', { shading: 'clay', idPrefix: 'a', animate: 'always' })
    const hot = _parts('Wren', { shading: 'clay', idPrefix: 'a', animate: 'always', expression: mad })
    expect(hot.inner).toBe(rest.inner)
  })

  it('keeps the contact shadow on the ground when a still pose moves the figure', () => {
    const posed = blobatar('Wren', { shading: 'clay', expression: sad })
    expect(posed).toContain('<g transform=')
    expect(posed.indexOf('<ellipse')).toBeLessThan(posed.indexOf('<g transform='))
  })

  it('shades in neutral overlays, so a tint on the head carries the finish with it', () => {
    const flat = blobatar('Wren', { expression: mad })
    const clay = blobatar('Wren', { expression: mad, shading: 'clay' })
    expect(hexes(clay)).toEqual(hexes(flat))
  })
})
