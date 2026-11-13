import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { Reminder, ReminderList } from '@manor/contracts'
import { ReminderDetails } from './ReminderDetails'

vi.mock('../ui/Select', () => ({ Select: () => null }))

const list: ReminderList = { id: 'test', title: 'Review fixture', shared: false, open: 1, sections: [], sharees: [] }
const reminder: Reminder = { id: 'a', title: 'A', listId: 'test', completed: false, flagged: false, priority: 'none', tags: [] }

let view: ReactTestRenderer | undefined
afterEach(() => act(() => view?.unmount()))

it('Escape throws the edit away instead of saving it on the blur it causes', () => {
  const onUpdate = vi.fn()
  act(() => {
    view = create(
      <ReminderDetails
        reminder={reminder}
        lists={[list]}
        subtasks={[]}
        now={{ day: '2026-09-30', time: '12:00' }}
        plain={false}
        canWrite
        onUpdate={onUpdate}
        onToggle={() => {}}
        onDelete={() => {}}
        onAddSubtask={() => {}}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    )
  })
  const title = () => view!.root.findByProps({ 'aria-label': 'Title' })
  act(() => {
    title().props.onFocus()
    title().props.onChange({ target: { value: 'Discard this' } })
  })
  const field = title()
  act(() => field.props.onKeyDown({
    key: 'Escape',
    preventDefault() {},
    stopPropagation() {},
    currentTarget: { blur: () => field.props.onBlur() },
  }))
  expect(onUpdate).not.toHaveBeenCalled()
  expect(title().props.value).toBe('A')

  act(() => {
    title().props.onFocus()
    title().props.onChange({ target: { value: 'Keep this' } })
  })
  act(() => title().props.onBlur())
  expect(onUpdate).toHaveBeenCalledWith({ title: 'Keep this' })
})
