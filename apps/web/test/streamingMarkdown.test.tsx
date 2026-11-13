import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { describe, expect, it } from 'vitest'
import { StreamingMarkdown } from '../src/streamingMarkdown'
import { Markdown } from '../src/components/Markdown'
import { act, create } from 'react-test-renderer'
import type { Components } from 'react-markdown'

const render = (text: string) => renderToStaticMarkup(<ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>)
const fixtures = [
  '# Title\n\nA paragraph.\n\nAnother paragraph with **bold**.\n',
  'Intro\n\n- first\n  - nested\n\n  continued\n- second\n\nFinal\n',
  '1. One\n\n- Bullet\n\n2. Two\n\nDone\n',
  'Intro\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nAfter\n',
  'Intro\n\n```js\nconst x = 1\n\nconsole.log(x)\n```\n\nAfter\n',
  'Intro\n\nSetext\n------\n\n> quoted\n> continued\n\nAfter\n',
  '[Earlier][ref]\n\nLater paragraph\n\n[ref]: https://example.com\n',
  'Note[^1]\n\nOther\n\n[^1]: Exact footnote\n',
  '[Earlier][ref]\n\n- ```\n  example\n  ```\n\n[ref]: https://example.com\n',
  '- ```\n  example\n  ```\n\nNote[^1]\n\n> [^1]: footnote\n',
  '- ```\n  example\n  ```\n\nNote[^1]\n\n- Item\n\n  [^1]: footnote\n',
  '- ```\n  example\n  ```\n\nNote[^a\\]b]\n\n> [^a\\]b]: footnote\n',
  'Match `[^a-z]`\n\n```ts\nconst re = /[^a-z]/\n[ref]: not a definition\n```\n\nNote[^1]\n\n[^1]: Real footnote\n',
]

describe('streaming Markdown blocks', () => {
  it.each([
    '- first\n- second\n- third\n',
    '2. one\n3. two\n4. three\n',
    '| A | B |\n| --- | --- |\n| one | two |\n| three | four |\n',
    '```js\nconst one = 1\nconst two = 2\n```\n',
    '    first\n    second\n',
    'Intro\n\n- first\n  - nested\n\n  continued\n- second\n\nFinal\n',
    '1. One\n\n- Bullet\n\n2. Two\n\nDone\n',
  ])('keeps a growing nested tail visually equal to a full parse for %s', (source) => {
    const positions = [...source.matchAll(/\n/g)].map((match) => match.index + 1)
    for (const end of [...positions, source.length]) {
      const text = source.slice(0, end)
      const streamed = renderToStaticMarkup(<Markdown text={text} reveal />)
        .replace(/<\/?span[^>]*>/g, '').replace(/>\s+</g, '><')
      const complete = renderToStaticMarkup(<Markdown text={text} />).replace(/>\s+</g, '><')
      expect(streamed).toBe(complete)
    }
  })

  it('does not treat a prose label as a document-wide definition', () => {
    const stream = new StreamingMarkdown()
    expect(stream.update('A sentence with [Note]: here.\n\nNext')).toEqual([
      'A sentence with [Note]: here.\n\n', 'Next',
    ])
  })

  it.each(fixtures)('matches a full GFM parse at every character boundary for %s', (text) => {
    const stream = new StreamingMarkdown()
    for (let end = 1; end <= text.length; end += 1) {
      const prefix = text.slice(0, end)
      const blocks = stream.update(prefix)
      expect(blocks.map(render).join('').replace(/\n/g, '')).toBe(render(prefix).replace(/\n/g, ''))
    }
  })

  it('keeps streaming incrementally when footnote-like text sits only in code', () => {
    const stream = new StreamingMarkdown()
    expect(stream.update('Use `[^a-z]`\n\n```ts\nconst re = /[^a-z]/\n```\n\nNext')).toEqual([
      'Use `[^a-z]`\n\n', '```ts\nconst re = /[^a-z]/\n```\n\n', 'Next',
    ])
    expect(new StreamingMarkdown().update('Intro\n\n```ts\nconst re = /[^a-z]/\n')).toEqual([
      'Intro\n\n', '```ts\nconst re = /[^a-z]/\n',
    ])
  })

  it('keeps the completed prefix unchanged and resets safely for non-append edits', () => {
    const stream = new StreamingMarkdown()
    expect(stream.update('First\n\nSecond')).toEqual(['First\n\n', 'Second'])
    expect(stream.update('First\n\nSecond grows\n\nThird')).toEqual(['First\n\n', 'Second grows\n\n', 'Third'])
    expect(stream.update('Replacement')).toEqual(['Replacement'])
  })

  it('renders a stable block once while multiple independent streams grow', () => {
    const rendered: string[] = []
    const components: Components = { p: ({ children }) => { rendered.push(renderToStaticMarkup(<p>{children}</p>)); return <p>{children}</p> } }
    const view = (tail: string) => <><Markdown text={`Stable\n\n${tail}`} reveal components={components} /><Markdown text="Other stream" reveal /></>
    const root = create(view('First'))
    act(() => root.update(view('First grows')))
    act(() => root.update(view('First grows again\n\nNew block')))
    expect(rendered.filter((html) => html.includes('Stable'))).toHaveLength(1)
    act(() => root.update(<Markdown text="Stable\n\nFirst grows again\n\nNew block" components={components} />))
    expect(root.toJSON()).toEqual(create(<Markdown text="Stable\n\nFirst grows again\n\nNew block" components={components} />).toJSON())
    root.unmount()
  })

  it('retains 180 completed paragraphs while three long replies stream together', () => {
    let paragraphs = 0
    const components: Components = { p: ({ children }) => { paragraphs += 1; return <p>{children}</p> } }
    const completed = Array.from({ length: 3 }, (_, agent) =>
      Array.from({ length: 60 }, (_, block) => `Agent ${agent}, paragraph ${block}. **Stable text** and a [source](https://example.com).`).join('\n\n'))
    const view = (step: number) => <>{completed.map((prefix, agent) =>
      <Markdown key={agent} text={`${prefix}\n\n${'Growing '.repeat(step + 1)}`} reveal components={components} />)}</>
    const root = create(view(0))
    for (let step = 1; step < 25; step += 1) act(() => root.update(view(step)))
    // 180 completed nodes render once, plus one mutable node per stream/update.
    expect(paragraphs).toBe(180 + 3 * 25)
    root.unmount()
  })
})
