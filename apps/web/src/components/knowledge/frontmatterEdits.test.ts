import { EditorState } from '@codemirror/state'
import { describe, expect, it } from 'vitest'
import { addProperty, propertyRows, removeProperty, setPropertyValue } from './frontmatterEdits'

const doc = [
  '---',
  'type: note',
  'title: "Quoted: yes"',
  'tags:',
  '  - topic/career',
  '  - topic/design',
  'aliases: [one, two]',
  '# a comment the list never shows',
  'nested:',
  '  child: value',
  '---',
  'Body',
].join('\n')

const state = (text = doc) => EditorState.create({ doc: text })
const rows = (s = state()) => propertyRows(s) ?? []
const row = (key: string, s = state()) => rows(s).find((each) => each.key === key)!
const apply = (s: EditorState, spec: ReturnType<typeof addProperty>) => (spec === null ? null : s.update(spec).state.sliceDoc())

describe('the property list reads the frontmatter', () => {
  it('reads each shape, and marks YAML it cannot rewrite as read-only', () => {
    expect(rows().map(({ key, shape, values, editable }) => ({ key, shape, values, editable }))).toEqual([
      { key: 'type', shape: 'scalar', values: ['note'], editable: true },
      { key: 'title', shape: 'scalar', values: ['Quoted: yes'], editable: true },
      { key: 'tags', shape: 'block', values: ['topic/career', 'topic/design'], editable: true },
      { key: 'aliases', shape: 'inline', values: ['one', 'two'], editable: true },
      { key: 'nested', shape: 'scalar', values: [], editable: false },
    ])
  })

  it('keeps a list whose items hold commas read-only, since `a, b` would split them', () => {
    expect(row('tags', state('---\ntags:\n  - "one, two"\n  - three\n---\n')).editable).toBe(false)
    expect(row('tags', state('---\ntags: ["one, two", three]\n---\n')).editable).toBe(false)
  })

  it('reads a list the field wrote back with quotes, and can edit it again', () => {
    const s = state('---\naliases: [one, two]\n---\n')
    const written = s.update(setPropertyValue(s, row('aliases', s), '#hash, two')!).state
    expect(written.sliceDoc()).toBe('---\naliases: ["#hash", two]\n---\n')
    expect(row('aliases', written)).toMatchObject({ values: ['#hash', 'two'], editable: true })
  })

  it('is null for a note without frontmatter', () => {
    expect(propertyRows(state('No frontmatter'))).toBeNull()
  })
})

describe('the property list writes back only the lines it changes', () => {
  it('sets a scalar, keeping its quotes, and quotes a new value YAML would misread', () => {
    const s = state()
    expect(apply(s, setPropertyValue(s, row('type'), 'meeting'))).toBe(doc.replace('type: note', 'type: meeting'))
    expect(apply(s, setPropertyValue(s, row('title'), 'New "one"'))).toBe(doc.replace('title: "Quoted: yes"', 'title: "New \\"one\\""'))
    expect(apply(s, setPropertyValue(s, row('type'), 'a: b'))).toBe(doc.replace('type: note', 'type: "a: b"'))
  })

  it('rewrites a block list in its own indentation', () => {
    const s = state()
    expect(apply(s, setPropertyValue(s, row('tags'), 'x, y, z'))).toBe(
      doc.replace('tags:\n  - topic/career\n  - topic/design', 'tags:\n  - x\n  - y\n  - z'),
    )
  })

  it('keeps entries YAML would read as booleans, nulls or numbers as text', () => {
    const s = state('---\naliases: ["old", "true", "null", "007"]\n---\n')
    expect(apply(s, setPropertyValue(s, row('aliases', s), 'new, true, null, 007'))).toBe('---\naliases: [new, "true", "null", "007"]\n---\n')
  })

  it('changes nothing when the value is the same, or the row is read-only', () => {
    const spaced = state('---\ntitle: "  In Progress  "\n---\n')
    expect(setPropertyValue(spaced, row('title', spaced), '  In Progress  ')).toBeNull()
    const s = state()
    expect(setPropertyValue(s, row('tags'), 'topic/career,  topic/design')).toBeNull()
    expect(setPropertyValue(s, row('nested'), 'x')).toBeNull()
  })

  it('adds a property before the closing fence and refuses a duplicate or a bad name', () => {
    const s = state()
    expect(apply(s, addProperty(s, 'status', 'active'))).toBe(doc.replace('  child: value\n---', '  child: value\nstatus: active\n---'))
    expect(apply(s, addProperty(s, 'tags', 'a'))).toBeNull()
    expect(apply(s, addProperty(s, 'two words', 'a'))).toBeNull()
    expect(apply(s, addProperty(s, 'x: second', 'a'))).toBeNull()
  })

  it('removes a property with its list items', () => {
    const s = state()
    expect(s.update(removeProperty(s, row('tags'))).state.sliceDoc()).toBe(doc.replace('tags:\n  - topic/career\n  - topic/design\n', ''))
  })

  it('keeps a list with a comment between its items whole, and read-only', () => {
    const text = '---\ntags:\n  - one\n# keep this\n  - two\ntype: note\n---\n'
    const s = state(text)
    expect(row('tags', s).editable).toBe(false)
    expect(s.update(removeProperty(s, row('tags', s))).state.sliceDoc()).toBe('---\ntype: note\n---\n')
  })

  it('never takes a comment or a key it cannot read along with the row above it', () => {
    const text = '---\na: x\n"b": keep me\nc: y\n# note\n---\n'
    const s = state(text)
    expect(s.update(removeProperty(s, row('a', s))).state.sliceDoc()).toBe('---\n"b": keep me\nc: y\n# note\n---\n')
    expect(s.update(removeProperty(s, row('c', s))).state.sliceDoc()).toBe('---\na: x\n"b": keep me\n# note\n---\n')
  })
})
