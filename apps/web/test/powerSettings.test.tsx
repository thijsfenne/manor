import { DEFAULT_HOUSE_SETTINGS, type SystemInfo } from '@manor/contracts'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { PowerGroup } from '../src/components/settings/PowerSettings'

// The real Select portals its menu into document.body, which this renderer has none of.
vi.mock('../src/components/ui/Select', () => ({
  Select: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <button data-select={value} onClick={() => onChange('working')}>{value}</button>
  ),
}))

const info = (canKeepAwake: boolean): SystemInfo => ({
  version: '0.0.1', commit: null, startedAt: '2026-11-10T00:00:00.000Z', providers: [], logs: [],
  memory: { path: null, pinned: false, pending: null }, vault: { path: null, pinned: false, pending: null },
  canKeepAwake,
})

function render(props: Partial<Parameters<typeof PowerGroup>[0]> = {}) {
  const onSaveSettings = vi.fn()
  const onRequestInfo = vi.fn()
  let page!: ReactTestRenderer
  act(() => {
    page = create(
      <PowerGroup settings={DEFAULT_HOUSE_SETTINGS} info={info(true)} onSaveSettings={onSaveSettings} onRequestInfo={onRequestInfo} {...props} />,
    )
  })
  return { page, onSaveSettings, onRequestInfo }
}

it('saves a picked keep awake mode at once and restores Never', () => {
  const { page, onSaveSettings } = render()
  const restore = page.root.findAllByType('button').find((node) => node.children.includes('Restore defaults'))!
  expect(restore.props.disabled).toBe(true)
  act(() => page.root.findByProps({ 'data-select': 'off' }).props.onClick())
  expect(onSaveSettings).toHaveBeenCalledWith({ ...DEFAULT_HOUSE_SETTINGS, keepAwake: 'working' })

  act(() => page.update(
    <PowerGroup settings={{ ...DEFAULT_HOUSE_SETTINGS, keepAwake: 'always' }} info={info(true)} onSaveSettings={onSaveSettings} onRequestInfo={() => undefined} />,
  ))
  const enabled = page.root.findAllByType('button').find((node) => node.children.includes('Restore defaults'))!
  act(() => enabled.props.onClick())
  expect(onSaveSettings).toHaveBeenLastCalledWith({ ...DEFAULT_HOUSE_SETTINGS, keepAwake: 'off' })
})

it('shows nothing off macOS or before the settings arrive', () => {
  expect(render({ info: info(false) }).page.toJSON()).toBeNull()
  expect(render({ settings: null }).page.toJSON()).toBeNull()
})

it('asks for system info until it has it, again when settings arrive after a reconnect', () => {
  const { page, onRequestInfo, onSaveSettings } = render({ info: null })
  expect(page.toJSON()).toBeNull()
  expect(onRequestInfo).toHaveBeenCalledOnce()
  act(() => page.update(
    <PowerGroup settings={{ ...DEFAULT_HOUSE_SETTINGS }} info={null} onSaveSettings={onSaveSettings} onRequestInfo={onRequestInfo} />,
  ))
  expect(onRequestInfo).toHaveBeenCalledTimes(2)
})
