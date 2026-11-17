import { describe, expect, it } from 'vitest'
import { syncOverflowTitle } from '../src/overflowTitles'

/** A label with its measured box: `full` is the text's own size, `box` what it is given. */
function label(text: string, { full, box, clamp = false, ancestorTitle = false }: { full: number; box: number; clamp?: boolean; ancestorTitle?: boolean }) {
  const attributes = new Map<string, string>()
  const row = { titled: ancestorTitle }
  return {
    row,
    className: clamp ? 'line-clamp-2' : 'min-w-0 truncate',
    textContent: text,
    scrollWidth: clamp ? box : full,
    clientWidth: box,
    scrollHeight: clamp ? full : box,
    clientHeight: box,
    get title() {
      return attributes.get('title') ?? ''
    },
    set title(value: string) {
      attributes.set('title', value)
    },
    getAttribute: (name: string) => attributes.get(name) ?? null,
    hasAttribute: (name: string) => attributes.has(name),
    setAttribute: (name: string, value: string) => void attributes.set(name, value),
    removeAttribute: (name: string) => void attributes.delete(name),
    parentElement: { closest: (selector: string) => (row.titled && selector === '[title]' ? {} : null) },
    firstElementChild: null as { scrollWidth: number; clientWidth: number } | null,
  }
}

describe('the tooltip on a cut label', () => {
  it('shows the whole text once the label is cut, and drops it again once it fits', () => {
    const name = label('Aleksandra  Wiśniewska-Kowalczyk', { full: 240, box: 80 })
    syncOverflowTitle(name)
    expect(name.title).toBe('Aleksandra Wiśniewska-Kowalczyk')

    name.clientWidth = 300
    syncOverflowTitle(name)
    expect(name.hasAttribute('title')).toBe(false)
  })

  it('adds nothing to a label that fits', () => {
    const name = label('Marlow', { full: 50, box: 80 })
    syncOverflowTitle(name)
    expect(name.hasAttribute('title')).toBe(false)
  })

  it('measures a clamp by its lines', () => {
    const question = label('Should the export keep every screenshot?', { full: 60, box: 40, clamp: true })
    syncOverflowTitle(question)
    expect(question.title).toBe('Should the export keep every screenshot?')
  })

  it('measures a middle cut by its head', () => {
    const name = label('Q3 Board Deck, FINAL (revised) v12.md', { full: 80, box: 80 })
    name.setAttribute('data-middle-cut', '')
    name.firstElementChild = { scrollWidth: 200, clientWidth: 60 }
    syncOverflowTitle(name)
    expect(name.title).toBe('Q3 Board Deck, FINAL (revised) v12.md')
  })

  it('leaves a tooltip the label or its row already sets', () => {
    const own = label('Edit project', { full: 240, box: 80 })
    own.title = 'Klanttevredenheidsonderzoek\nEdit project'
    syncOverflowTitle(own)
    expect(own.title).toBe('Klanttevredenheidsonderzoek\nEdit project')

    const inRow = label('Klanttevredenheidsonderzoek', { full: 240, box: 80, ancestorTitle: true })
    syncOverflowTitle(inRow)
    expect(inRow.hasAttribute('title')).toBe(false)
  })

  it('gives way to a tooltip the component sets later, on the label or on its row', () => {
    const label1 = label('Klanttevredenheidsonderzoek', { full: 240, box: 80 })
    syncOverflowTitle(label1)
    label1.title = 'Model unavailable'
    syncOverflowTitle(label1)
    expect(label1.title).toBe('Model unavailable')
    label1.clientWidth = 300
    syncOverflowTitle(label1)
    expect(label1.title).toBe('Model unavailable')

    const label2 = label('Klanttevredenheidsonderzoek', { full: 240, box: 80 })
    syncOverflowTitle(label2)
    label2.row.titled = true
    syncOverflowTitle(label2)
    expect(label2.hasAttribute('title')).toBe(false)
  })
})
