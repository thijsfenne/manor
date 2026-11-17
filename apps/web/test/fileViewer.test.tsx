import type { DmFile } from '@manor/contracts'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileViewer } from '../src/components/agents/FileViewer'

vi.mock('react-dom', async (original) => ({ ...await original<typeof import('react-dom')>(), createPortal: (child: unknown) => child }))
vi.mock('motion/react', () => ({
  motion: {
    div: ({ initial: _initial, animate: _animate, transition: _transition, ...rest }: Record<string, unknown>) => <div {...rest} />,
    p: ({ initial: _initial, animate: _animate, transition: _transition, ...rest }: Record<string, unknown>) => <p {...rest} />,
  },
  useReducedMotion: () => true,
}))
vi.mock('../src/components/fileMark', () => ({ FileMark: () => <span /> }))
vi.mock('../src/components/Markdown', () => ({ Markdown: ({ text }: { text: string }) => <p>{text}</p> }))
vi.mock('../src/dmFileActions', () => ({ saveDmFile: vi.fn(async () => null) }))

const file = (id: string, name: string, extra: Partial<DmFile> = {}): DmFile =>
  ({ id, name, mime: 'application/zip', kind: 'file', size: 2_048, ts: 1, src: `/media/${id}`, ...extra })
const files = [file('a', 'plan.zip'), file('b', 'notes.zip'), file('c', 'gone.zip', { src: undefined })]

let viewer: ReactTestRenderer
const onIndex = vi.fn()
const onClose = vi.fn()
const open = (index: number) => act(() => {
  viewer = create(<FileViewer files={files} index={index} onIndex={onIndex} onClose={onClose} />, {
    createNodeMock: () => ({ focus: vi.fn(), scrollIntoView: vi.fn() }),
  })
})
const press = (key: string) => act(() => {
  viewer.root.findByProps({ role: 'dialog' }).props.onKeyDown({ key, preventDefault: vi.fn() })
})
const text = (node: ReactTestInstance): string => node.children.map((child) => typeof child === 'string' ? child : text(child)).join('')

beforeEach(() => {
  vi.stubGlobal('document', { body: {}, activeElement: null })
  vi.stubGlobal('HTMLElement', class {})
  onIndex.mockReset()
  onClose.mockReset()
})
afterEach(() => {
  act(() => viewer.unmount())
  vi.unstubAllGlobals()
})

describe('FileViewer', () => {
  it('captions the open file with its name and position', () => {
    open(1)
    const captions = viewer.root.findAll((node) => node.type === 'p' && node.children.map((child) => typeof child === 'string' ? child : text(child)).join(' | ') === 'notes.zip | 2 / 3')
    expect(captions).toHaveLength(1)
  })

  it('steps with the arrow keys and stops at either end', () => {
    open(1)
    press('ArrowRight')
    press('ArrowLeft')
    expect(onIndex.mock.calls).toEqual([[2], [0]])
    act(() => viewer.update(<FileViewer files={files} index={2} onIndex={onIndex} onClose={onClose} />))
    press('ArrowRight')
    act(() => viewer.update(<FileViewer files={files} index={0} onIndex={onIndex} onClose={onClose} />))
    press('ArrowLeft')
    expect(onIndex).toHaveBeenCalledTimes(2)
  })

  it('closes on Escape', () => {
    open(0)
    press('Escape')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('says a file without bytes is gone, with no Download in its card', () => {
    open(2)
    expect(viewer.root.findAll((node) => node.type === 'p' && text(node) === 'This file is no longer available.')).toHaveLength(1)
    const cardDownloads = () => viewer.root.findAll((node) => node.type === 'button' && text(node).includes('Download'))
    expect(cardDownloads()).toHaveLength(0)
    act(() => viewer.update(<FileViewer files={files} index={0} onIndex={onIndex} onClose={onClose} />))
    expect(cardDownloads()).toHaveLength(1)
  })
})
