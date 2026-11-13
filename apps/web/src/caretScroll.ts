/**
 * Keeps the caret inside a textarea that has stopped growing.
 *
 * A browser scrolls a textarea to its caret by itself, but only while the box it is
 * scrolling stays the same height. The composer resizes itself on every keystroke
 * (height to `auto`, measure, height back), and collapsing the box clamps `scrollTop`
 * to nothing — so at full height, the line typed after that clamp lands below the
 * visible area and the caret disappears off the bottom. This puts it back.
 *
 * Measured in a throwaway copy of the box rather than asked of the textarea, because
 * a textarea will not say where its caret is. The copy wears the same font, padding
 * and width, holds the text up to the caret, and a marker at the end of it reports
 * the line the caret is on.
 */
export function scrollCaretIntoView(area: HTMLTextAreaElement): void {
  // Nothing scrolls while everything fits, which is the ordinary case: this runs on
  // every keystroke, so the cheap way out comes first.
  if (area.scrollHeight <= area.clientHeight) return
  const caret = area.selectionEnd
  const style = getComputedStyle(area)
  const mirror = document.createElement('div')
  mirror.style.position = 'absolute'
  mirror.style.top = '0'
  mirror.style.left = '-9999px'
  mirror.style.visibility = 'hidden'
  mirror.style.whiteSpace = 'pre-wrap'
  mirror.style.overflowWrap = 'break-word'
  mirror.style.width = `${area.clientWidth}px`
  for (const property of ['font', 'letterSpacing', 'lineHeight', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderStyle', 'borderWidth', 'boxSizing', 'textIndent'] as const) {
    mirror.style[property] = style[property]
  }
  mirror.textContent = area.value.slice(0, caret)
  const marker = document.createElement('span')
  // A zero-width space rather than nothing: an empty span has no box to measure, and
  // a caret at the end of a soft-wrapped line has to sit on the line it wrapped to.
  marker.textContent = '​'
  mirror.appendChild(marker)
  document.body.appendChild(mirror)
  const top = marker.offsetTop
  const line = marker.offsetHeight || parseFloat(style.lineHeight) || 0
  document.body.removeChild(mirror)

  const bottom = top + line
  const paddingBottom = parseFloat(style.paddingBottom) || 0
  if (bottom > area.scrollTop + area.clientHeight) area.scrollTop = bottom + paddingBottom - area.clientHeight
  else if (top < area.scrollTop) area.scrollTop = Math.max(0, top - (parseFloat(style.paddingTop) || 0))
}
