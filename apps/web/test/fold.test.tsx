import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Fold } from '../src/components/ui/Fold'

const render = (open: boolean) =>
  renderToStaticMarkup(
    <Fold open={open}>
      <ul>
        <li>a chat</li>
      </ul>
    </Fold>,
  )

describe('a folding sidebar section', () => {
  /**
   * The one thing that must not be tidied away later. Rendering nothing when
   * closed is the obvious shape and it is the bug: there is no element left to
   * animate, so the list stops folding and starts blinking out.
   */
  it('keeps its contents in the tree when closed', () => {
    expect(render(false)).toContain('a chat')
    expect(render(true)).toContain('a chat')
  })

  it('says which way it is, because the CSS reads that and not a class', () => {
    expect(render(true)).toContain('data-open="true"')
    expect(render(false)).toContain('data-open="false"')
  })

  it('wraps the contents in the element that does the clipping', () => {
    // `.fold > *` is what hides the overflow, and a grid track cannot collapse
    // past content that does not. Losing this wrapper silently stops the fold.
    expect(render(true)).toMatch(/<div class="fold[^"]*" data-open="true"><div>/)
  })
})
