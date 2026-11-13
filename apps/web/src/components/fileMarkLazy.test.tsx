import { createElement } from 'react'
import { act, create } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'

vi.mock('./fileMarkLoaded', () => ({
  FileMark: ({ path }: { path: string }) => createElement('svg', { 'data-file-mark': path }),
  FileMarkSprite: () => createElement('span', { 'data-file-sprite': '' }),
}))

it('loads the file icon set only when a mark is shown, then mounts its shared sprite', async () => {
  const { FileMark, FileMarkSprite } = await import('./fileMark')
  let view = create(createElement(FileMarkSprite))
  expect(view.toJSON()).toBeNull()
  await act(async () => {
    view.update(createElement('div', null, createElement(FileMarkSprite), createElement(FileMark, { path: 'src/App.tsx' })))
  })
  expect(view.root.findAllByProps({ 'data-file-sprite': '' })).toHaveLength(1)
  expect(view.root.findAllByProps({ 'data-file-mark': 'src/App.tsx' })).toHaveLength(1)
  act(() => view.unmount())
})
