import path from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { BROWSER_PREVIEW_CHANNEL, BROWSER_SHORTCUT_CHANNEL, BROWSER_STATE_CHANNEL } from './browserChannels'
import { BROWSER_WEBVIEWS_CHANNEL } from './browserWebviews'
import {
  DICTATION_CANCEL_CHANNEL, DICTATION_DOWNLOAD_CHANNEL, DICTATION_MICROPHONE_CHANNEL, DICTATION_MICROPHONE_SETTINGS_CHANNEL,
  DICTATION_MODELS_CHANNEL, DICTATION_REMOVE_CHANNEL, DICTATION_TRANSCRIBE_CHANNEL, DICTATION_WARM_CHANNEL,
} from './dictationChannels'
import { CHOOSE_FOLDER_CHANNEL } from './folderDialog'
import { LOCAL_ACCESS_CHANNEL } from './localAccess'
import { NOTIFY_ACTIVATE_CHANNEL } from './notifyChannels'
import { PRESENCE_CHANNEL } from './presence'
import { PERMISSIONS_OPEN_CHANNEL, PERMISSIONS_STATUS_CHANNEL } from './systemPermissions'
import { FULLSCREEN_CHANNEL, ZOOM_CHANNEL } from './zoomChannels'

/**
 * The preload is the whole capability. If it throws, `window.manorDesktop` is simply
 * absent, the renderer decides the desktop host is not there, and Manor hides the
 * browser rail item — a feature that disappears with no error anywhere on screen.
 * Sandboxed preloads only get a polyfilled `require` for `electron` and a few Node
 * built-ins, so this smoke exists to catch the day one of them gains an import.
 */
const EXPECTED = [
  'show', 'hide', 'webviews', 'close', 'endAgentUse', 'interruptAgentInput', 'navigate', 'snapshot', 'click', 'type', 'press', 'scroll',
  'configure', 'hardReload', 'openDevTools', 'openPreviewWindow', 'clearCookies', 'clearCache', 'setSiteAdblock', 'history', 'bookmarks', 'toggleBookmark', 'onShortcut',
  'screenshot', 'tabs', 'newTab', 'closeTab', 'pinTab', 'goBack', 'goForward', 'reload', 'stopLoading',
  'startPreview', 'stopPreview', 'onPreview', 'clearData', 'browserImportStatus', 'setBrowserImport', 'selectPageContext', 'onState',
]
const EXPECTED_NOTIFY = ['show', 'badge', 'onActivate']
const EXPECTED_FILES = ['open', 'save']
/** Every dictation call in bridge order, each answered by a stub that returns its own channel name. */
const DICTATION_CALLS = [
  ['download', DICTATION_DOWNLOAD_CHANNEL],
  ['cancelDownload', DICTATION_CANCEL_CHANNEL],
  ['remove', DICTATION_REMOVE_CHANNEL],
  ['warm', DICTATION_WARM_CHANNEL],
  ['transcribe', DICTATION_TRANSCRIBE_CHANNEL],
  ['microphoneAccess', DICTATION_MICROPHONE_CHANNEL],
  ['openMicrophoneSettings', DICTATION_MICROPHONE_SETTINGS_CHANNEL],
] as const

app.whenReady().then(async () => {
  const failures: string[] = []
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  })
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    failures.push(`${path.basename(preloadPath)}: ${error.message}`)
  })
  try {
    await window.loadURL('about:blank')
    const exposed = await window.webContents.executeJavaScript(
      'Object.keys(globalThis.manorDesktop?.browser ?? {})',
    ) as string[]
    if (failures.length > 0) throw new Error(`The preload did not run. ${failures.join(' ')}`)
    const missing = EXPECTED.filter((name) => !exposed.includes(name))
    if (missing.length > 0) throw new Error(`The bridge is missing ${missing.join(', ')}.`)

    const webviews = await window.webContents.executeJavaScript('Object.keys(manorDesktop.browser.webviews)') as string[]
    if (['list', 'attach', 'presented', 'onChange'].some((method) => !webviews.includes(method))) throw new Error('Incomplete guest bridge.')
    await window.webContents.executeJavaScript(`(() => {
      globalThis.__guestsHeard = new Promise(resolve => {
        const off = manorDesktop.browser.webviews.onChange(snapshot => { off(); resolve(snapshot) })
      })
    })()`)
    window.webContents.send(BROWSER_WEBVIEWS_CHANNEL, { revision: 7, surfaces: [] })
    if ((await window.webContents.executeJavaScript('globalThis.__guestsHeard')).revision !== 7) throw new Error('Guest push channel mismatch.')

    await window.webContents.executeJavaScript(`(() => {
      globalThis.__previewHeard = new Promise((resolve) => {
        const unsubscribe = globalThis.manorDesktop.browser.onPreview((update) => {
          unsubscribe()
          resolve(update)
        })
      })
    })()`)
    window.webContents.send(BROWSER_PREVIEW_CHANNEL, { chatId: 'smoke', subscriptionId: 'preview', status: 'stopped' })
    const preview = await window.webContents.executeJavaScript('globalThis.__previewHeard') as { subscriptionId: string }
    if (preview.subscriptionId !== 'preview') throw new Error('Preview push channel mismatch.')

    await window.webContents.executeJavaScript(`(() => {
      globalThis.__shortcutHeard = new Promise(resolve => {
        const off = manorDesktop.browser.onShortcut(shortcut => { off(); resolve(shortcut) })
      })
    })()`)
    window.webContents.send(BROWSER_SHORTCUT_CHANNEL, 'new-tab')
    if (await window.webContents.executeJavaScript('globalThis.__shortcutHeard') !== 'new-tab') {
      throw new Error('Browser shortcut channel mismatch.')
    }

    const exposedNotify = await window.webContents.executeJavaScript(
      'Object.keys(globalThis.manorDesktop?.notify ?? {})',
    ) as string[]
    const missingNotify = EXPECTED_NOTIFY.filter((name) => !exposedNotify.includes(name))
    if (missingNotify.length > 0) throw new Error(`The notify bridge is missing ${missingNotify.join(', ')}.`)
    const exposedFiles = await window.webContents.executeJavaScript(
      'Object.keys(globalThis.manorDesktop?.files ?? {})',
    ) as string[]
    const missingFiles = EXPECTED_FILES.filter((name) => !exposedFiles.includes(name))
    if (missingFiles.length > 0) throw new Error(`The files bridge is missing ${missingFiles.join(', ')}.`)

    // The folder dialog channel is a string main and preload both spell out; a stub
    // handler proves the preload's end reaches the name main registers.
    ipcMain.handle(CHOOSE_FOLDER_CHANNEL, () => '/smoke/folder')
    if (await window.webContents.executeJavaScript('globalThis.manorDesktop?.chooseFolder?.()') !== '/smoke/folder') {
      throw new Error('Folder dialog channel mismatch.')
    }
    ipcMain.handle(LOCAL_ACCESS_CHANNEL, () => 'smoke-key')
    if (await window.webContents.executeJavaScript('globalThis.manorDesktop?.localAccess?.()') !== 'smoke-key') {
      throw new Error('Local access channel mismatch.')
    }
    ipcMain.handle(PERMISSIONS_STATUS_CHANNEL, () => 'smoke-status')
    if (await window.webContents.executeJavaScript('globalThis.manorDesktop?.permissions?.status()') !== 'smoke-status') {
      throw new Error('Permissions status channel mismatch.')
    }
    ipcMain.handle(PERMISSIONS_OPEN_CHANNEL, (_event, id: unknown) => `opened ${String(id)}`)
    if (await window.webContents.executeJavaScript(`globalThis.manorDesktop?.permissions?.open('accessibility')`) !== 'opened accessibility') {
      throw new Error('Permissions open channel mismatch.')
    }

    // Dictation's channels are literals in the preload too. Drift is a microphone button
    // whose download, transcription or model list never answers.
    // The transcribe stub also checks the samples arrive typed, since main refuses anything else.
    for (const [, channel] of DICTATION_CALLS) {
      ipcMain.handle(channel, (_event, request: unknown) => channel !== DICTATION_TRANSCRIBE_CHANNEL ||
        (request as { samples?: unknown } | undefined)?.samples instanceof Float32Array ? channel : 'untyped samples')
    }
    const dictationAnswers = await window.webContents.executeJavaScript(`(async () => {
      const dictation = manorDesktop.dictation
      return [
        await dictation.download('whisper-turbo'),
        await dictation.cancelDownload('whisper-turbo'),
        await dictation.remove('whisper-turbo'),
        await dictation.warm('whisper-turbo', 'auto'),
        await dictation.transcribe({ model: 'whisper-turbo', language: 'auto', samples: new Float32Array(4) }),
        await dictation.microphoneAccess(),
        await dictation.openMicrophoneSettings(),
      ]
    })()`) as string[]
    const driftedDictation = DICTATION_CALLS.filter(([, channel], index) => dictationAnswers[index] !== channel)
    if (driftedDictation.length > 0) throw new Error(`Dictation channel mismatch for ${driftedDictation.map(([method]) => method).join(', ')}.`)
    // `onModels` pulls the current list on subscribe, then hears each push on the same channel.
    ipcMain.handle(DICTATION_MODELS_CHANNEL, () => [{ id: 'pulled' }])
    await window.webContents.executeJavaScript(`(() => {
      globalThis.__modelsHeard = []
      let resolvePulled, resolvePushed
      globalThis.__modelsPulled = new Promise((resolve, reject) => {
        resolvePulled = resolve
        setTimeout(() => reject(new Error('no model list was pulled')), 5000)
      })
      globalThis.__modelsPushed = new Promise((resolve, reject) => {
        resolvePushed = resolve
        setTimeout(() => reject(new Error('no model list was pushed')), 10000)
      })
      manorDesktop.dictation.onModels((models) => {
        globalThis.__modelsHeard.push(models[0].id)
        if (models[0].id === 'pulled') resolvePulled(true)
        if (models[0].id === 'pushed') resolvePushed(globalThis.__modelsHeard)
      })
      return true
    })()`)
    await window.webContents.executeJavaScript('globalThis.__modelsPulled')
    window.webContents.send(DICTATION_MODELS_CHANNEL, [{ id: 'pushed' }])
    const modelsHeard = await window.webContents.executeJavaScript('globalThis.__modelsPushed') as string[]
    if (modelsHeard.join(',') !== 'pulled,pushed') throw new Error(`The models channel delivered ${JSON.stringify(modelsHeard)}.`)

    // The push channel is the one string main and preload must agree on, and the
    // preload cannot import it. A disagreement is a tab strip that never updates.
    // Parked on a global first: `send` from this process would otherwise race the
    // renderer getting round to registering the listener at all.
    await window.webContents.executeJavaScript(`(() => {
      globalThis.__manorHeard = new Promise((resolve, reject) => {
        globalThis.manorDesktop.browser.onState(resolve)
        setTimeout(() => reject(new Error('no state arrived')), 5000)
      })
      return true
    })()`)
    window.webContents.send(BROWSER_STATE_CHANNEL, { chatId: 'smoke', tabs: [], activeTabId: null })
    const state = await window.webContents.executeJavaScript('globalThis.__manorHeard') as { chatId: string }
    if (state.chatId !== 'smoke') throw new Error(`The state channel delivered ${JSON.stringify(state)}.`)

    // The notify bridge's own literal, checked the same way. Drift here is a
    // notification that appears, is clicked, and opens nothing.
    await window.webContents.executeJavaScript(`(() => {
      globalThis.__manorActivated = new Promise((resolve, reject) => {
        globalThis.manorDesktop.notify.onActivate(resolve)
        setTimeout(() => reject(new Error('no activation arrived')), 5000)
      })
      return true
    })()`)
    window.webContents.send(NOTIFY_ACTIVATE_CHANNEL, 'smoke-chat')
    const activated = await window.webContents.executeJavaScript('globalThis.__manorActivated') as string
    if (activated !== 'smoke-chat') throw new Error(`The activate channel delivered ${JSON.stringify(activated)}.`)

    // Presence uses the same literal-in-preload rule. Drift is a phone that buzzes
    // beside a Mac in use, with nothing failing anywhere to say why.
    await window.webContents.executeJavaScript(`(() => {
      globalThis.__manorPresence = new Promise((resolve, reject) => {
        globalThis.manorDesktop.presence.onChange(resolve)
        setTimeout(() => reject(new Error('no presence arrived')), 5000)
      })
      return true
    })()`)
    window.webContents.send(PRESENCE_CHANNEL, true)
    if (await window.webContents.executeJavaScript('globalThis.__manorPresence') !== true) {
      throw new Error('Presence channel mismatch.')
    }

    const exposedHost = await window.webContents.executeJavaScript(
      'Object.keys(globalThis.manorDesktop ?? {})',
    ) as string[]
    const missingHost = ['onZoomFactor', 'onFullscreen', 'platform'].filter((name) => !exposedHost.includes(name))
    if (missingHost.length > 0) throw new Error(`The host bridge is missing ${missingHost.join(', ')}.`)

    // Zoom and fullscreen use the same literal-in-preload rule. Drift is icons
    // under the traffic lights, or a reserved corner in native fullscreen.
    await window.webContents.executeJavaScript(`(() => {
      globalThis.__manorZoom = new Promise((resolve, reject) => {
        globalThis.manorDesktop.onZoomFactor(resolve)
        setTimeout(() => reject(new Error('no zoom arrived')), 5000)
      })
      return true
    })()`)
    window.webContents.send(ZOOM_CHANNEL, 1.25)
    const zoom = await window.webContents.executeJavaScript('globalThis.__manorZoom') as number
    if (zoom !== 1.25) throw new Error(`The zoom channel delivered ${JSON.stringify(zoom)}.`)

    await window.webContents.executeJavaScript(`(() => {
      globalThis.__manorFullscreen = new Promise((resolve, reject) => {
        globalThis.manorDesktop.onFullscreen(resolve)
        setTimeout(() => reject(new Error('no fullscreen arrived')), 5000)
      })
      return true
    })()`)
    window.webContents.send(FULLSCREEN_CHANNEL, true)
    const fullscreen = await window.webContents.executeJavaScript('globalThis.__manorFullscreen') as boolean
    if (fullscreen !== true) throw new Error(`The fullscreen channel delivered ${JSON.stringify(fullscreen)}.`)

    console.log(JSON.stringify({
      exposed,
      exposedNotify,
      exposedHost,
      stateChannel: BROWSER_STATE_CHANNEL,
      activateChannel: NOTIFY_ACTIVATE_CHANNEL,
      zoomChannel: ZOOM_CHANNEL,
      fullscreenChannel: FULLSCREEN_CHANNEL,
      dictationAnswers,
      modelsHeard,
      received: state,
      activated,
      zoom,
      fullscreen,
    }, null, 2))
  } finally {
    window.destroy()
    app.quit()
  }
}).catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})
