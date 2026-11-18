import { renderToStaticMarkup } from 'react-dom/server'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DesktopPermissionId, DesktopPermissionsBridge, DesktopPermissionStatus } from '@manor/contracts'
import { PermissionsPage } from './PermissionsPage'

let renderer: ReactTestRenderer | undefined
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = undefined
  vi.useRealTimers()
})

const text = () => JSON.stringify(renderer?.toJSON())

function fakeBridge(initial: DesktopPermissionStatus) {
  let current = initial
  const opened: DesktopPermissionId[] = []
  const bridge: DesktopPermissionsBridge = {
    status: async () => current,
    open: async (id) => { opened.push(id) },
  }
  return { bridge, opened, set: (next: DesktopPermissionStatus) => { current = next } }
}

describe('PermissionsPage', () => {
  it('says plainly that permissions only apply in the desktop app when there is no Electron host', () => {
    const html = renderToStaticMarkup(<PermissionsPage bridge={undefined} />)
    expect(html).toContain('Permissions only apply in the Manor desktop app')
    expect(html).not.toContain('Open System Settings')
  })

  it('shows each permission and follows a grant without a reload', async () => {
    vi.useFakeTimers()
    const fake = fakeBridge({ 'accessibility': 'not-granted', 'screen-recording': 'pending' })
    await act(async () => { renderer = create(<PermissionsPage bridge={fake.bridge} />) })
    expect(text()).toContain('Not granted')
    expect(text()).toContain('Pending')

    fake.set({ 'accessibility': 'granted', 'screen-recording': 'granted' })
    await act(async () => { await vi.advanceTimersByTimeAsync(1_600) })
    expect(text()).not.toContain('Not granted')
    expect(text()).not.toContain('Pending')
    expect(text()).toContain('Granted')
  })

  it('opens the pane of the row whose button was pressed', async () => {
    const fake = fakeBridge({ 'accessibility': 'not-granted', 'screen-recording': 'not-granted' })
    await act(async () => { renderer = create(<PermissionsPage bridge={fake.bridge} />) })
    const buttons = renderer!.root.findAll((node) => node.type === 'button')
    await act(async () => { buttons[1]?.props.onClick() })
    expect(fake.opened).toEqual(['screen-recording'])
  })
})
