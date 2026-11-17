/**
 * The whole text of a cut line, as the native tooltip, while the pointer rests on it.
 * One listener for the app: any `truncate`, `line-clamp-*` or middle-cut element that is
 * actually clipped gets its text as `title`, and loses it again once it fits. A new truncated
 * label needs nothing. A tooltip the component sets on the element or around it wins,
 * also when it arrives after this one.
 */
const MARK = 'data-overflow-title'
const CUT = '.truncate, [class*="line-clamp-"], [data-middle-cut]'

type Cuttable = Pick<
  HTMLElement,
  'className' | 'scrollWidth' | 'clientWidth' | 'scrollHeight' | 'clientHeight' | 'textContent' | 'title' | 'getAttribute' | 'hasAttribute' | 'setAttribute' | 'removeAttribute'
> & {
  parentElement: { closest(selector: string): unknown } | null
  firstElementChild: { scrollWidth: number; clientWidth: number } | null
}

/** Sets or clears the tooltip of one truncating element; exported for the test. */
export function syncOverflowTitle(element: Cuttable): void {
  // The mark holds the text written here, so a title the component set since is its own.
  const mark = element.getAttribute(MARK)
  const ours = mark !== null && element.title === mark
  if (mark !== null && !ours) element.removeAttribute(MARK)
  const owned = (!ours && element.hasAttribute('title')) || element.parentElement?.closest('[title]') != null
  // A clamp clips lines, a truncate clips the end of one line, a middle cut clips its head.
  const head = element.hasAttribute('data-middle-cut') ? element.firstElementChild : null
  const clipped = head !== null
    ? head.scrollWidth > head.clientWidth
    : String(element.className).includes('line-clamp-')
      ? element.scrollHeight > element.clientHeight
      : element.scrollWidth > element.clientWidth
  const text = element.textContent?.replace(/\s+/g, ' ').trim() ?? ''
  if (!owned && clipped && text !== '') {
    element.title = text
    element.setAttribute(MARK, text)
  } else if (ours) {
    element.removeAttribute('title')
    element.removeAttribute(MARK)
  }
}

export function installOverflowTitles(root: Document): () => void {
  const onOver = (event: Event) => {
    const element = event.target instanceof Element ? event.target.closest<HTMLElement>(CUT) : null
    if (element !== null) syncOverflowTitle(element)
  }
  root.addEventListener('pointerover', onOver)
  return () => root.removeEventListener('pointerover', onOver)
}
