import { describe, expect, it } from 'vitest'
import { quoteSourceOf, type SelectionTreeNode } from './quoteSelection'

/** A node in a hand-built page: an element (with the message it quotes, if any) or a text. */
type FakeNode = SelectionTreeNode<FakeNode> & {
  quoteId?: string
  /** Stands in for `user-select: none` on an element. */
  unselectable?: true
  childNodes: FakeNode[]
  parentNode: FakeNode | null
  nextSibling: FakeNode | null
}

const text = (value: string): FakeNode => ({ nodeType: 3, nodeValue: value, parentNode: null, firstChild: null, nextSibling: null, childNodes: [] })

const el = (children: FakeNode[], marks: { quoteId?: string; unselectable?: true } = {}): FakeNode => {
  const node: FakeNode = { nodeType: 1, nodeValue: null, parentNode: null, firstChild: children[0] ?? null, nextSibling: null, childNodes: children, ...marks }
  children.forEach((child, index) => {
    child.parentNode = node
    child.nextSibling = children[index + 1] ?? null
  })
  return node
}

const sourceOf = (node: FakeNode) => {
  for (let at: FakeNode | null = node; at !== null; at = at.parentNode) if (at.quoteId !== undefined) return at.quoteId
  return null
}

const range = (startContainer: FakeNode, startOffset: number, endContainer: FakeNode, endOffset: number) =>
  quoteSourceOf({ startContainer, startOffset, endContainer, endOffset }, sourceOf, (node) => node.parentNode?.unselectable !== true)

/** A sent message of two paragraphs, then a turn: its status line, the reply, its time. */
function page() {
  const first = text('First sentence of the note.')
  const second = text('A second paragraph.')
  const firstP = el([first])
  const secondP = el([second])
  const messageA = el([firstP, text('\n'), secondP], { quoteId: 'a' })
  const rowA = el([messageA])
  const status = text('2 steps')
  const other = text('Reply from the agent.')
  const otherP = el([other])
  const time = text('21:25')
  const rowB = el([el([status], { unselectable: true }), el([otherP], { quoteId: 'b' }), el([time])])
  const column = el([rowA, rowB])
  return { first, second, firstP, secondP, messageA, time, rowA, status, other, otherP, rowB, column }
}

describe('quoteSourceOf', () => {
  it('takes a selection inside one text node', () => {
    const { first } = page()
    expect(range(first, 6, first, 14)).toBe('a')
  })

  it('takes a whole paragraph whose end sits at the start of the next message', () => {
    // A triple click on a message's last paragraph ends at offset 0 of what follows it.
    const { second, secondP, rowB, otherP, other } = page()
    expect(range(secondP, 0, rowB, 0)).toBe('a')
    expect(range(second, 0, otherP, 0)).toBe('a')
    expect(range(second, 0, other, 0)).toBe('a')
  })

  it('takes a drag that ends past the paragraph, in the message or the row around it', () => {
    const { first, second, messageA, rowA, rowB } = page()
    expect(range(first, 0, messageA, 2)).toBe('a')
    expect(range(first, 0, messageA, 3)).toBe('a')
    expect(range(second, 0, rowA, 1)).toBe('a')
    expect(range(second, 0, rowB, 0)).toBe('a')
  })

  it('takes a selection that starts at the end of the message before it', () => {
    const { second, other } = page()
    expect(range(second, second.nodeValue?.length ?? 0, other, other.nodeValue?.length ?? 0)).toBe('b')
  })

  it('refuses a selection that takes letters from two messages', () => {
    const { first, other } = page()
    expect(range(first, 0, other, 5)).toBeNull()
  })

  it('refuses a selection that takes letters from outside any message', () => {
    const { other, time, column } = page()
    expect(range(other, 0, time, 2)).toBeNull()
    expect(range(column, 0, column, 2)).toBeNull()
  })

  it('passes over text the page does not let a selection take', () => {
    // A drag past a message's end into the next turn crosses that turn's quiet status line.
    const { second, status, otherP } = page()
    expect(range(second, 0, otherP, 0)).toBe('a')
    expect(range(status, 0, otherP, 0)).toBeNull()
  })

  it('finds nothing in a selection of whitespace only', () => {
    const { messageA } = page()
    expect(range(messageA, 1, messageA, 2)).toBeNull()
  })
})
