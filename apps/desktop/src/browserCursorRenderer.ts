export interface BrowserCursorFrame {
  actionId: string
  phase: 'move' | 'click'
  /** Coordinates in the page viewport's CSS pixels, exactly as sent to CDP. */
  x: number
  y: number
}

export interface BrowserCursorRenderer {
  /** May resolve after a finite animation; the host caps the wait at one second. */
  render(frame: BrowserCursorFrame): void | Promise<void>
  /** Cancel animations and timers, and settle any pending render promise. */
  dispose(): void
}

/**
 * Wren's rendering entry point. Serialized into the page's isolated world, so keep
 * runtime dependencies inside this function. The supplied root is in a closed
 * shadow tree on a pointer-transparent top-layer host; this function owns visuals.
 */
export function createBrowserCursorRenderer(
  root: ShadowRoot,
  appearance: { color: string; outline: string; icon: string },
): BrowserCursorRenderer {
  // Retain only the last real position between actions, within this document's
  // isolated world. No cursor, animation or page state survives disposal.
  const world = globalThis as typeof globalThis & { __manorCursorPoint?: { x: number; y: number } }
  const pointer = document.createElement('div')
  pointer.style.cssText = 'position:absolute;left:0;top:0;width:24px;height:24px;pointer-events:none;opacity:0'
  pointer.innerHTML = appearance.icon
  const ring = document.createElement('div')
  ring.style.cssText = 'position:absolute;left:-12px;top:-12px;width:24px;height:24px;border:2px solid;box-sizing:border-box;border-radius:50%;pointer-events:none;opacity:0'
  ring.style.borderColor = appearance.color
  ring.style.boxShadow = `0 0 0 1px ${appearance.outline}`
  root.append(ring, pointer)
  const animations = new Set<Animation>()
  let disposed = false
  const animate = async (element: HTMLElement, frames: Keyframe[], duration: number) => {
    const animation = element.animate(frames, { duration, easing: 'ease-out' })
    animations.add(animation)
    try { await animation.finished }
    catch { /* Disposal cancels motion and releases the waiting browser action. */ }
    finally { animations.delete(animation) }
  }
  const position = (point: { x: number; y: number }) => `translate(${point.x - 3}px, ${point.y - 3}px)`
  return {
    async render(frame) {
      if (disposed || !Number.isFinite(frame.x) || !Number.isFinite(frame.y)) return
      const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
      const previous = world.__manorCursorPoint
      const target = position(frame)
      pointer.style.transform = target
      pointer.style.opacity = '1'
      world.__manorCursorPoint = { x: frame.x, y: frame.y }
      if (frame.phase === 'click') {
        ring.style.left = `${frame.x - 12}px`
        ring.style.top = `${frame.y - 12}px`
        await animate(ring, reduced
          ? [{ opacity: 1 }, { opacity: 1 }]
          : [{ opacity: 0.8, transform: 'scale(0.5)' }, { opacity: 0, transform: 'scale(1.5)' }], 220)
      } else if (!reduced) {
        await animate(pointer, previous
          ? [{ transform: position(previous) }, { transform: target }]
          : [{ opacity: 0 }, { opacity: 1 }], 150)
      }
    },
    dispose() {
      disposed = true
      for (const animation of animations) animation.cancel()
      animations.clear()
      pointer.remove()
      ring.remove()
    },
  }
}
