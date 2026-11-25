/** The part of a DOM node the walk below reads; a real `Node` is one. */
export interface SelectionTreeNode<N> {
  readonly nodeType: number
  readonly nodeValue: string | null
  readonly parentNode: N | null
  readonly firstChild: N | null
  readonly nextSibling: N | null
  readonly childNodes: ArrayLike<N>
}

/** A selection's two boundary points, as a DOM `Range` carries them. */
export interface SelectionBounds<N> {
  readonly startContainer: N
  readonly startOffset: number
  readonly endContainer: N
  readonly endOffset: number
}

const TEXT_NODE = 3

/** The first node after `node` and everything inside it, in document order. */
function after<N extends SelectionTreeNode<N>>(node: N): N | null {
  for (let at: N | null = node; at !== null; at = at.parentNode) {
    if (at.nextSibling !== null) return at.nextSibling
  }
  return null
}

/**
 * The one message a selection quotes from, or null when it takes letters from several or
 * from none. Only text the selection actually covers counts, so a boundary that sits at
 * the very start of whatever follows the message does not move the selection out of it.
 * A triple click and a drag past the end of a paragraph both end there. Text the page
 * does not let a selection take (`selectable` false, such as a turn's status line) is
 * passed over, as the browser leaves it out of the selected text too.
 */
export function quoteSourceOf<N extends SelectionTreeNode<N>, S>(
  range: SelectionBounds<N>,
  sourceOf: (text: N) => S | null,
  selectable: (text: N) => boolean = () => true,
): S | null {
  const { startContainer, startOffset, endContainer, endOffset } = range
  const first = startContainer.nodeType === TEXT_NODE
    ? startContainer
    : startContainer.childNodes[startOffset] ?? after(startContainer)
  // The first node the selection no longer reaches; a text end is handled inside the loop.
  const stop = endContainer.nodeType === TEXT_NODE
    ? null
    : endContainer.childNodes[endOffset] ?? after(endContainer)
  let source: S | null = null
  for (let node: N | null = first; node !== null && node !== stop; node = node.firstChild ?? after(node)) {
    if (node.nodeType === TEXT_NODE) {
      const text = node.nodeValue ?? ''
      const from = node === startContainer ? startOffset : 0
      const to = node === endContainer ? endOffset : text.length
      if (text.slice(from, to).trim() !== '' && selectable(node)) {
        const nodeSource = sourceOf(node)
        if (nodeSource === null || (source !== null && nodeSource !== source)) return null
        source = nodeSource
      }
      if (node === endContainer) break
    }
  }
  return source
}
