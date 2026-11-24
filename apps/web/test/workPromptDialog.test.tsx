import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkPromptDialog } from '../src/components/WorkPromptDialog'

// Escape, the close button and the backdrop all land on the modal's `onClose`.
vi.mock('../src/components/Modal', () => ({
  Modal: ({ title, onClose, children }: { title: string; onClose: () => void; children: unknown }) => (
    <section aria-label={title} data-close={onClose}>{children as never}</section>
  ),
  ModalFooter: ({ children }: { children: unknown }) => children,
}))

let tree: ReactTestRenderer | undefined
afterEach(() => {
  act(() => tree?.unmount())
  tree = undefined
})

function open() {
  const onClose = vi.fn()
  const onSave = vi.fn()
  act(() => { tree = create(<WorkPromptDialog title="Weekly review" task="Plan the week." onSave={onSave} onClose={onClose} />) })
  const modal = (title: string) => tree!.root.findAll((node) => node.type === 'section' && node.props['aria-label'] === title)[0]
  const leave = () => act(() => modal('Prompt')!.props['data-close']())
  const type = (text: string) => act(() => tree!.root.findByType('textarea').props.onChange({ target: { value: text } }))
  const button = (label: string) => tree!.root.findAllByType('button').find((node) => node.children.includes(label))!
  return { onClose, modal, leave, type, button }
}

describe('leaving the prompt editor', () => {
  it('closes at once while the text is unchanged', () => {
    const { onClose, leave, modal } = open()
    leave()
    expect(onClose).toHaveBeenCalledOnce()
    expect(modal('Discard unsaved changes?')).toBeUndefined()
  })

  it('asks before it drops a changed prompt, and Keep editing returns to the text', () => {
    const { onClose, leave, type, modal, button } = open()
    type('Plan the week and the month.')
    leave()
    expect(onClose).not.toHaveBeenCalled()
    expect(modal('Discard unsaved changes?')).toBeDefined()

    act(() => button('Keep editing').props.onClick())
    expect(modal('Discard unsaved changes?')).toBeUndefined()
    expect(onClose).not.toHaveBeenCalled()
  })

  it('drops the edit once Discard is pressed', () => {
    const { onClose, leave, type, button } = open()
    type('Something else.')
    leave()
    act(() => button('Discard').props.onClick())
    expect(onClose).toHaveBeenCalledOnce()
  })
})
