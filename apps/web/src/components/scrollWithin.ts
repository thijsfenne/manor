/**
 * Brings `target` into view by scrolling `scroller` alone, for the transcript's jumps
 * (Show source, search hits, revealed cards).
 *
 * `scrollIntoView` walks every scrollable ancestor, and a box with `overflow: hidden`
 * still scrolls from script. When the transcript is already at its end and cannot
 * centre the target, the browser hands the rest of the distance to the app frame,
 * which then slides up and leaves a band under the composer. This aims the scroller
 * only and clamps to its range, so a target that cannot centre just stays put.
 *
 * The target's scroll margins count, as they do for `scrollIntoView`: a card's margins
 * stand for the header and the composer floating over the thread.
 */
export function scrollWithin(
  scroller: HTMLElement,
  target: HTMLElement,
  { block, behavior = 'auto' }: { block: 'center' | 'start'; behavior?: ScrollBehavior },
): void {
  const style = getComputedStyle(target)
  const marginTop = parseFloat(style.scrollMarginTop) || 0
  const marginBottom = parseFloat(style.scrollMarginBottom) || 0
  const top = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - marginTop
  const height = target.offsetHeight + marginTop + marginBottom
  const wanted = block === 'start' ? top : top - (scroller.clientHeight - height) / 2
  const next = Math.max(0, Math.min(wanted, scroller.scrollHeight - scroller.clientHeight))
  if (Math.abs(next - scroller.scrollTop) < 1) return
  scroller.scrollTo({ top: next, behavior })
}
