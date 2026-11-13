import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'

// Same GFM options as `Markdown`, so a tail splits where the rendered message does.
const parser = unified().use(remarkParse).use(remarkGfm, { singleTilde: false })

export type StreamingTail =
  | { kind: 'list'; ordered: boolean; start: number | undefined; items: string[] }
  | { kind: 'table'; header: string; rows: string[] }
  | { kind: 'code'; language: string | null | undefined; value: string }

/** Drops fenced blocks (an unclosed one runs to the end) and inline code spans. */
const withoutCode = (text: string) => text
  .replace(/^ {0,3}((`)\2{2,}(?=[^`\n]*$)|(~)\3{2,})[^\n]*\n[\s\S]*?(?:^ {0,3}\1\2*\3*[ \t]*$|(?![\s\S]))/gm, '')
  .replace(/(`+)[^`\n]*?\1/g, '')

/** Retain complete top-level blocks, leaving the last Markdown node mutable. */
export class StreamingMarkdown {
  private source = ''
  private committed = 0
  private blocks: string[] = []
  nestedTail: StreamingTail | undefined

  update(text: string): readonly string[] {
    const documentWide = /^ {0,3}\[[^\]\n]+\]:|\[\^[^\n]+\]:|^[ \t]{0,3}::/m.test(text) ||
      withoutCode(text).includes('[^')
    // Definitions/footnotes may change earlier blocks. Unknown document-wide
    // directives also stay on the ordinary renderer, as do non-append edits.
    // Only the loose `[^` check skips code, so a regex like `[^a-z]` keeps the
    // incremental path. Definitions are read from the raw text, and a footnote
    // definition anywhere (a quote, a list item, an escaped `]` in its label) counts.
    if (!text.startsWith(this.source) || documentWide) {
      this.committed = 0
      this.blocks = []
    }
    this.source = text
    this.nestedTail = undefined
    if (documentWide) return [text]
    const tail = text.slice(this.committed)
    const nodes = parser.parse(tail).children
    const lastStart = nodes.at(-1)?.position?.start.offset ?? 0
    for (let index = 0; index < nodes.length - 1; index += 1) {
      const start = index === 0 ? 0 : nodes[index]?.position?.start.offset
      const end = nodes[index + 1]?.position?.start.offset
      if (start !== undefined && end !== undefined) this.blocks.push(tail.slice(start, end))
    }
    this.committed += lastStart
    const last = nodes.at(-1)
    if (last?.type === 'list' && !last.spread && last.children.every((item) =>
      !item.spread && item.children.length === 1 && item.children[0]?.type === 'paragraph')) {
      const starts = last.children.map((item) => item.position?.start.offset)
      if (starts.every((start) => start !== undefined)) {
        this.nestedTail = {
          kind: 'list', ordered: last.ordered === true, start: last.start ?? undefined,
          items: starts.map((start, index) => tail.slice(start!, starts[index + 1] ?? tail.length).trimEnd()),
        }
      }
    } else if (last?.type === 'table') {
      const firstBody = last.children[1]?.position?.start.offset
      const starts = last.children.slice(1).map((row) => row.position?.start.offset)
      if (starts.every((start) => start !== undefined)) {
        this.nestedTail = {
          kind: 'table', header: tail.slice(lastStart, firstBody ?? tail.length),
          rows: starts.map((start, index) => tail.slice(start!, starts[index + 1] ?? tail.length).trimEnd()),
        }
      }
    } else if (last?.type === 'code') {
      this.nestedTail = { kind: 'code', language: last.lang, value: last.value }
    }
    return [...this.blocks, text.slice(this.committed)]
  }
}
