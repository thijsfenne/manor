import type { RoutineDraft } from '@manor/contracts'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoutineDialog } from '../src/components/routines/RoutineDialog'

// Escape, the close button and the backdrop all land on the modal's `onClose`.
vi.mock('../src/components/Modal', () => ({
  Modal: ({ title, onClose, children }: { title: string; onClose: () => void; children: unknown }) => (
    <section aria-label={title} data-close={onClose}>{children as never}</section>
  ),
  ModalFooter: ({ children }: { children: unknown }) => children,
}))
vi.mock('../src/components/ui/Select', () => ({ Select: () => null }))

const draft: RoutineDraft = {
  projectId: null,
  chatId: null,
  agentId: '__single__',
  name: '',
  prompt: '',
  cron: '0 7 * * *',
  timezone: 'Europe/Amsterdam',
  enabled: true,
  notify: false,
  model: null,
  effort: null,
}

let tree: ReactTestRenderer | undefined
afterEach(() => {
  act(() => tree?.unmount())
  tree = undefined
})

function open() {
  const onClose = vi.fn()
  act(() => {
    tree = create(
      <RoutineDialog
        initial={draft} projects={[]} chats={[]} agents={[]} notice={null} pending={null}
        onSave={() => true} onDismissNotice={() => {}} onClose={onClose}
      />,
    )
  })
  const modal = (title: string) => tree!.root.findAll((node) => node.type === 'section' && node.props['aria-label'] === title)[0]
  const leave = () => act(() => modal('New task')!.props['data-close']())
  const button = (label: string) => tree!.root.findAllByType('button').find((node) => node.children.includes(label))!
  return { onClose, modal, leave, button }
}

describe('leaving the New task form', () => {
  it('closes at once while nothing is typed', () => {
    const { onClose, leave } = open()
    leave()
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('asks before it drops a typed name, and Discard then closes', () => {
    const { onClose, leave, modal, button } = open()
    act(() => tree!.root.findAllByType('input')[0]!.props.onChange({ target: { value: 'Weekly review' } }))
    leave()
    expect(onClose).not.toHaveBeenCalled()
    expect(modal('Discard unsaved changes?')).toBeDefined()

    act(() => button('Discard').props.onClick())
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('asks before it drops a cron line typed by hand, also once its fold is closed again', () => {
    const { onClose, leave, modal } = open()
    const fold = (open: boolean) => act(() => tree!.root.findByType('details').props.onToggle({ currentTarget: { open } }))
    fold(true)
    act(() => tree!.root.findByProps({ 'aria-label': 'Cron expression' }).props.onChange({ target: { value: '15 9 * * 1' } }))
    fold(false)
    leave()
    expect(onClose).not.toHaveBeenCalled()
    expect(modal('Discard unsaved changes?')).toBeDefined()
  })
})
