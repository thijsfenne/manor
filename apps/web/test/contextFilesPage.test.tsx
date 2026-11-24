import type { ContextFileName, ContextFiles } from '@manor/contracts'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ContextFilesPage } from '../src/components/settings/ContextFilesPage'
import type { RequestEvents } from '../src/useRequest'

// The editor needs a DOM this suite does not have, and these tests only reach pages without one.
vi.mock('../src/components/ui/TextEditor', () => ({ TextEditor: () => null, sourceTextExtensions: () => [] }))

const requestEvents: RequestEvents = { subscribe: () => () => {} }
let page: ReactTestRenderer | undefined
beforeEach(() => {
  vi.stubGlobal('window', { setInterval: () => 1, clearInterval: () => {}, addEventListener: () => {}, removeEventListener: () => {} })
  vi.stubGlobal('document', { visibilityState: 'hidden' })
})
afterEach(() => {
  act(() => page?.unmount())
  page = undefined
  vi.unstubAllGlobals()
})

const render = (files: ContextFiles, onCreate: (name: ContextFileName, requestId: string) => boolean) => {
  act(() => {
    page = create(
      <ContextFilesPage
        files={files}
        notice={null}
        requestEvents={requestEvents}
        onRequest={() => {}}
        onSave={() => true}
        onCreate={onCreate}
        onDismissNotice={() => {}}
        onDirtyChange={() => {}}
      />,
    )
  })
  return page!
}
const buttons = (tree: ReactTestRenderer) => tree.root.findAllByType('button')
const label = (node: ReactTestInstance): string => node.children.map((child) => typeof child === 'string' ? child : label(child)).join('')

it('says what a missing file is for and creates it from a button, not from Save', () => {
  const onCreate = vi.fn(() => true)
  const tree = render({ root: '/Users/someone/.manor/memory', files: [] }, onCreate)

  const text = JSON.stringify(tree.toJSON())
  expect(text).toContain('not created')
  expect(text).not.toContain('missing')
  expect(text).toContain('How your agents should sound and what they should care about.')

  const create = buttons(tree).find((button) => label(button) === 'Create soul.md')
  expect(create).toBeDefined()
  act(() => create!.props.onClick())
  expect(onCreate).toHaveBeenCalledWith('soul.md', expect.any(String))

  // Another file's page offers its own name.
  act(() => buttons(tree).find((button) => button.props['aria-pressed'] !== undefined && label(button).startsWith('rules.md'))!.props.onClick())
  expect(buttons(tree).some((button) => label(button) === 'Create rules.md')).toBe(true)
})
