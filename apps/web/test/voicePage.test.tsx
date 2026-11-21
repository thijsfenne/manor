import { act, create, type ReactTestRenderer, type ReactTestRendererJSON } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_HOUSE_SETTINGS, type DictationModelStatus, type HouseSettings } from '@manor/contracts'
import { VoicePage } from '../src/components/settings/VoicePage'

// The statuses each test pushes; the real hook subscribes once per app to the bridge.
let models: DictationModelStatus[] | null = null
vi.mock('../src/dictation/models', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/dictation/models')>(),
  useDictationModels: () => models,
}))
// The real Select portals its menu into document.body; this stand-in shows its options and picks the last one.
vi.mock('../src/components/ui/Select', () => ({
  Select: ({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }) => (
    <button data-select={label} data-value={value} onClick={() => onChange(options.at(-1)!.value)}>{options.map((option) => option.label).join(', ')}</button>
  ),
}))

afterEach(() => {
  vi.unstubAllGlobals()
  models = null
})

const status = (id: DictationModelStatus['id'], rest: Partial<DictationModelStatus>): DictationModelStatus =>
  ({ id, bytes: id === 'whisper-turbo' ? 1_036_613_791 : 670_576_784, state: 'missing', progress: 0, ...rest })

function stubBridge() {
  const bridge = { download: vi.fn(async () => undefined), cancelDownload: vi.fn(async () => undefined), remove: vi.fn(async () => undefined) }
  vi.stubGlobal('window', { manorDesktop: { dictation: bridge } })
  return bridge
}

const flatten = (node: ReactTestRendererJSON | string | null): string =>
  node === null ? '' : typeof node === 'string' ? node : (node.children ?? []).map(flatten).join('')

function render(settings: HouseSettings | null = DEFAULT_HOUSE_SETTINGS) {
  const onSave = vi.fn()
  let page!: ReactTestRenderer
  act(() => { page = create(<VoicePage settings={settings} onSave={onSave} />) })
  const text = () => {
    const json = page.toJSON()
    return Array.isArray(json) ? json.map(flatten).join('') : flatten(json)
  }
  const buttons = () => page.root.findAll((node) => node.type === 'button').map((node) => node.children.join(''))
  const button = (label: string) => page.root.findAll((node) => node.type === 'button' && node.children.join('') === label)[0]!
  const select = (label: string) => page.root.findByProps({ 'data-select': label })
  return { page, onSave, text, buttons, button, select }
}

it('says dictation needs the desktop app when there is no bridge', () => {
  const { text, buttons } = render()
  expect(text()).toBe('VoiceDictation only works in the Manor desktop app on your Mac.')
  expect(buttons()).toEqual([])
})

it('waits for the settings, then lists both models with their size, checking until the statuses arrive', () => {
  stubBridge()
  expect(render(null).text()).toContain('Reading the settings…')

  const checking = render()
  expect(checking.text()).toContain('Whisper TurboMost accurate, also for Dutch. Takes a few seconds per recording.Checking…')
  expect(checking.text()).toContain('Parakeet TDT 0.6B v3Near instant. Strong in English, weaker in Dutch. Finds the language itself.Checking…')

  models = [status('whisper-turbo', { state: 'ready' }), status('parakeet-tdt-v3', {})]
  const { text } = render()
  expect(text()).toContain('Most accurate, also for Dutch. Takes a few seconds per recording. 1.0 GB')
  expect(text()).toContain('Finds the language itself. 671 MB')
})

it('offers the acts that fit each state and runs them on the bridge', () => {
  const bridge = stubBridge()
  models = [status('whisper-turbo', { state: 'missing' }), status('parakeet-tdt-v3', { state: 'downloading', progress: 0.42 })]
  const first = render()
  expect(first.buttons()).toContain('Download')
  expect(first.text()).toContain('42%')
  const bar = first.page.root.findByProps({ role: 'progressbar' })
  expect(bar.props).toMatchObject({ 'aria-valuenow': 42, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-label': 'Downloading Parakeet TDT 0.6B v3' })
  expect(first.text()).toContain('Download Whisper Turbo to start dictating.')
  act(() => first.button('Download').props.onClick())
  act(() => first.button('Cancel').props.onClick())
  expect(bridge.download).toHaveBeenCalledWith('whisper-turbo')
  expect(bridge.cancelDownload).toHaveBeenCalledWith('parakeet-tdt-v3')

  models = [status('whisper-turbo', { state: 'ready' }), status('parakeet-tdt-v3', { state: 'ready' })]
  const ready = render()
  expect(ready.text()).toContain('In use')
  expect(ready.buttons().filter((label) => label === 'Remove')).toHaveLength(2)
  expect(ready.buttons()).toContain('Use')
  expect(ready.text()).not.toContain('to start dictating')
  act(() => ready.button('Remove').props.onClick())
  expect(bridge.remove).toHaveBeenCalledWith('whisper-turbo')

  const error = 'The download did not finish. Check your connection and try again.'
  models = [status('whisper-turbo', { state: 'failed', error }), status('parakeet-tdt-v3', {})]
  const failed = render()
  expect(failed.text()).toContain(error)
  act(() => failed.button('Retry').props.onClick())
  expect(bridge.download).toHaveBeenLastCalledWith('whisper-turbo')
})

it('switches the model with Use and keeps the rest of the record', () => {
  stubBridge()
  models = [status('whisper-turbo', { state: 'ready' }), status('parakeet-tdt-v3', { state: 'ready' })]
  const kept = { ...DEFAULT_HOUSE_SETTINGS, backupRetentionDays: 30, dictationMicrophone: 'usb-mic' }
  const { button, onSave } = render(kept)
  act(() => button('Use').props.onClick())
  expect(onSave).toHaveBeenCalledWith({ ...kept, dictationModel: 'parakeet-tdt-v3' })
})

it('saves a picked language at once and restores the defaults', () => {
  stubBridge()
  const { select, button, onSave } = render()
  expect(select('Language').children.join('')).toBe('Automatic, Dutch, English')
  expect(button('Restore defaults').props.disabled).toBe(true)
  act(() => select('Language').props.onClick())
  expect(onSave).toHaveBeenCalledWith({ ...DEFAULT_HOUSE_SETTINGS, dictationLanguage: 'en' })

  const picked = render({ ...DEFAULT_HOUSE_SETTINGS, dictationLanguage: 'nl', dictationMicrophone: 'usb-mic' })
  act(() => picked.button('Restore defaults').props.onClick())
  expect(picked.onSave).toHaveBeenCalledWith(DEFAULT_HOUSE_SETTINGS)
})

it('notes that a model which finds the language itself ignores a fixed choice, and only then', () => {
  stubBridge()
  const note = 'Parakeet TDT 0.6B v3 finds the language itself, so this choice only applies to Whisper Turbo.'
  expect(render({ ...DEFAULT_HOUSE_SETTINGS, dictationModel: 'parakeet-tdt-v3', dictationLanguage: 'nl' }).text()).toContain(note)
  expect(render({ ...DEFAULT_HOUSE_SETTINGS, dictationModel: 'parakeet-tdt-v3', dictationLanguage: 'auto' }).text()).not.toContain(note)
  expect(render({ ...DEFAULT_HOUSE_SETTINGS, dictationModel: 'whisper-turbo', dictationLanguage: 'nl' }).text()).not.toContain('finds the language itself, so')
})

it('lists the named inputs of this Mac and keeps an unplugged choice as unavailable', async () => {
  stubBridge()
  const removeEventListener = vi.fn()
  vi.stubGlobal('navigator', {
    mediaDevices: {
      enumerateDevices: async () => [
        { kind: 'audioinput', deviceId: 'default', label: 'Default - Desk mic' },
        { kind: 'audioinput', deviceId: 'desk', label: 'Desk mic' },
        { kind: 'audioinput', deviceId: 'hidden', label: '' },
        { kind: 'audiooutput', deviceId: 'speakers', label: 'Speakers' },
      ],
      addEventListener: vi.fn(),
      removeEventListener,
    },
  })
  const { page, select } = render({ ...DEFAULT_HOUSE_SETTINGS, dictationMicrophone: 'gone' })
  await act(async () => undefined)
  expect(select('Microphone').children.join('')).toBe('System default, Desk mic, Unavailable microphone')
  expect(select('Microphone').props['data-value']).toBe('gone')
  act(() => page.unmount())
  expect(removeEventListener).toHaveBeenCalledWith('devicechange', expect.any(Function))
})
