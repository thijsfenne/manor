/**
 * Scrollbars that show only while the user scrolls. One listener for the app: a scroller
 * the user moves gets `data-scrollbar="on"`, and a second after its last movement turns
 * `off`, which styles.css fades out. A new scroller needs nothing.
 *
 * Only a scroll that follows the user's own input inside that scroller counts (wheel,
 * touch, a scroll key outside a text field, a press on its bar or content), so a
 * transcript following a reply as it streams keeps its bar hidden, also while the user
 * types in the composer or scrolls another pane.
 */
const HIDE_AFTER_MS = 1000
// How long after an input its scroll still counts; covers smooth scrolling from the
// keyboard, a click on the track, and a trackpad's momentum between its wheel events.
const INPUT_WINDOW_MS = 500
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' '])
const TEXT_FIELD = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'

type Scroller = Pick<Element, 'getAttribute' | 'setAttribute' | 'contains'>
type InputEvent = { target: unknown; key?: string }
type Root = {
  documentElement: Scroller
  body: unknown
  addEventListener(type: string, listener: (event: InputEvent) => void, options: AddEventListenerOptions): void
}

export function installScrollbarReveal(root: Root, now: () => number = () => performance.now()): void {
  let input: { target: unknown; at: number; press?: boolean } | undefined
  // Held for a drag on the bar, which can outlast the input window.
  let pressed: unknown
  let lastPress: unknown
  const timers = new WeakMap<Scroller, ReturnType<typeof setTimeout>>()
  const options = { capture: true, passive: true }
  const note = (target: unknown, press = false) => {
    input = { target, at: now(), press }
  }
  root.addEventListener('wheel', ({ target }) => note(target), options)
  root.addEventListener('touchmove', ({ target }) => note(target), options)
  root.addEventListener('keydown', ({ key, target }) => {
    if (key === undefined || !SCROLL_KEYS.has(key) || (target as Partial<Element> | null)?.closest?.(TEXT_FIELD)) return
    // With nothing focused the keys scroll whatever was last pressed, as the browser does.
    note(target === root.body ? lastPress : target)
  }, options)
  root.addEventListener('pointerdown', ({ target }) => {
    pressed = lastPress = target
    note(target, true)
  }, options)
  root.addEventListener('pointerup', () => void (pressed = undefined), options)
  root.addEventListener('pointercancel', () => void (pressed = undefined), options)

  root.addEventListener('scroll', ({ target }) => {
    const scroller = target === root ? root.documentElement : (target as Scroller)
    if (typeof scroller?.contains !== 'function') return
    const inside = (node: unknown) => node != null && scroller.contains(node as Node)
    // A released press counts only on the bar itself (a click on the track), not on the
    // content, so a click in a streaming thread does not light up its bar.
    const recent = input !== undefined && now() - input.at <= INPUT_WINDOW_MS && (input.press ? input.target === scroller : inside(input.target))
    if (!recent && !inside(pressed)) return
    if (scroller.getAttribute('data-scrollbar') !== 'on') scroller.setAttribute('data-scrollbar', 'on')
    clearTimeout(timers.get(scroller))
    timers.set(scroller, setTimeout(() => scroller.setAttribute('data-scrollbar', 'off'), HIDE_AFTER_MS))
  }, options)
}
