import { workCardInView, type ScreenSpan } from '@manor/client-runtime/state'

/**
 * The open Session cards the thread counts as shown, which the bar above the composer
 * leaves out. Only a card measured out of view gets a row in the bar. A card that has
 * just arrived is not measured yet; listing it at once grows the footer, the list moves
 * to keep its end above it, the card is then measured in view and its row goes again,
 * and the thread jumps on each of those steps.
 */
export function cardsShownInThread(openKeys: readonly string[], measuredOut: ReadonlySet<string>): ReadonlySet<string> {
  return new Set(openKeys.filter((key) => !measuredOut.has(key)))
}

/**
 * Whether a measured card is out of view, so the bar lists it. A card the list has not
 * rendered sits in history and is out. `settlingAtEnd` marks the measurement in the frame
 * after the rows changed while the list keeps its end in view: the list lays a new or grown
 * row out first and pins its end a frame later, so a card reaching below the visible part
 * is on its way in and must not get a row the next measurement drops. Any later
 * measurement, after a scroll or a new bar height, takes the card where it is.
 */
export function workCardOut(card: ScreenSpan | undefined, view: ScreenSpan, settlingAtEnd: boolean): boolean {
  if (card === undefined) return true
  if (settlingAtEnd && card.bottom > view.bottom) return false
  return !workCardInView(card, view)
}
