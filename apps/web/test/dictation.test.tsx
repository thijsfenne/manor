import { DEFAULT_HOUSE_SETTINGS, type DesktopDictationBridge, type DictationModelState, type DictationModelStatus } from '@manor/contracts'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Composer } from '../src/components/Composer'
import { clearDrafts, writeDraft } from '../src/composerDrafts'
import { insertDictation } from '../src/dictation/insert'
import type { Recording } from '../src/dictation/recorder'
import { WAVE_BARS, pushLevel, useDictation } from '../src/dictation/useDictation'

vi.mock('@lexical/react/LexicalRichTextPlugin', () => ({
  RichTextPlugin: ({ contentEditable, placeholder }: { contentEditable: ReactNode; placeholder: ReactNode }) => <>{contentEditable}{placeholder}</>,
}))

// The Composer records through the real module's export; this stands in for the microphone.
const recorder = vi.hoisted(() => ({ next: null as Recording | null }))
vi.mock('../src/dictation/recorder', async (original) => ({
  ...await original<typeof import('../src/dictation/recorder')>(),
  startRecording: async () => recorder.next!,
}))

const SAMPLES = new Float32Array(16_000)

const fakeRecording = (samples = SAMPLES) => ({ stop: vi.fn(async () => samples), cancel: vi.fn() })

const modelsIn = (state: DictationModelState): DictationModelStatus[] => [{ id: 'whisper-turbo', bytes: 1_036_613_791, state, progress: 0 }]

const stubBridge = (overrides: Partial<DesktopDictationBridge> = {}, state: DictationModelState = 'ready') => ({
  onModels: (listener: (models: DictationModelStatus[]) => void) => {
    listener(modelsIn(state))
    return () => {}
  },
  download: vi.fn(async () => {}),
  cancelDownload: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  warm: vi.fn(async () => {}),
  transcribe: vi.fn<DesktopDictationBridge['transcribe']>(async () => ({ ok: true, text: ' hello there ' })),
  microphoneAccess: vi.fn<DesktopDictationBridge['microphoneAccess']>(async () => 'granted'),
  openMicrophoneSettings: vi.fn(async () => {}),
  ...overrides,
})

/** The window listeners the Escape claim adds, so a test can press Escape. */
const stubWindow = (extra: object = {}) => {
  const keydown: ((event: KeyboardEvent) => void)[] = []
  const target = {
    addEventListener: (type: string, listener: (event: KeyboardEvent) => void) => {
      if (type === 'keydown') keydown.push(listener)
    },
    removeEventListener: (type: string, listener: (event: KeyboardEvent) => void) => {
      if (type === 'keydown') keydown.splice(keydown.indexOf(listener), 1)
    },
    activeElement: null,
  }
  vi.stubGlobal('document', target)
  vi.stubGlobal('window', { ...target, setTimeout, clearTimeout, ...extra })
  return {
    escape: () => {
      const event = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() }
      for (const listener of [...keydown]) listener(event as unknown as KeyboardEvent)
      return event
    },
  }
}

afterEach(() => {
  clearDrafts()
  vi.unstubAllGlobals()
})

describe('inserting a dictation', () => {
  it('lands at the caret, spaced into the sentence', () => {
    expect(insertDictation('Hello world', 5, ' there ')).toEqual({ text: 'Hello there world', caret: 11 })
    expect(insertDictation('Hello ', 6, 'there')).toEqual({ text: 'Hello there', caret: 11 })
    expect(insertDictation('word', 0, 'A')).toEqual({ text: 'A word', caret: 1 })
    expect(insertDictation('Done.', 4, 'now')).toEqual({ text: 'Done now.', caret: 8 })
  })

  it('appends without a caret and needs no space in an empty draft', () => {
    expect(insertDictation('Hi', null, 'there')).toEqual({ text: 'Hi there', caret: 8 })
    expect(insertDictation('', null, ' hello ')).toEqual({ text: 'hello', caret: 5 })
  })
})

describe('the waveform ring', () => {
  it('keeps the last levels with the newest at the end', () => {
    expect(pushLevel([0.1, 0.2, 0.3], 0.4, 3)).toEqual([0.2, 0.3, 0.4])
    expect(pushLevel([0.1], 0.2, 3)).toEqual([0.1, 0.2])
    expect(pushLevel(Array.from({ length: WAVE_BARS }, () => 0), 1)).toHaveLength(WAVE_BARS)
  })
})

const harness = (bridge: DesktopDictationBridge, state: DictationModelState = 'ready', start: () => Promise<Recording> = async () => fakeRecording()) => {
  const keys = stubWindow()
  const onInsert = vi.fn()
  const record = vi.fn(start)
  let hook!: ReturnType<typeof useDictation>
  function Probe() {
    hook = useDictation({ bridge, settings: DEFAULT_HOUSE_SETTINGS, models: modelsIn(state), onInsert, record })
    return null
  }
  let tree!: ReactTestRenderer
  act(() => {
    tree = create(<Probe />)
  })
  return { ...keys, hook: () => hook, onInsert, record, unmount: () => act(() => tree.unmount()) }
}

describe('dictation states', () => {
  it('opens the download notice and records nothing while the model is missing', async () => {
    const bridge = stubBridge()
    const { hook, record } = harness(bridge, 'missing')
    await act(() => hook().start())
    expect(hook().notice).toEqual({ kind: 'needs-model' })
    expect(hook().phase).toBe('idle')
    expect(record).not.toHaveBeenCalled()
    expect(bridge.warm).not.toHaveBeenCalled()
  })

  it('warms the model, records, and hands the trimmed transcript to the draft on ✓', async () => {
    const bridge = stubBridge()
    const { hook, onInsert, record } = harness(bridge)
    const press = hook().start
    await act(() => press())
    // A second press on the fading microphone starts nothing.
    await act(() => press())
    expect(record).toHaveBeenCalledTimes(1)
    expect(bridge.warm).toHaveBeenCalledWith('whisper-turbo', 'auto')
    expect(hook().phase).toBe('recording')
    await act(() => hook().confirm())
    expect(bridge.transcribe).toHaveBeenCalledWith({ model: 'whisper-turbo', language: 'auto', samples: SAMPLES })
    expect(onInsert).toHaveBeenCalledWith('hello there')
    expect(hook().phase).toBe('idle')
    expect(hook().notice).toBeNull()
  })

  it('discards on ✕ and on Escape, releasing the microphone', async () => {
    const recording = fakeRecording()
    const bridge = stubBridge()
    const { hook, onInsert, escape } = harness(bridge, 'ready', async () => recording)
    await act(() => hook().start())
    act(() => hook().cancel())
    expect(recording.cancel).toHaveBeenCalledTimes(1)
    expect(hook().phase).toBe('idle')

    await act(() => hook().start())
    let event!: ReturnType<typeof escape>
    act(() => {
      event = escape()
    })
    expect(event.stopPropagation).toHaveBeenCalled()
    expect(recording.cancel).toHaveBeenCalledTimes(2)
    expect(hook().phase).toBe('idle')
    expect(bridge.transcribe).not.toHaveBeenCalled()
    expect(onInsert).not.toHaveBeenCalled()
  })

  it('shows the message of a failed transcription and keeps nothing', async () => {
    const bridge = stubBridge({ transcribe: vi.fn(async () => ({ ok: false, reason: 'failed', message: 'Manor could not transcribe this recording. Try again.' }) as const) })
    const { hook, onInsert } = harness(bridge)
    await act(() => hook().start())
    await act(() => hook().confirm())
    expect(hook().notice).toEqual({ kind: 'failed', message: 'Manor could not transcribe this recording. Try again.' })
    expect(onInsert).not.toHaveBeenCalled()
  })

  it('says no speech was heard for empty text', async () => {
    const bridge = stubBridge({ transcribe: vi.fn(async () => ({ ok: true, text: '  ' }) as const) })
    const { hook, onInsert } = harness(bridge)
    await act(() => hook().start())
    await act(() => hook().confirm())
    expect(hook().notice).toEqual({ kind: 'no-speech' })
    expect(onInsert).not.toHaveBeenCalled()
  })

  it('asks macOS why the microphone was refused', async () => {
    const bridge = stubBridge({ microphoneAccess: vi.fn(async () => 'denied' as const) })
    const { hook } = harness(bridge, 'ready', async () => {
      throw Object.assign(new Error('refused'), { name: 'NotAllowedError' })
    })
    await act(() => hook().start())
    expect(hook().notice).toEqual({ kind: 'mic-denied' })
    expect(hook().phase).toBe('idle')
  })

  it('cancels a recording when the composer goes away', async () => {
    const recording = fakeRecording()
    const { hook, unmount } = harness(stubBridge(), 'ready', async () => recording)
    await act(() => hook().start())
    unmount()
    expect(recording.cancel).toHaveBeenCalled()
  })
})

describe('the composer microphone', () => {
  const html = (props: { touchMode?: boolean } = {}) =>
    renderToStaticMarkup(<Composer agents={[]} onSend={() => true} canSend blockedNote="" {...props} />)

  it('is absent without the desktop bridge and in touch mode', () => {
    expect(html()).not.toContain('Dictate')
    stubWindow({ manorDesktop: { dictation: stubBridge() } })
    expect(html({ touchMode: true })).not.toContain('Dictate')
  })

  it('stands left of an unchanged send button with the bridge', () => {
    stubWindow({ manorDesktop: { dictation: stubBridge() } })
    const markup = html()
    expect(markup).toContain('title="Dictate"')
    expect(markup).toContain('bg-user-bg text-muted hover:bg-menu-selected hover:text-text h-8 w-8')
    expect(markup.indexOf('title="Dictate"')).toBeLessThan(markup.indexOf('Send (Enter)'))
    expect(markup).toContain('class="grid cursor-pointer place-items-center rounded-full border-0 bg-text font-medium text-bg disabled:cursor-default disabled:opacity-[0.3] text-[16px] h-8 w-8"')
  })

  it('puts the transcript into the draft on ✓ without sending it', async () => {
    const bridge = stubBridge()
    stubWindow({ manorDesktop: { dictation: bridge } })
    recorder.next = fakeRecording()
    writeDraft('dictate', { text: 'Note', images: [], files: [] })
    const sent: string[] = []
    let tree!: ReactTestRenderer
    act(() => {
      tree = create(<Composer agents={[]} draftKey="dictate" onSend={(text) => { sent.push(text); return true }} canSend blockedNote="" />)
    })
    await act(() => tree.root.findByProps({ title: 'Dictate' }).props.onClick())
    await act(() => tree.root.findByProps({ title: 'Insert dictation' }).props.onClick())
    expect(sent).toEqual([])
    act(() => tree.root.findByProps({ title: 'Send (Enter)' }).props.onClick())
    expect(sent).toEqual(['Note hello there'])
    act(() => tree.unmount())
  })
})
