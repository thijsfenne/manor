/**
 * Wraps every word of a rendered reply in its own element, and marks the ones that
 * arrived since the last look so only those animate.
 *
 * The mark is the whole point, and it exists because element identity is not
 * trustworthy here. Words hold their position while text is appended, so React
 * reuses their elements and a CSS animation on mount plays exactly once, until
 * the markdown around them restructures. `**bold` completing into `**bold**` moves
 * the word under a `<strong>`, every sibling after it shifts, and a tree that only
 * grew at the end remounts halfway through. On identity alone the whole paragraph
 * would flash back in. A word past the boundary is new, everything before it is
 * silent whether it remounted or not.
 *
 * The boundary is a word count rather than a source offset: offsets are gone by
 * the time this runs, because the mention plugin rewrites the text nodes it splits
 * and drops the position data for the rest of the paragraph with them.
 *
 * Only ever used on a reply that is still growing. A finished one has nothing
 * arriving, and the spans would be a few hundred elements bought for nothing.
 */

interface HastText {
  type: 'text'
  value: string
}

interface HastParent {
  type: string
  tagName?: string
  properties?: Record<string, unknown>
  children?: HastNode[]
}

type HastNode = HastText | HastParent

/** Filled in with the words this pass found, so the next one knows where it starts. */
export interface RevealCount {
  words: number
}

/** Whitespace is the one thing markdown gives meaning to inside these. */
const VERBATIM = new Set(['code', 'pre', 'style', 'script'])

/**
 * Two calls deep on purpose. The outer one takes this pass's boundary, the inner
 * one is the attacher unified asks for and only then comes the transformer: an
 * entry in the plugin list is invoked to *produce* a transformer, so handing it
 * one directly gets it called with no tree at all.
 */
export function rehypeRevealWords(from: number, count: RevealCount) {
  return () => (tree: HastNode) => {
    let index = 0

    /**
     * Words become elements, the whitespace between them stays text. Keeping the
     * gaps as bare text is what lets a line still wrap: every place a line is
     * allowed to end is one of them.
     */
    const wordsOf = (value: string): HastNode[] =>
      value
        .split(/(\s+)/)
        .filter((piece) => piece.length > 0)
        .map((piece) => {
          if (/^\s+$/.test(piece)) return { type: 'text', value: piece }
          // Every word is wrapped, new or not, so a word crossing the boundary
          // changes one class rather than turning from an element into text. The
          // second class is the only thing that animates.
          const className = index >= from ? ['reveal-word', 'reveal-word-new'] : ['reveal-word']
          index += 1
          return {
            type: 'element',
            tagName: 'span',
            properties: { className },
            children: [{ type: 'text', value: piece }],
          }
        })

    /**
     * What a subtree costs the index without being wrapped. Skipping a node has to
     * cost its words anyway, or the coordinate slides out from under everything
     * after it: while `` `code `` is still an unclosed backtick it is ordinary
     * prose and takes its indices, and the moment the closing tick lands it turns
     * into an element this skips. Silently, the words behind it would each shift
     * down one, land under the boundary, and never settle in.
     */
    const spanOf = (node: HastNode): number =>
      node.type === 'text'
        ? (node as HastText).value.split(/\s+/).filter((piece) => piece.length > 0).length
        : ((node as HastParent).children ?? []).reduce((total, child) => total + spanOf(child), 0)

    const splitInto = (node: HastNode) => {
      if (node.type === 'text') return
      const parent = node as HastParent
      if (parent.children === undefined) return
      if (parent.tagName !== undefined && VERBATIM.has(parent.tagName)) {
        index += spanOf(parent)
        return
      }
      // A mention is a chip, not a run of words: splitting inside one would hand
      // the chip component a pile of spans where it expects its own handle.
      if (parent.properties?.['dataMention'] !== undefined) {
        index += spanOf(parent)
        return
      }

      parent.children = parent.children.flatMap((child): HastNode[] => {
        if (child.type === 'text') return wordsOf((child as HastText).value)
        splitInto(child)
        return [child]
      })
    }

    splitInto(tree)
    count.words = index
  }
}
