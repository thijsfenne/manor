import { renderToStaticMarkup } from 'react-dom/server'
import { act, create } from 'react-test-renderer'
import { Blobatar } from '@manor/blobatar/react'
import { _layout, palette } from '@manor/blobatar'
import { unsure } from '@manor/blobatar/expression'
import { BLOB_FACE_TRAITS, BLOB_TONES, SIDEBAR_WORKING_GAZE } from '../src/blobShapes'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accentHue } from '../src/accent'
import { Avatar } from '../src/components/Avatar'

const motion = vi.hoisted(() => ({ reduced: false }))
vi.mock('motion/react', async (original) => ({
  ...(await original<typeof import('motion/react')>()),
  useReducedMotion: () => motion.reduced,
}))

afterEach(() => { vi.unstubAllGlobals(); motion.reduced = false })

/** Renders the way a reader who asked for reduced motion sees it. */
const stillRender = (element: Parameters<typeof renderToStaticMarkup>[0]) => {
  motion.reduced = true
  try { return renderToStaticMarkup(element) } finally { motion.reduced = false }
}

/** A rendered slot with no face drawn in it yet, so the busy loop finds nothing to move. */
const faceNode = { querySelector: () => null, querySelectorAll: () => [] }

/** Animated SVG properties and the corresponding colours in a resting SVG image. */
const stillColors = (html: string) => [...html.matchAll(/%23([0-9a-f]{6})/ig)].map((match) => `#${match[1]}`)
const head = (html: string) => /--mo-head:(#[0-9a-f]{6})/i.exec(html)?.[1] ?? stillColors(html)[0]
const eye = (html: string) => /--mo-eye:([^;"]+)/i.exec(html)?.[1] ?? stillColors(html)[1]

describe('the face of a persona with no picture', () => {
  it('draws her a blobatar seeded on her name', () => {
    const wren = renderToStaticMarkup(<Avatar name="Wren" color="#C77DBB" size={26} />)
    const iris = renderToStaticMarkup(<Avatar name="Iris" color="#C77DBB" size={26} />)

    expect(wren).toContain('data-avatar="blobatar"')
    expect(wren).toContain('width:26px;height:26px')
    expect(wren).toContain('width="26" height="26"')
    // Same colour, different names: the shape is hers and nobody else's.
    expect(wren).not.toBe(iris)
  })

  it('gives the same name the same face every time', () => {
    const once = renderToStaticMarkup(<Avatar name="Wren" color="#C77DBB" size={26} />)
    const again = renderToStaticMarkup(<Avatar name="Wren" color="#C77DBB" size={26} />)

    expect(once).toBe(again)
  })

  it('paints it in her accent rather than in a colour of its own', () => {
    const pink = head(renderToStaticMarkup(<Avatar name="Wren" color="#C77DBB" size={26} />))
    const teal = head(renderToStaticMarkup(<Avatar name="Wren" color="#6FA8A0" size={26} />))
    if (pink === undefined || teal === undefined) throw new Error('The blobatar rendered no body colour')

    // Not merely different: each body lands on the hue its accent asked for.
    expect(accentHue(pink)).toBeCloseTo(accentHue('#C77DBB') ?? -1, 0)
    expect(accentHue(teal)).toBeCloseTo(accentHue('#6FA8A0') ?? -1, 0)
  })

  it('uses the chosen swatch and the library eye contrast, including while working', () => {
    for (const { value: tone } of BLOB_TONES) {
      const expected = palette(accentHue('#C77DBB')!, true, tone)
      const resting = renderToStaticMarkup(<Avatar name="Wren" color="#C77DBB" tone={tone} size={26} />)
      const working = renderToStaticMarkup(<Avatar name="Wren" color="#C77DBB" tone={tone} size={26} working />)
      const still = stillRender(<Avatar name="Wren" color="#C77DBB" tone={tone} size={26} working />)
      expect(head(resting)).toBe(expected.head)
      expect(eye(resting)).toBe(expected.eye)
      expect(head(working)).toBe(expected.head)
      expect(eye(working)).toBe(expected.eye)
      expect(dot(still)).toBe(expected.head)
    }
  })

  it('keeps the deep swatch when no tone is stored', () => {
    expect(renderToStaticMarkup(<Avatar name="Wren" color="#C77DBB" size={26} />)).toBe(
      renderToStaticMarkup(<Avatar name="Wren" color="#C77DBB" tone={0.7} size={26} />),
    )
  })

  it('still draws a face when the colour is a token instead of a hex', () => {
    // What the group dialog hands an unknown member. The name picks the hue.
    const html = renderToStaticMarkup(<Avatar name="marlow" color="var(--color-dim)" size={22} />)

    expect(html).toContain('data-avatar="blobatar"')
    expect(head(html)).toBeDefined()
  })

  it('starts still before visibility and focus are known', () => {
    const dialog = renderToStaticMarkup(<Avatar name="Wren" color="#C77DBB" size={72} />)
    const listed = renderToStaticMarkup(<Avatar name="Wren" color="#C77DBB" size={18} />)

    expect(dialog).not.toContain('mo-always')
    expect(listed).not.toContain('mo-always')
  })

  it('animates visible faces only for focus, hover or work', () => {
    let observe: ((entries: { isIntersecting: boolean }[]) => void) | undefined
    let focused = false
    const windowEvents = new Map<string, () => void>()
    const documentEvents = new Map<string, () => void>()
    const page = { visibilityState: 'visible', hasFocus: () => focused,
      addEventListener: (name: string, listener: () => void) => documentEvents.set(name, listener),
      removeEventListener: (name: string) => documentEvents.delete(name) }
    vi.stubGlobal('document', page)
    vi.stubGlobal('window', {
      addEventListener: (name: string, listener: () => void) => windowEvents.set(name, listener),
      removeEventListener: (name: string) => windowEvents.delete(name),
    })
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: typeof observe) { observe = callback }
      observe() {}
      disconnect() {}
    })
    let tree!: ReturnType<typeof create>
    act(() => { tree = create(<Avatar name="Wren" color="#C77DBB" size={26} />, { createNodeMock: () => faceNode }) })
    act(() => observe?.([{ isIntersecting: true }]))
    expect(tree.root.findByType(Blobatar).props.animate).toBeUndefined()
    const slot = tree.root.findByProps({ 'data-avatar': 'blobatar' })
    act(() => slot.props.onPointerEnter())
    expect(tree.root.findByType(Blobatar).props.animate).toBe('always')
    act(() => slot.props.onPointerLeave())
    expect(tree.root.findByType(Blobatar).props.animate).toBeUndefined()
    focused = true
    act(() => windowEvents.get('focus')?.())
    expect(tree.root.findByType(Blobatar).props.animate).toBe('always')
    focused = false
    act(() => windowEvents.get('blur')?.())
    expect(tree.root.findByType(Blobatar).props.animate).toBeUndefined()
    act(() => tree.update(<Avatar name="Wren" color="#C77DBB" size={26} working />))
    expect(tree.root.findByType(Blobatar).props.animate).toBe('always')
    page.visibilityState = 'hidden'
    act(() => documentEvents.get('visibilitychange')?.())
    expect(tree.root.findByType(Blobatar).props.animate).toBeUndefined()
    act(() => tree.unmount())
  })

  it('wears the silhouette she was given, and her name picks one when she was not', () => {
    const seeded = renderToStaticMarkup(<Avatar name="Wren" color="#C77DBB" size={46} />)
    const sun = renderToStaticMarkup(<Avatar name="Wren" color="#C77DBB" shape="sun" size={46} />)
    const hexagon = renderToStaticMarkup(<Avatar name="Wren" color="#C77DBB" shape="hexagon" size={46} />)

    expect(sun).not.toBe(hexagon)
    expect(sun).not.toBe(seeded)
    // A shape saved by a build that knew more shapes than this one is not a face
    // thrown away: it falls back to the seeded silhouette.
    expect(renderToStaticMarkup(<Avatar name="Wren" color="#C77DBB" shape="rhombus" size={46} />)).toBe(seeded)
  })

  it('drops the one high-drawing silhouette down to the name beside it', () => {
    const triangle = renderToStaticMarkup(<Avatar name="Smith" color="#C77DBB" shape="triangle" size={24} />)
    const round = renderToStaticMarkup(<Avatar name="Smith" color="#C77DBB" shape="round" size={24} />)

    // 7% of what is drawn, which now shares the slot's exact size.
    expect(triangle).toContain('translateY(1.68px)')
    expect(round).not.toContain('translateY')
    expect(renderToStaticMarkup(<Avatar name="Smith" color="#C77DBB" shape="triangle" size={24} center />)).not.toContain('translateY(')
    expect(renderToStaticMarkup(<Avatar name="Smith" color="#C77DBB" shape="triangle" size={24} center />)).not.toContain('translate-')
  })

  it('leaves a persona who has a picture wearing it', () => {
    const picture = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=='
    const html = renderToStaticMarkup(<Avatar name="Smith" color="#D08A3E" src={picture} size={26} />)

    expect(html).not.toContain('data-avatar="blobatar"')
    expect(html).toContain(picture)
  })
})

/** The colour of the transcript's rising dots. */
const dot = (html: string) => /--dot:([^;"]+)/.exec(html)?.[1]

describe('the face of a persona whose turn is running', () => {
  it('runs the busy loop in a bubble instead of thought dots', () => {
    const html = renderToStaticMarkup(<Avatar name="Wren" color="#C77DBB" size={32} working />)

    expect(html).toContain('mo-always')
    // The loop moves the eyes itself; breathing and bob stay off under it.
    expect(html).not.toContain('data-working')
    expect(html).not.toContain('thought-dots')
    expect(html).not.toContain('data-sidebar-working')
  })

  it('keeps the still face and its thought dots when motion is reduced', () => {
    const html = stillRender(<Avatar name="Wren" color="#C77DBB" size={32} working />)

    expect(html).toContain('thought-dots')
    expect(html).toContain('data-working="true"')
    expect(dot(html)).toBe(head(html))
    expect(html).not.toBe(stillRender(<Avatar name="Wren" color="#C77DBB" size={32} />))
  })

  it('looks toward the upper right with one eye squinted in the sidebar', () => {
    const html = renderToStaticMarkup(<Avatar name="Wren" color="#C77DBB" size={32} sidebarWorking />)
    const working = _layout('Wren', { traits: { ...BLOB_FACE_TRAITS, ...SIDEBAR_WORKING_GAZE }, expression: unsure })
    const neutral = _layout('Wren', { traits: { ...BLOB_FACE_TRAITS, 'gaze.x': 0.5, 'gaze.y': 0.714 } })

    expect(html).toContain('data-sidebar-working="true"')
    expect(html).not.toContain('thought-dots')
    expect(working.eyes[0]!.cx).toBeGreaterThan(neutral.eyes[0]!.cx)
    expect(working.eyes[0]!.cy).toBeLessThan(neutral.eyes[0]!.cy)
    expect(working.eyes[1]!.ry).toBeLessThan(working.eyes[0]!.ry)
    expect(html).not.toBe(renderToStaticMarkup(<Avatar name="Wren" color="#C77DBB" size={32} />))
  })

  it('returns to her resting expression once the turn has settled', () => {
    const settled = renderToStaticMarkup(<Avatar name="Wren" color="#C77DBB" size={32} />)

    expect(settled).not.toContain('data-sidebar-working')
    expect(settled).not.toContain('thought-dots')
  })

  it('keeps the portrait dots in a bubble and out of the sidebar', () => {
    const picture = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=='
    const bubble = renderToStaticMarkup(<Avatar name="Smith" color="#D08A3E" src={picture} size={32} working />)
    const sidebar = renderToStaticMarkup(<Avatar name="Smith" color="#D08A3E" src={picture} size={32} sidebarWorking />)

    expect(bubble).toContain(picture)
    expect(bubble).toContain('thought-dots')
    expect(dot(bubble)).toBe('var(--accent-fg)')
    expect(sidebar).not.toContain('thought-dots')
  })
})
