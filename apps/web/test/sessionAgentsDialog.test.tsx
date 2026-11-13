import type { AgentConfig } from '@manor/contracts'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionAgentsDialog } from '../src/components/SessionAgentsDialog'

vi.mock('../src/components/Modal', () => ({
  Modal: ({ children }: { children: unknown }) => children,
  ModalFooter: ({ children }: { children: unknown }) => children,
}))
vi.mock('../src/components/Avatar', () => ({ Avatar: () => null }))

let tree: ReactTestRenderer | undefined
afterEach(() => {
  act(() => tree?.unmount())
  tree = undefined
})

const agent = (placement: 'chat' | 'session') =>
  ({ id: 'a1', name: 'Scout', color: '#000', description: '', placement }) as unknown as AgentConfig

function render(agents: AgentConfig[], onNewSessionAgent: () => void) {
  const onClose = vi.fn()
  act(() => {
    tree = create(<SessionAgentsDialog agents={agents} onEdit={() => {}} onClose={onClose} onNewSessionAgent={onNewSessionAgent} />)
  })
  return { onClose }
}
const addButton = () => tree?.root.findAll((node) => node.type === 'button' && node.children.includes('Add a session agent')) ?? []

describe('the Session agents dialog empty state', () => {
  it('offers Add a session agent, which closes the dialog and opens the form', () => {
    const door = vi.fn()
    const { onClose } = render([agent('chat')], door)
    expect(addButton()).toHaveLength(1)
    act(() => addButton()[0]?.props.onClick())
    expect(onClose).toHaveBeenCalledOnce()
    expect(door).toHaveBeenCalledOnce()
  })

  it('has no button while Session agents are listed', () => {
    render([agent('session')], vi.fn())
    expect(addButton()).toHaveLength(0)
  })
})
