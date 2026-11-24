import type { ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_HOUSE_SETTINGS, daysToMs } from '@manor/contracts'
import { StoragePage } from '../src/components/settings/StoragePage'

vi.mock('motion/react', () => ({
  motion: { div: (props: Record<string, unknown>) => <div {...props} />, span: (props: Record<string, unknown>) => <span {...props} /> },
  AnimatePresence: ({ children }: { children: unknown }) => children,
  useReducedMotion: () => true,
}))
// The real Select portals its menu into document.body, which this renderer has none of.
vi.mock('../src/components/ui/Select', () => ({ Select: () => null }))
// No DOM here to portal into: the modal renders its title and body in place.
vi.mock('../src/components/Modal', async (original) => ({
  ...(await original<typeof import('../src/components/Modal')>()),
  Modal: ({ title, children }: { title: string; children: ReactNode }) => <div role="dialog">{title}{children}</div>,
}))

describe('the Storage page', () => {
  it('asks before Restore defaults shortens the archive window past an archived chat', () => {
    const onSave = vi.fn((_settings: unknown, _requestId: string) => true)
    let page: ReactTestRenderer | undefined
    act(() => {
      page = create(
        <StoragePage
          settings={{ ...DEFAULT_HOUSE_SETTINGS, archiveRetentionDays: 30 }}
          archivedAt={[Date.now() - daysToMs(15)]}
          notice={null}
          requestEvents={{ subscribe: () => () => {} }}
          onSave={onSave}
          onDismissNotice={() => {}}
        />,
      )
    })
    const restoreChats = page!.root.findAllByType('button').find((button) => button.children.includes('Restore defaults'))!
    act(() => restoreChats.props.onClick())

    expect(onSave).not.toHaveBeenCalled()
    expect(JSON.stringify(page!.toJSON())).toContain('1 archived chat is older than 10 days and will be deleted within the hour.')

    const shorten = page!.root.findAllByType('button').find((button) => button.children.includes('Shorten'))!
    act(() => shorten.props.onClick())
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ archiveRetentionDays: 10 }), expect.any(String))
  })
})
