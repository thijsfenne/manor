import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { NoteTitle } from './NoteName'

function title(props: Partial<React.ComponentProps<typeof NoteTitle>> = {}) {
  // Enter moves focus into the body, which blurs the title while the key is handled.
  const handlers = { onSubmit: vi.fn(), onDismissError: vi.fn(), onFocusHandled: vi.fn(), onEnter: vi.fn(() => field().props.onBlur()) }
  const element = (extra: Partial<React.ComponentProps<typeof NoteTitle>>) => (
    <NoteTitle path="notes/Old name.md" busy={false} error={null} focusRequest={false} {...handlers} {...props} {...extra} />
  )
  let renderer!: ReactTestRenderer
  // A DOM field blurs synchronously, so `blur()` inside a key handler runs onBlur right there.
  const createNodeMock = () => ({ blur: () => field().props.onBlur(), focus: () => {}, select: () => {}, style: {}, scrollHeight: 0, ownerDocument: { activeElement: null } })
  act(() => { renderer = create(element({}), { createNodeMock }) })
  const field = () => renderer.root.findByType('textarea')
  const type = (value: string) => act(() => field().props.onChange({ target: { value } }))
  const key = (name: string) => act(() => field().props.onKeyDown({ key: name, nativeEvent: { isComposing: false }, preventDefault: () => {}, stopPropagation: () => {} }))
  const blur = () => act(() => field().props.onBlur())
  const rerender = (extra: Partial<React.ComponentProps<typeof NoteTitle>>) => act(() => renderer.update(element(extra)))
  const alerts = () => renderer.root.findAll((node) => node.props.role === 'alert').map((node) => node.children.join(''))
  return { handlers, field, type, key, blur, rerender, alerts }
}

describe('the note title renames on commit', () => {
  it('commits once on Enter and moves on into the body', () => {
    const t = title()
    t.type('New name')
    t.key('Enter')
    t.blur()
    expect(t.handlers.onSubmit).toHaveBeenCalledTimes(1)
    expect(t.handlers.onSubmit).toHaveBeenCalledWith('New name')
    expect(t.handlers.onEnter).toHaveBeenCalledTimes(1)
  })

  it('keeps line breaks out of the name', () => {
    const t = title()
    t.type('Two\nlines')
    expect(t.field().props.value).toBe('Two lines')
  })

  it('commits on blur, and not at all when the name did not change', () => {
    const t = title()
    t.blur()
    expect(t.handlers.onSubmit).not.toHaveBeenCalled()
    t.type('Other')
    t.blur()
    expect(t.handlers.onSubmit).toHaveBeenCalledWith('Other')
  })

  it('shows a refusal and gives the old name back', () => {
    const t = title()
    t.type('Clash')
    t.blur()
    t.rerender({ error: 'A file or folder with that name already exists.' })
    expect(t.field().props.value).toBe('Old name')
    expect(t.alerts()).toEqual(['A file or folder with that name already exists.'])
  })

  it('shows the new name while the rename is out and once it lands', () => {
    // The panel marks the rename busy in the same event that commits it.
    let t!: ReturnType<typeof title>
    t = title({ onSubmit: () => t.rerender({ busy: true }) })
    t.type('Fresh')
    t.blur()
    expect(t.field().props.value).toBe('Fresh')
    t.rerender({ busy: false, path: 'notes/Fresh.md' })
    expect(t.field().props.value).toBe('Fresh')
  })

  it('sends an empty name, so the panel refuses it', () => {
    const t = title()
    t.type('  ')
    t.blur()
    expect(t.handlers.onSubmit).toHaveBeenCalledWith('')
  })

  it('Escape drops the edit, even though it blurs the field', () => {
    const t = title()
    t.type('Nope')
    t.key('Escape')
    expect(t.field().props.value).toBe('Old name')
    expect(t.handlers.onSubmit).not.toHaveBeenCalled()
  })
})
