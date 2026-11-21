import { renderToStaticMarkup } from 'react-dom/server'
import { CLAY, _layout, blobatar, clayTones } from '@manor/blobatar'
import { _parts } from '@manor/blobatar/internal'
import { mad, sad } from '@manor/blobatar/expression'
import { Blobatar } from '@manor/blobatar/react'
import { describe, expect, it } from 'vitest'

const defined = (markup: string) => [...markup.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1])
const referenced = (markup: string) => [...markup.matchAll(/(?:url\(#|href="#)([^)"]+)/g)].map((match) => match[1])
const hexes = (markup: string) => new Set(markup.match(/#[0-9a-f]{6}\b/gi))

describe('the clay finish', () => {
  it('keeps the flat default output fixed', () => {
    // FNV-1a over fifty default faces, retaken when the eyes became ovals and some were lifted. A change
    // to the layout ranges moves it; a change to the finish must not.
    let hash = 2166136261
    for (let i = 0; i < 50; i++) for (const c of blobatar(`p${i}`, { size: 24 })) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619) >>> 0
    expect(hash.toString(16)).toBe('1ad2fc2e')
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

  it('draws nothing on the ground, and keeps its defs ahead of a still pose', () => {
    for (const size of [20, 32, 64]) expect(blobatar('Wren', { shading: 'clay', size })).not.toContain('<ellipse')
    const posed = blobatar('Wren', { shading: 'clay', expression: sad })
    expect(posed).not.toContain('<ellipse')
    expect(posed).toContain('<defs>')
    expect(posed.indexOf('<defs>')).toBeLessThan(posed.indexOf('<g transform='))
  })

  it('relights the finish from the head, so a tint on the head carries the finish with it', () => {
    // A still face is painted from the palette it wears, the tinted one under a tinting pose.
    const flat = blobatar('Wren', { expression: mad })
    const { hi, lo, deep } = clayTones(_layout('Wren', { expression: mad }).palette.head!)
    expect(hexes(blobatar('Wren', { expression: mad, shading: 'clay' }))).toEqual(new Set([...hexes(flat), hi, lo, deep]))

    // An animated face keeps the colours out of its markup and takes them from the pose.
    const rest = _parts('Wren', { shading: 'clay', idPrefix: 'a', animate: 'always' })
    const hot = _parts('Wren', { shading: 'clay', idPrefix: 'a', animate: 'always', expression: mad })
    expect(rest.inner).toContain('var(--mo-hi)')
    expect(hexes(rest.inner).has(clayTones(_layout('Wren').palette.head!).hi)).toBe(false)
    expect(hot.vars?.['--mo-hi']).toBe(hi)
    expect(rest.vars?.['--mo-hi']).not.toBe(hi)
    expect(_parts('Wren', { animate: 'always' }).vars?.['--mo-hi']).toBeUndefined()
  })

  it('draws by optical size: the light alone when small, the full finish above', () => {
    const small = blobatar('Wren', { shading: 'clay', size: CLAY.small })
    const middle = blobatar('Wren', { shading: 'clay', size: CLAY.small + 4 })
    const large = blobatar('Wren', { shading: 'clay', size: 96 })
    // A filter per list row is the costly part of the finish, and haze at that size.
    expect(small).not.toContain('<filter')
    expect(middle.match(/<filter/g)).toHaveLength(2)
    expect(defined(large)).toHaveLength(defined(middle).length)
    // The light, the soft highlight and the eye sheen; no glint at any size.
    expect(large.match(/<radialGradient/g)).toHaveLength(3)
  })

  it('grows the eyes of a small face and leaves a larger one its own', () => {
    const eyes = (markup: string) => [...markup.slice(markup.lastIndexOf('<g fill=')).matchAll(/ d="([^"]+)"/g)].map((match) => match[1]!)
    const width = (d: string) => {
      const xs = [...d.matchAll(/(-?[\d.]+)[ ,](-?[\d.]+)/g)].map((pair) => Number(pair[1]))
      return Math.max(...xs) - Math.min(...xs)
    }
    const flat = eyes(blobatar('Wren'))
    const small = eyes(blobatar('Wren', { shading: 'clay', size: 20 }))
    expect(small).toHaveLength(2)
    expect(width(small[0]!)).toBeGreaterThan(width(flat[0]!) * 1.05)
    // Past the small size each eye is its own again: the lit lip, the eye, its sheen.
    const large = eyes(blobatar('Wren', { shading: 'clay', size: 64 }))
    expect(large).toHaveLength(6)
    expect(large[1]).toBe(flat[0])
    expect(large[2]).toBe(flat[0])
    // Light eyes on a dark head get none: white on white is nothing.
    const ink = blobatar('Wren', { shading: 'clay', size: 64, tone: 0.97 })
    expect(clayTones(_layout('Wren', { tone: 0.97 }).palette.head!).dark).toBe(true)
    expect(eyes(ink)).toHaveLength(4)
  })

  it('lifts the eyes of some faces into the headroom, never shrinking them', () => {
    const at = (lift: number, gaze = 0) => _layout('Wren', { traits: { 'eye.lift': lift, 'gaze.y': gaze } }).eyes[0]!
    for (const gaze of [0, 0.999]) {
      expect(at(0.999, gaze).cy).toBeLessThan(at(0, gaze).cy)
      expect(at(0.999, gaze).rx).toBe(at(0, gaze).rx)
    }
    // The lower half of the trait is no lift at all.
    expect(at(0.4).cy).toBe(at(0).cy)
  })
})
