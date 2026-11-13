import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { UserBubble } from '../src/components/Bubbles'
import { Markdown } from '../src/components/Markdown'
import { IMAGE_VIEWER_BOUNDS } from '../src/components/ui/ZoomableImage'

const PIXEL = 'data:image/webp;base64,UklGRg=='
// Markdown is not a place a data URL survives: react-markdown drops every protocol
// but the handful it trusts, so a written image has to arrive over http(s).
const LINKED = 'https://example.com/chart.png'

/**
 * Every picture in the thread is a press away from being readable, whichever route
 * it arrived by: attached to a message, or written into an agent's markdown. The
 * viewer itself is a portal and needs a DOM, which this suite has not got; what it
 * guards is the wiring, that no surface still renders a dead <img>.
 */
describe('image zoom', () => {
  it('makes an attached image a control that says what pressing it does', () => {
    const html = renderToStaticMarkup(
      <UserBubble text="" agents={[]} skills={[]} images={[{ name: 'shot.png', dataUrl: PIXEL }]} />,
    )
    expect(html).toContain('aria-label="Enlarge shot.png"')
    expect(html).toContain(`src="${PIXEL}"`)
  })

  it('sets sent images above the bubble as 60px squares, with no empty bubble under them', () => {
    const imageOnly = renderToStaticMarkup(
      <UserBubble text="" agents={[]} skills={[]} images={[{ name: 'shot.png', dataUrl: PIXEL }]} />,
    )
    expect(imageOnly).toContain('h-15 w-15')
    expect(imageOnly).not.toContain('bg-user-bubble')
    const withText = renderToStaticMarkup(
      <UserBubble text="look" agents={[]} skills={[]} images={[{ name: 'shot.png', dataUrl: PIXEL }]} />,
    )
    expect(withText.indexOf('Enlarge shot.png')).toBeLessThan(withText.indexOf('bg-user-bubble'))
  })

  it('makes an image inside a reply one too', () => {
    const html = renderToStaticMarkup(<Markdown text={`![a chart](${LINKED})`} />)
    expect(html).toContain('aria-label="Enlarge a chart"')
    expect(html).toContain('alt="a chart"')
  })

  it('names the act even when the image describes nothing', () => {
    const html = renderToStaticMarkup(<Markdown text={`![](${LINKED})`} />)
    expect(html).toContain('aria-label="Enlarge image"')
  })

  it('renders nothing for a source markdown could not resolve', () => {
    const html = renderToStaticMarkup(<Markdown text="![missing]()" />)
    expect(html).not.toContain('<img')
    expect(html).not.toContain('<button')
  })

  it('keeps the enlarged image inside the dynamic viewport', () => {
    expect(IMAGE_VIEWER_BOUNDS).toContain('100dvh-3rem')
    expect(IMAGE_VIEWER_BOUNDS).toContain('100dvw-3rem')
  })
})
