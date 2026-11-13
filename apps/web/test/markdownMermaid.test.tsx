import { renderToStaticMarkup } from 'react-dom/server'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import { Markdown } from '../src/components/Markdown'
import { planDiagram } from '../src/components/MermaidDiagram'

const fence = (source: string) => `Hier:\n\n\`\`\`mermaid\n${source}\n\`\`\`\n\nKlaar.`
const VALID = 'flowchart LR\n  A[Plan] --> B[Build]'

/** Renders a finished reply and lets the renderer chunk and its diagram type arrive. */
async function rendered(text: string) {
  let tree: ReactTestRenderer | undefined
  act(() => {
    tree = create(<Markdown text={text} />)
  })
  const source = /```mermaid\n([\s\S]*?)\n```/.exec(text)?.[1] ?? ''
  await act(async () => {
    await planDiagram(source)
  })
  return tree!
}

const enlargers = (tree: ReactTestRenderer) =>
  tree.root.findAll((node) => node.type === 'button' && node.props['aria-label'] === 'Enlarge diagram')

describe('mermaid blocks', () => {
  it('draws a finished mermaid fence', async () => {
    const tree = await rendered(fence(VALID))
    expect(enlargers(tree)).toHaveLength(1)
    expect(tree.root.findAllByType('pre')).toHaveLength(0)
  })

  it('keeps invalid mermaid as its code block', async () => {
    const tree = await rendered(fence('flowchart LR\n  A -->'))
    expect(enlargers(tree)).toHaveLength(0)
    expect(JSON.stringify(tree.toJSON())).toContain('A -->')
  })

  it('keeps an unknown diagram type as its code block', async () => {
    const tree = await rendered(fence('flowchrt LR\n  A --> B'))
    expect(enlargers(tree)).toHaveLength(0)
    expect(tree.root.findAllByType('pre')).toHaveLength(1)
  })

  it('keeps a block with broken front matter as code, before and after the renderer loads', async () => {
    const broken = '---\ntitle: [broken\n---\nflowchart LR\n  A --> B'
    const tree = await rendered(fence(broken))
    expect(enlargers(tree)).toHaveLength(0)
    expect(renderToStaticMarkup(<Markdown text={fence(broken)} />)).toContain('<pre')
  })

  it('shows the code while the renderer is still loading', () => {
    const html = renderToStaticMarkup(<Markdown text={fence('sequenceDiagram\n  A->>B: hoi')} />)
    expect(html).toContain('<pre')
    expect(html).toContain('A-&gt;&gt;B: hoi')
  })

  it('leaves the block a live reply is still writing as code, closed fence or not', async () => {
    await planDiagram(VALID)
    // A reply with custom plugins renders as one block, so the half-written fence
    // reaches the parser as a whole code block of its own.
    for (const stableBlocks of [true, false]) {
      for (const text of [`\`\`\`mermaid\n${VALID}`, `\`\`\`mermaid\n${VALID}\n\`\`\``]) {
        const html = renderToStaticMarkup(<Markdown reveal stableBlocks={stableBlocks} text={text} />)
        expect(html).not.toContain('Enlarge diagram')
        expect(html).toContain('<pre')
      }
    }
  })

  it('draws a fence in a live reply once text follows it', async () => {
    await planDiagram(VALID)
    const html = renderToStaticMarkup(<Markdown reveal stableBlocks text={`${fence(VALID)} En`} />)
    expect(html).toContain('Enlarge diagram')
  })

  it('leaves other code blocks alone', () => {
    const html = renderToStaticMarkup(<Markdown text={'```ts\nconst a = 1\n```'} />)
    expect(html).toContain('<pre')
    expect(html).not.toContain('Enlarge diagram')
  })
})
