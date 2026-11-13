import type { AgentConfig, AgentDraft } from '@manor/contracts'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentForm } from '../src/components/agents/AgentForm'
import { ToolsetSection } from '../src/components/agents/ToolsetSection'
import { AgentsPage } from '../src/components/settings/AgentsPage'
import { Select } from '../src/components/ui/Select'
import { emptyDraft } from '../src/persona'
import type { RequestResponse } from '../src/useRequest'

vi.mock('../src/components/Avatar', () => ({ Avatar: () => <span /> }))
vi.mock('../src/components/ui/Select', () => ({ Select: () => null }))
vi.mock('../src/components/ui/useDismiss', () => ({ useDismiss: () => {} }))
vi.mock('../src/components/ui/SelectionMarker', () => ({ SelectionMarker: () => null }))

let tree: ReactTestRenderer
afterEach(() => { if (tree) act(() => tree.unmount()) })

function mount(initial: AgentDraft, pending: 'save' | null = null, dmRuntime?: string) {
  const onSave = vi.fn<(draft: AgentDraft) => boolean>(() => true)
  act(() => { tree = create(<AgentForm initial={initial} agents={[]} registry={[]} skills={[]}
    {...(dmRuntime === undefined ? {} : { dmRuntime })}
    notice={null} pending={pending} onSave={onSave} onDelete={() => true} onDismissNotice={() => {}} onDirtyChange={() => {}} />) })
  return onSave
}

const draft = (driver: AgentDraft['driver'], allowedTools: string[] = []): AgentDraft => ({
  ...emptyDraft([]), name: 'Test persona', character: 'Help with research.', driver, allowedTools,
})

const button = (label: string) => tree.root.find((node) => node.type === 'button' && node.props['aria-label'] === label)
const namedButton = (text: string) => tree.root.find((node) => node.type === 'button' && node.children.includes(text))
const selected = () => tree.root.findByType(ToolsetSection).props.tools

describe('persona toolset', () => {
  it('associates capability switches with their own explanation and the provider note', () => {
    mount(draft('claude'))
    act(() => namedButton('Advanced').props.onClick())
    for (const [label, explanation] of [
      ['Read files', 'Open files and find text or folders.'],
      ['Background work', 'Create tasks, check their progress and stop them.'],
    ]) {
      const ids = (button(label!).props['aria-describedby'] as string).split(' ')
      const descriptions = ids.map((id) => tree.root.findByProps({ id }).children.join(''))
      expect(descriptions).toHaveLength(2)
      expect(descriptions[0]).toBe(explanation)
      expect(descriptions[1]).toContain('Linked folders give Claude all built-in tools')
    }
  })

  it.each(['claude', 'codex'] as const)('preserves an existing %s tool list verbatim on save', (driver) => {
    const tools = ['FutureTool', 'Edit', 'Read', 'FutureTool', 'mcp__custom__search', 'Bash']
    const onSave = mount({ ...draft(driver, tools), id: 'saved-agent' })
    act(() => namedButton('Advanced').props.onClick())
    act(() => button('Individual tools for Read files').props.onClick())
    // Save acts on an edit, so the edit here is one that leaves the tools alone.
    act(() => tree.root.findByProps({ placeholder: 'Engineer' }).props.onChange({ target: { value: 'Researcher' } }))
    act(() => namedButton('Save').props.onClick())
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ allowedTools: tools })
  })

  it.each(['claude', 'codex'] as const)('creates a new %s persona without inventing tool choices', (driver) => {
    const onSave = mount(draft(driver))
    act(() => namedButton('Create agent').props.onClick())
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ allowedTools: [] })
  })

  it('shows a partial group, fills it on the first click and clears it on the second', () => {
    mount(draft('claude', ['FutureTool', 'Read', 'Bash']))
    expect(button('Read files').props.role).toBe('checkbox')
    expect(button('Read files').props['aria-checked']).toBe('mixed')
    act(() => button('Read files').props.onClick())
    expect(selected()).toEqual(['FutureTool', 'Read', 'Bash', 'Glob', 'Grep'])
    expect(button('Read files').props['aria-checked']).toBe(true)
    act(() => button('Read files').props.onClick())
    expect(selected()).toEqual(['FutureTool', 'Bash'])
    expect(button('Read files').props['aria-checked']).toBe(false)
  })

  it('keeps raw tools and extra names behind disclosures and lets individual changes update the group', () => {
    mount(draft('claude', ['Read', 'Glob', 'Grep', 'UnlistedTool']))
    expect(tree.root.findAllByProps({ 'aria-label': 'Read files tool names' })).toHaveLength(0)
    expect(tree.root.findAllByProps({ placeholder: 'Extra tool names, separated by commas' })).toHaveLength(0)
    act(() => button('Individual tools for Read files').props.onClick())
    const rawGroup = tree.root.findByProps({ 'aria-label': 'Read files tool names' })
    act(() => rawGroup.findAllByType('input')[0]!.props.onChange({ target: { checked: false } }))
    expect(selected()).toEqual(['Glob', 'Grep', 'UnlistedTool'])
    expect(button('Read files').props['aria-checked']).toBe('mixed')
    act(() => namedButton('Advanced').props.onClick())
    const extra = tree.root.findByProps({ placeholder: 'Extra tool names, separated by commas' })
    expect(extra.props.value).toBe('UnlistedTool')
    act(() => extra.props.onChange({ target: { value: 'OtherTool, OtherTool' } }))
    expect(selected()).toEqual(['Glob', 'Grep', 'OtherTool'])
  })

  it.each(['codex', 'cursor', 'mock'] as const)('does not present working per-tool permissions for %s', (driver) => {
    mount(draft(driver, ['Read']))
    expect(button('Read files').props.disabled).toBe(true)
    act(() => button('Individual tools for Read files').props.onClick())
    expect(tree.root.findByProps({ 'aria-label': 'Read files tool names' }).findAllByType('input').every((node) => node.props.disabled)).toBe(true)
    act(() => namedButton('Advanced').props.onClick())
    expect(tree.root.findByProps({ placeholder: 'Extra tool names, separated by commas' }).props.readOnly).toBe(true)
  })

  it('keeps tool choices unchanged when switching providers and back', () => {
    const tools = ['Unknown', 'Write', 'Read']
    mount(draft('claude', tools))
    const provider = () => tree.root.findAllByType(Select).find((node) => node.props.label === 'Provider')!
    act(() => provider().props.onChange('codex'))
    expect(button('Read files').props.disabled).toBe(true)
    expect(selected()).toEqual(tools)
    act(() => provider().props.onChange('claude'))
    expect(button('Read files').props.disabled).toBe(false)
    expect(selected()).toEqual(tools)
  })

  it('offers only mapped Grok tools and preserves saved unmapped names', () => {
    mount(draft('grok', ['NotebookEdit', 'Skill']))
    act(() => button('Change files').props.onClick())
    expect(selected()).toEqual(['NotebookEdit', 'Skill', 'Write', 'Edit'])
    act(() => button('Change files').props.onClick())
    expect(selected()).toEqual(['NotebookEdit', 'Skill'])
    act(() => button('Discover tools and monitor work').props.onClick())
    expect(selected()).toEqual(['NotebookEdit', 'Skill', 'Monitor', 'ToolSearch'])
  })

  it('disables tool editing while a save is pending', () => {
    mount(draft('claude', ['Read']), 'save')
    expect(button('Read files').props.disabled).toBe(true)
  })
})

describe('persona model default', () => {
  const text = () => JSON.stringify(tree.toJSON())

  it('names the DM pin under the model row and calls the row the Work default', () => {
    mount({ ...draft('claude'), id: 'saved-agent' }, null, 'Sonnet 5.5 · Medium')
    expect(text()).toContain('The default for sessions. DM chat uses ')
    expect(text()).toContain('Sonnet 5.5 · Medium')
  })

  it('says nothing about a pin the DM does not have', () => {
    mount({ ...draft('claude'), id: 'saved-agent' })
    expect(text()).toContain('The default for sessions and the DM chat.')
  })
})

describe('a save in flight', () => {
  const agent: AgentConfig = { ...draft('claude'), id: 'saved-agent', role: 'Original' }
  let answer: (response: RequestResponse) => void = () => {}
  const events = { subscribe: (listener: (response: RequestResponse) => void) => { answer = listener; return () => {} } }
  const onSaveAgent = vi.fn<(draft: AgentDraft, requestId: string) => boolean>(() => true)
  const page = (agents: AgentConfig[]) => (
    <AgentsPage agents={agents} agentId="saved-agent" registry={[]} skills={[]} subagentPolicy={null} notice={null}
      requestEvents={events} onSelect={() => {}} onSaveAgent={onSaveAgent} onDeleteAgent={() => true} onSaveSubagentPolicy={() => true}
      onRequestSubagentPolicy={() => {}} onDismissNotice={() => {}} onDirtyChange={() => {}} />
  )
  const role = () => tree.root.findByProps({ placeholder: 'Engineer' })
  const status = () => tree.root.find((node) => node.type === 'span' && node.props.role === 'status').children.join('')
  // Sends "Sent", then lands it the way the server does: the roster first, the ack after.
  const save = (typedMeanwhile?: string) => {
    act(() => { tree = create(page([agent])) })
    act(() => role().props.onChange({ target: { value: 'Sent' } }))
    act(() => namedButton('Save').props.onClick())
    if (typedMeanwhile !== undefined) act(() => role().props.onChange({ target: { value: typedMeanwhile } }))
    act(() => tree.update(page([{ ...agent, role: 'Sent' }])))
    act(() => answer({ type: 'ack', requestId: onSaveAgent.mock.calls.at(-1)![1] }))
  }

  it('keeps typing done while it was out, as an edit against what landed', () => {
    save('Sent, then more')
    expect(role().props.value).toBe('Sent, then more')
    expect(status()).toBe('Unsaved changes')
  })

  it('settles on what the server stored when nothing was typed meanwhile', () => {
    save()
    expect(role().props.value).toBe('Sent')
    expect(status()).toBe('All changes saved')
  })
})
