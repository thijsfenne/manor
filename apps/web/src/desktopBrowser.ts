import type { DesktopBrowserBridge, DesktopComputerBridge, DesktopDictationBridge, DesktopFilesBridge, DesktopHostBridge, DesktopNotifyBridge, DesktopPermissionsBridge, DesktopPresenceBridge } from '@manor/contracts'

declare global {
  interface Window {
    /**
     * One declaration for the whole preload, so both accessors below read the same
     * shape. Optional members exist because the shell is packaged while the
     * renderer is served from the local server: an installed Manor.app that
     * predates this bridge runs today's page against yesterday's preload, and
     * that has to degrade rather than throw.
     */
    manorDesktop?: DesktopHostBridge
  }
}

/**
 * The Electron preload bridge, or nothing. Read through a function rather than
 * captured once so a component can be handed the real bridge in the desktop shell
 * and `undefined` everywhere else without either path being a special case.
 */
export function desktopBrowser(): DesktopBrowserBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.manorDesktop?.browser
}

/**
 * The host's notification bridge, or nothing. Absent in a plain browser tab and in
 * an older shell, and both degrade the same way: no banner, no badge, and no
 * fallback to the page's own `Notification` — the shell denies that permission, and
 * a web notification from a tab is a different, worse thing wearing the same name.
 */
export function desktopNotify(): DesktopNotifyBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.manorDesktop?.notify
}

/**
 * Whether the user is at the Mac, or nothing in a browser tab or an older shell. Nothing
 * reports nothing, and the server then treats every phone push as free to send.
 */
export function desktopPresence(): DesktopPresenceBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.manorDesktop?.presence
}

/** The Escape stop for computer use, or nothing in a browser tab or an older shell. */
export function desktopComputer(): DesktopComputerBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.manorDesktop?.computer
}

/**
 * Open-in-app and Save-as for delivered files, or nothing. A browser tab and a shell
 * older than the bridge fall back to the link itself, which the browser opens or saves.
 */
export function desktopFiles(): DesktopFilesBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.manorDesktop?.files
}

/** Reads the local server's key through the desktop shell; nothing in a browser tab, on the phone or on an older shell. */
export function desktopLocalAccess(): (() => Promise<string | null>) | undefined {
  return typeof window === 'undefined' ? undefined : window.manorDesktop?.localAccess
}

/** The native folder dialog, or nothing in a browser tab, on the phone or on an older shell. */
export function desktopChooseFolder(): (() => Promise<string | null>) | undefined {
  return typeof window === 'undefined' ? undefined : window.manorDesktop?.chooseFolder
}

/**
 * Whether the window's traffic lights are drawn inside the page (macOS `hiddenInset`).
 * True only in the desktop shell on macOS: a browser tab and a Windows or Linux shell
 * both keep a frame of their own, and an older preload without `platform` reports false
 * so it keeps the layout it was built against.
 */
export function desktopTitleBarIsInset(): boolean {
  return typeof window !== 'undefined' && window.manorDesktop?.platform === 'darwin'
}

/** Keeps `--desktop-zoom` in lockstep with the shell, so the titlebar inset stays in window points. */
export function listenDesktopZoom(): void {
  window.manorDesktop?.onZoomFactor?.((zoom) => {
    if (typeof zoom !== 'number' || !(zoom > 0)) return
    document.documentElement.style.setProperty('--desktop-zoom', String(zoom))
  })
}

/**
 * One agent action in flight against one chat's shared browser. Held per chat
 * because two rooms can be driven at once; within a chat the server's lock means
 * there is only ever one.
 */
export interface BrowserActivity {
  agentId: string
  agentName: string
  tool: string
}

/** What the panel says while an agent has the page. */
export function browserActorLabel(activity: BrowserActivity | undefined): string | null {
  return activity === undefined ? null : `${activity.agentName} is using the browser`
}

/** Open a website in one Browser tab set, reusing its active tab when it cannot add one. */
export async function openWebsiteInBrowser(
  browser: Pick<DesktopBrowserBridge, 'newTab' | 'navigate'>,
  chatId: string,
  url: string,
): Promise<void> {
  try {
    await browser.newTab(chatId, url)
  } catch (tabError) {
    try { await browser.navigate(url, chatId) }
    catch { throw tabError }
  }
}

/** Match only complete URLs. Query strings and fragments can identify different documents. */
/** `proceed` runs before each native step and throws once the calling turn has stopped. */
export async function reuseBrowserTab(browser: DesktopBrowserBridge, chatId: string, rawUrl: string, proceed = () => {}) {
  const url = new URL(rawUrl)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('An HTTP or HTTPS URL is required.')
  proceed()
  const state = await browser.tabs(chatId)
  if (state.chatId !== chatId) throw new Error('The browser returned a different chat session.')
  const matches = state.tabs.filter((tab) => {
    try { return new URL(tab.url).href === url.href } catch { return false }
  })
  const match = matches.find((tab) => tab.id === state.activeTabId) ?? matches[0]
  if (match === undefined) return undefined
  if (match.id !== state.activeTabId) proceed()
  const selected = match.id === state.activeTabId ? state : await browser.tabs(chatId, match.id)
  const tab = selected.tabs.find((candidate) => candidate.id === match.id)
  // A closed or navigated tab must fail visibly rather than report the previous page.
  if (selected.chatId !== chatId || selected.activeTabId !== match.id || tab?.url !== match.url) {
    throw new Error('The matching browser tab is no longer available.')
  }
  return { state: selected, tab }
}

/** Manor's macOS permissions, or nothing in a browser tab or a shell that predates the bridge. */
export function desktopPermissions(): DesktopPermissionsBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.manorDesktop?.permissions
}

/** Local dictation on the Mac, or nothing in a browser tab or a shell that predates the bridge. */
export function desktopDictation(): DesktopDictationBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.manorDesktop?.dictation
}
