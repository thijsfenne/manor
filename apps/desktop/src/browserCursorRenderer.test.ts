import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { browserCursorAppearance } from './browserCursorAppearance'
import { createBrowserCursorRenderer, type BrowserCursorRenderer } from './browserCursorRenderer'

function surface(reduced = false) {
  const nodes: Array<ReturnType<typeof element>> = []
  const pending: Array<{ finish(): void; cancel: ReturnType<typeof vi.fn> }> = []
  function element() {
    return {
      style: {} as Record<string, string>, innerHTML: '', remove: vi.fn(),
      animate: vi.fn((_frames: unknown, _options: unknown) => {
        let finish = () => {}
        let reject = () => {}
        const finished = new Promise<void>((resolve, fail) => { finish = resolve; reject = () => fail(new Error('Cancelled')) })
        const cancel = vi.fn(reject)
        pending.push({ finish, cancel })
        return { finished, cancel }
      }),
    }
  }
  const context = {
    document: { createElement: () => { const node = element(); nodes.push(node); return node } },
    matchMedia: () => ({ matches: reduced }),
  }
  // Exercise the exact serialization boundary: no runtime imports in the factory.
  const factory = runInNewContext(`(${createBrowserCursorRenderer.toString()})`, context) as typeof createBrowserCursorRenderer
  const create = (): BrowserCursorRenderer => factory({ append: () => {} } as unknown as ShadowRoot, browserCursorAppearance)
  return { nodes, pending, create }
}

describe('browser cursor visuals', () => {
  const move = { actionId: 'one', phase: 'move' as const, x: 50, y: 80 }

  it('settles an interrupted animation, removes visuals and never renders after disposal', async () => {
    const { create, pending, nodes } = surface()
    const renderer = create()
    const rendering = renderer.render(move)
    renderer.dispose()
    await rendering
    expect(pending[0]?.cancel).toHaveBeenCalledOnce()
    expect(nodes.every((node) => node.remove.mock.calls.length === 1)).toBe(true)
    await renderer.render({ ...move, phase: 'click' })
    expect(pending).toHaveLength(1)
  })

  it('moves from the last actual target across actions and shows finite click feedback', async () => {
    const { create, pending, nodes } = surface()
    const first = create()
    const arriving = first.render(move)
    pending[0]!.finish()
    await arriving
    first.dispose()
    const second = create()
    const moving = second.render({ ...move, actionId: 'two', x: 150 })
    expect(nodes[2]!.animate).toHaveBeenCalledWith([
      { transform: 'translate(47px, 77px)' }, { transform: 'translate(147px, 77px)' },
    ], { duration: 150, easing: 'ease-out' })
    pending[1]!.finish()
    await moving
    const clicking = second.render({ ...move, actionId: 'two', phase: 'click', x: 150 })
    expect(nodes[3]!.style.left).toBe('138px')
    expect(nodes[3]!.style.top).toBe('68px')
    pending[2]!.finish()
    await clicking
    second.dispose()
  })

  it('respects reduced motion while preserving visible click acknowledgement', async () => {
    const { create, pending, nodes } = surface(true)
    const renderer = create()
    await renderer.render(move)
    expect(pending).toHaveLength(0)
    expect(nodes[0]!.style.transform).toBe('translate(47px, 77px)')
    const clicking = renderer.render({ ...move, phase: 'click' })
    expect(nodes[1]!.animate).toHaveBeenCalledWith([{ opacity: 1 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' })
    renderer.dispose()
    await clicking
  })
})
