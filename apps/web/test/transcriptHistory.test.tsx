import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Transcript } from '../src/components/Transcript'
import type { Row } from '../src/state'

const rows: Row[] = Array.from({ length: 100 }, (_, index) => ({
  kind: 'pending', key: `message-${index}`, text: `Message ${index}`, images: [], files: [], pageContexts: [],
}))
let view: ReactTestRenderer
const render = (data: Row[], key = 'a') => <Transcript key={key} rows={data} agents={[]} skills={[]} hasSnapshot />
const rendered = () => JSON.stringify(view.toJSON())
afterEach(() => { act(() => view?.unmount()); vi.unstubAllGlobals() })

describe('reading transcript history', () => {
  it('opens at the latest page, prepends on demand, and keeps new messages without evicting history', () => {
    act(() => { view = create(render(rows)) })
    expect(rendered()).toContain('Message 70')
    expect(rendered()).not.toContain('Message 69')
    act(() => view.root.findAllByType('button').find(button => button.props.children === 'Load earlier messages')!.props.onClick())
    expect(rendered()).toContain('Message 40')
    expect(rendered()).not.toContain('Message 39')
    act(() => view.update(render([...rows, { ...rows[99]!, key: 'new', kind: 'pending', text: 'New reply', images: [], files: [], pageContexts: [] }])))
    expect(rendered()).toContain('Message 40')
    expect(rendered()).toContain('New reply')
    act(() => view.update(render(rows, 'b')))
    expect(rendered()).not.toContain('Message 40')
    expect(rendered()).toContain('Message 70')
  })
})
