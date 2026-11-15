import type { ComponentProps } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DiffFileCard } from '../src/components/session/DiffFileCard'
import type { DiffViewFile } from '../src/diffView'

let view: ReactTestRenderer | undefined
afterEach(() => {
  act(() => view?.unmount())
  view = undefined
})

const file = (path: string): DiffViewFile => ({
  key: path, path, status: 'edited', added: 1, removed: 1, binary: false, truncated: false,
  rows: [
    { kind: 'same', text: 'Intro line', oldNo: 1, newNo: 1 },
    { kind: 'removed', text: 'Old claim', oldNo: 2 },
    { kind: 'added', text: 'New claim', newNo: 2 },
    { kind: 'gap', count: 4 },
  ],
})

const card = (path: string): ComponentProps<typeof DiffFileCard> => ({
  file: file(path), layout: 'stacked', collapsed: false, scrollRoot: { current: null },
  onToggle: vi.fn(), cardRef: vi.fn(), onCopyPath: vi.fn(),
})

const tabs = (root: ReactTestRenderer) => root.root.findAllByProps({ role: 'tab' }).filter((node) => typeof node.type === 'string')
const counts = (root: ReactTestRenderer) => root.root.findAll((node) => node.type === 'span' && node.props.className === 'text-ok')
const lines = (root: ReactTestRenderer) => root.root.findAll((node) => typeof node.type === 'string' && node.type === 'p')

/** The runs of lines the reading view draws, one element each. */
const blocks = (root: ReactTestRenderer) => root.root.findAll((node) => typeof node.type === 'string' && node.type === 'div' && typeof node.props.className === 'string' && node.props.className.includes('leading-[1.6]'))
const textOf = (node: ReactTestRenderer['root']): string => node.children.map((child) => typeof child === 'string' ? child : textOf(child)).join('')

describe('a prose file in the diff pane', () => {
  it('opens as text with a Text and Source choice, no line numbers and no monospace', () => {
    act(() => { view = create(<DiffFileCard {...card('notes/brief.md')} />) })
    expect(tabs(view!).map((tab) => tab.props['aria-selected'])).toEqual([true, false])
    const [same, removed, added] = blocks(view!)
    expect(same!.props.className).toContain('text-text')
    expect(textOf(same!)).toBe('Intro line')
    expect(removed!.props.className).toContain('line-through')
    expect(textOf(removed!)).toBe('Old claim')
    expect(added!.props.className).toContain('--color-ok')
    expect(textOf(added!)).toBe('New claim')
    const json = JSON.stringify(view!.toJSON())
    expect(json).not.toContain('font-mono')
    expect(json).not.toContain('unmodified')
  })

  it('shows a quiet labelled divider where lines are left out, not a count row', () => {
    act(() => { view = create(<DiffFileCard {...card('notes/brief.md')} />) })
    const gap = view!.root.findByProps({ role: 'separator' })
    expect(gap.props['aria-label']).toBe('4 unchanged lines')
    expect(textOf(gap)).toBe('…')
  })

  it('renders an added Markdown list item as a list item inside the tinted block', () => {
    const rows: DiffViewFile['rows'] = [{ kind: 'added', text: '- when does the pilot start', newNo: 1 }]
    act(() => { view = create(<DiffFileCard {...card('notes/brief.md')} file={{ ...file('notes/brief.md'), rows }} />) })
    const [added] = blocks(view!)
    expect(added!.props.className).toContain('--color-ok')
    const items = added!.findAll((node) => node.type === 'li')
    expect(items.map(textOf)).toEqual(['when does the pilot start'])
  })

  it('keeps a .txt file as plain lines, hyphen included', () => {
    const rows: DiffViewFile['rows'] = [{ kind: 'added', text: '- item', newNo: 1 }]
    act(() => { view = create(<DiffFileCard {...card('notes/brief.txt')} file={{ ...file('notes/brief.txt'), rows }} />) })
    expect(lines(view!).map((node) => node.props.children)).toEqual(['- item'])
    expect(view!.root.findAll((node) => node.type === 'li')).toHaveLength(0)
  })

  it('shows today’s code diff and its line counts under Source, per card', () => {
    // A node for the body's ref, so the source lines draw once they are near.
    act(() => { view = create(<DiffFileCard {...card('notes/brief.md')} />, { createNodeMock: () => ({}) }) })
    expect(counts(view!)).toHaveLength(0)
    act(() => tabs(view!)[1]!.props.onClick())
    expect(counts(view!)).toHaveLength(1)
    const json = JSON.stringify(view!.toJSON())
    expect(json).toContain('font-mono')
    expect(json).toContain('New claim')
    expect(lines(view!)).toHaveLength(0)
  })

  it('offers no choice on a code file', () => {
    act(() => { view = create(<DiffFileCard {...card('src/App.tsx')} />) })
    expect(tabs(view!)).toHaveLength(0)
    expect(JSON.stringify(view!.toJSON())).toContain('font-mono')
  })
})
