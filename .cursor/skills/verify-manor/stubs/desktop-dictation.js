// Stand-in for the Electron preload's `window.manorDesktop.dictation` and for the Mac's
// microphone, so the headless spike can show the composer's dictation states and
// Settings → Voice as the desktop app does. Load it with
// `MANOR_VERIFY_INIT_SCRIPT=$PWD/.cursor/skills/verify-manor/stubs/desktop-dictation.js`
// on `launch`. No speech engine runs here: a transcription answers after 1.5 seconds
// with a fixed Dutch sentence.
//
// Whisper Turbo starts not downloaded and Parakeet ready. A download takes about four
// seconds. The microphone is a synthetic tone that swells and fades, so the waveform
// moves. Chords switch the next outcome (press them with the focus anywhere):
//   Control+Alt+Shift+1  the next transcription fails
//   Control+Alt+Shift+2  macOS refuses the microphone
//   Control+Alt+Shift+3  the next transcription hears no speech
//   Control+Alt+Shift+4  the next download fails
//   Control+Alt+Shift+0  back to the defaults
(() => {
  const BYTES = { 'whisper-turbo': 1_036_613_791, 'parakeet-tdt-v3': 670_576_784 }
  const models = {
    'whisper-turbo': { id: 'whisper-turbo', bytes: BYTES['whisper-turbo'], state: 'missing', progress: 0 },
    'parakeet-tdt-v3': { id: 'parakeet-tdt-v3', bytes: BYTES['parakeet-tdt-v3'], state: 'ready', progress: 0 },
  }
  const outcome = { transcription: 'ok', microphone: 'ok', download: 'ok' }
  const listeners = new Set()
  const timers = new Map()
  const snapshot = () => Object.values(models).map((model) => ({ ...model }))
  const push = () => { for (const listener of listeners) listener(snapshot()) }
  const set = (id, patch) => {
    const { error: _error, ...rest } = models[id]
    models[id] = { ...rest, ...patch }
    push()
  }
  const stopTimer = (id) => {
    clearInterval(timers.get(id))
    timers.delete(id)
  }

  window.__manorDictation = { transcribed: [], warmed: [], openedSettings: 0 }

  const dictation = {
    onModels: (listener) => {
      listeners.add(listener)
      queueMicrotask(() => listener(snapshot()))
      return () => listeners.delete(listener)
    },
    download: async (id) => {
      if (models[id].state === 'downloading') return
      set(id, { state: 'downloading', progress: 0 })
      let step = 0
      timers.set(id, setInterval(() => {
        step += 1
        if (outcome.download === 'fail' && step === 8) {
          stopTimer(id)
          outcome.download = 'ok'
          set(id, { state: 'failed', progress: 0, error: 'The download did not finish. Check your connection and try again.' })
        } else if (step >= 20) {
          stopTimer(id)
          set(id, { state: 'ready', progress: 0 })
        } else {
          set(id, { state: 'downloading', progress: step / 20 })
        }
      }, 200))
    },
    cancelDownload: async (id) => {
      stopTimer(id)
      set(id, { state: 'missing', progress: 0 })
    },
    remove: async (id) => {
      stopTimer(id)
      set(id, { state: 'missing', progress: 0 })
    },
    warm: async (model, language) => { window.__manorDictation.warmed.push({ model, language }) },
    transcribe: async ({ model, language, samples }) => {
      window.__manorDictation.transcribed.push({ model, language, seconds: samples.length / 16_000 })
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      if (models[model].state !== 'ready') {
        return { ok: false, reason: 'model-missing', message: 'Download a dictation model in Settings first.' }
      }
      const kind = outcome.transcription
      outcome.transcription = 'ok'
      if (kind === 'fail') return { ok: false, reason: 'failed', message: 'Manor could not transcribe this recording. Try again.' }
      if (kind === 'silence') return { ok: true, text: '' }
      return { ok: true, text: 'Dit is een gedicteerde zin.' }
    },
    microphoneAccess: async () => (outcome.microphone === 'denied' ? 'denied' : 'granted'),
    openMicrophoneSettings: async () => { window.__manorDictation.openedSettings += 1 },
  }
  window.manorDesktop = { ...(window.manorDesktop ?? {}), dictation }

  // A tone whose loudness swells and fades about twice a second, as speech does.
  const syntheticMicrophone = () => {
    const context = new AudioContext()
    const tone = context.createOscillator()
    tone.frequency.value = 220
    const loudness = context.createGain()
    loudness.gain.value = 0.25
    const swell = context.createOscillator()
    swell.frequency.value = 2.3
    const depth = context.createGain()
    depth.gain.value = 0.22
    swell.connect(depth).connect(loudness.gain)
    const out = context.createMediaStreamDestination()
    tone.connect(loudness).connect(out)
    tone.start()
    swell.start()
    for (const track of out.stream.getTracks()) track.addEventListener('ended', () => void context.close())
    return out.stream
  }
  const devices = [
    { deviceId: 'default', kind: 'audioinput', label: 'Default - Built-in Microphone', groupId: 'a' },
    { deviceId: 'built-in', kind: 'audioinput', label: 'Built-in Microphone', groupId: 'a' },
    { deviceId: 'desk', kind: 'audioinput', label: 'Desk Microphone', groupId: 'b' },
  ]
  const media = {
    getUserMedia: async () => {
      if (outcome.microphone === 'denied') throw new DOMException('Permission denied', 'NotAllowedError')
      return syntheticMicrophone()
    },
    enumerateDevices: async () => devices.map((device) => ({ ...device, toJSON: () => device })),
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: media })

  window.addEventListener('keydown', (event) => {
    if (!(event.ctrlKey && event.altKey && event.shiftKey)) return
    if (event.code === 'Digit1') outcome.transcription = 'fail'
    else if (event.code === 'Digit2') outcome.microphone = 'denied'
    else if (event.code === 'Digit3') outcome.transcription = 'silence'
    else if (event.code === 'Digit4') outcome.download = 'fail'
    else if (event.code === 'Digit0') Object.assign(outcome, { transcription: 'ok', microphone: 'ok', download: 'ok' })
    else return
    event.preventDefault()
    event.stopPropagation()
  }, true)
})()
