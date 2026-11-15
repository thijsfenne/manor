import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ContextRing } from '../src/components/ContextRing'

vi.mock('../src/components/ui/useDismiss', () => ({
  useDismiss: () => {},
}))

describe('the Single Work context ring', () => {
  let tree: ReactTestRenderer

  afterEach(() => {
    act(() => tree.unmount())
  })

  it('opens the readout and leaves session cost out', () => {
    act(() => {
      tree = create(<ContextRing controlSize="h-8 w-8" used={44_000} window={258_000} />)
    })
    act(() => tree.root.findByProps({ title: 'Context window' }).props.onClick())

    const html = JSON.stringify(tree.toJSON())
    expect(html).toContain('17% used')
    expect(html).toContain('44k / 258k')
    expect(html).toContain('Compacts automatically when needed.')
    expect(html).not.toContain('Session cost')
    expect(html).not.toContain('Context per agent')
    expect(html).toContain('A breakdown is available after the next completed turn.')
  })

  it('splits the measured total into rows with Messages as the remainder and hides unknown ones', () => {
    act(() => {
      tree = create(<ContextRing controlSize="h-8 w-8" used={30_000} window={100_000}
        estimate={{ instructions: 4_000, memory: 1_000, skills: 0, mcpCatalog: 8_000, unmeasuredMcpServers: 1 }} />)
    })
    act(() => tree.root.findByProps({ title: 'Context window' }).props.onClick())
    const html = JSON.stringify(tree.toJSON())
    expect(html).toContain('30% used')
    for (const label of ['Messages', 'MCP tools', 'Memory', 'Instructions', 'Estimated split']) expect(html).toContain(label)
    // Skills are sized at zero and tool schemas are unknown on this driver: no row, no "Not exposed".
    expect(html).not.toContain('Skills')
    expect(html).not.toContain('Not exposed')
    expect(html).not.toContain('≈')
    // Messages is 30k minus the 13k Manor supplied, as a share of the 100k limit.
    expect(html).toContain('17.0%')
    expect(html).toContain('"1 connection has no size estimate')
  })

  it('shows missing telemetry as unknown rather than zero use', () => {
    act(() => { tree = create(<ContextRing controlSize="h-8 w-8" window={100_000} />) })
    act(() => tree.root.findByProps({ title: 'Context window' }).props.onClick())
    expect(JSON.stringify(tree.toJSON())).toContain('Not reported yet')
  })

  it('separates a provider that reported nothing from a window someone measured as empty', () => {
    act(() => {
      tree = create(<ContextRing controlSize="h-8 w-8" window={1_000_000}
        estimate={{
          instructions: 2_000, memory: 200, skills: 0, mcpCatalog: 0, unmeasuredMcpServers: 0,
          used: { source: 'unknown' },
          window: { source: 'estimated', tokens: 1_000_000 },
          autoCompactAt: { source: 'measured', tokens: 300_000 },
        }} />)
    })
    act(() => tree.root.findByProps({ title: 'Context window' }).props.onClick())

    const html = JSON.stringify(tree.toJSON())
    expect(html).toContain('This provider reports no fill')
    // The known threshold replaces the vague sentence, and no zero is printed for the fill.
    expect(html).toContain('Compacts at 300k')
    expect(html).not.toContain('Compacts automatically when needed.')
    // A dashed track, which is what the dial draws when nobody reported a fill.
    expect(html).toContain('"strokeDasharray":"2 2.5"')
  })

  it('fills the dial toward the compaction threshold, not the 1m catalog window', () => {
    act(() => {
      tree = create(<ContextRing controlSize="h-8 w-8" used={150_000} window={1_000_000}
        estimate={{
          instructions: 2_000, memory: 200, skills: 0, mcpCatalog: 0, unmeasuredMcpServers: 0,
          used: { source: 'measured', tokens: 150_000 },
          window: { source: 'estimated', tokens: 1_000_000 },
          autoCompactAt: { source: 'measured', tokens: 300_000 },
        }} />)
    })
    act(() => tree.root.findByProps({ title: 'Context window' }).props.onClick())

    const html = JSON.stringify(tree.toJSON())
    // Half of the 300k the CLI compacts at, where the window would have read 15%.
    expect(html).toContain('50% used')
    expect(html).toContain('150k / 300k')
    expect(html).toContain('model window 1m')
  })

  it('leads with one window when the provider names no compaction point', () => {
    act(() => {
      tree = create(<ContextRing controlSize="h-8 w-8" used={44_000} window={272_000}
        estimate={{
          instructions: 2_000, memory: 200, skills: 0, mcpCatalog: 0, unmeasuredMcpServers: 0,
          used: { source: 'measured', tokens: 44_000 },
          window: { source: 'measured', tokens: 272_000 },
          autoCompactAt: { source: 'unknown' },
        }} />)
    })
    act(() => tree.root.findByProps({ title: 'Context window' }).props.onClick())

    const html = JSON.stringify(tree.toJSON())
    // Codex has no compaction threshold Manor knows, so the dial's one window is the
    // model window and nothing else competes with it.
    expect(html).toContain('44k / 272k')
    expect(html).not.toContain('1m')
    // Solid track: this window was measured, and measured as 4% full.
    expect(html).not.toContain('"strokeDasharray":"2 2.5"')
  })
})
