// Stand-in for the Electron preload's `window.manorDesktop.browser`, so the headless
// spike can show the Browser chrome (tab strip, pins, drag reorder) without the native
// shell. Pages never render: there is no webview, only tab state. Load it with
// `MANOR_VERIFY_INIT_SCRIPT=.cursor/skills/verify-manor/stubs/desktop-browser.js` on
// `launch`. Every chat starts with two pins and four ordinary tabs.
(() => {
  const mark = (fill, letter) => 'data:image/svg+xml,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="${fill}"/>` +
    `<text x="8" y="12" font-size="10" font-family="sans-serif" text-anchor="middle" fill="white">${letter}</text></svg>`)
  const seed = [
    ['Gmail', 'https://mail.google.com/', mark('#c5221f', 'G'), true],
    ['Calendar', 'https://calendar.google.com/', mark('#1a73e8', 'C'), true],
    ['inspace.design', 'https://inspace.design/', mark('#7b5cd6', 'i')],
    ['uxwork.nl', 'https://uxwork.nl/', mark('#111111', 'U')],
    ['Albert Heijn', 'https://www.ah.nl/', mark('#00a0e2', 'A')],
    ['Hobbyshop', 'https://hobbyshop.example/', mark('#e8710a', 'H')],
  ]
  const sessions = new Map()
  const listeners = new Set()
  // Saved passwords: www.ah.nl has one from Dia; navigating to https://login.example/
  // stands in for a sign-in there and raises a save offer on that tab. Navigating to
  // https://signin.example/ opens a sign-in popup on login.example over the tab, and
  // https://fail.example/ makes the next saved-password list read fail once.
  const vault = [
    { id: 'login-1', origin: 'https://login.example', username: 'someone@example.invalid', source: 'manor', updatedAt: Date.now() },
    { id: 'login-2', origin: 'https://www.ah.nl', username: 'sam', source: 'dia', updatedAt: Date.now() },
  ]
  const neverSave = [{ origin: 'https://news.example', source: 'dia' }]
  const offers = new Map()
  window.__manorPasswordListFails = 0
  const savedList = () => structuredClone({ logins: vault, neverSave })
  window.__manorPasswordFills = []
  const originOf = (url) => { try { return new URL(url).origin } catch { return '' } }
  // Ad blocking: every web page "blocked" seven requests until its host is switched off.
  const adblockOff = new Set()
  const hostOf = (url) => { try { const { protocol, hostname } = new URL(url); return /^https?:$/.test(protocol) ? hostname : null } catch { return null } }
  const withPasswords = (state) => {
    for (const tab of state.tabs) {
      const host = hostOf(tab.signIn?.url ?? tab.url)
      if (host === null) delete tab.adblock
      else tab.adblock = { blocking: !adblockOff.has(host), blocked: adblockOff.has(host) ? 0 : 7 }
      const site = originOf(tab.signIn?.url ?? tab.url)
      const logins = vault.filter((login) => login.origin === site).map(({ id, username }) => ({ id, username }))
      const offer = offers.get(tab.id)
      if (logins.length > 0 || offer) tab.passwords = { logins, ...(offer ? { offer } : {}) }
      else delete tab.passwords
    }
    return state
  }
  const session = (chatId) => {
    if (!sessions.has(chatId)) {
      const tabs = seed.map(([title, url, favicon, pinned], index) => ({
        id: `tab-${index + 1}`, title, url, favicon, pinned: pinned === true,
        loading: false, canGoBack: false, canGoForward: false,
      }))
      sessions.set(chatId, { chatId, tabs, activeTabId: tabs[4].id })
    }
    return sessions.get(chatId)
  }
  const publish = (state) => {
    const copy = structuredClone(withPasswords(state))
    listeners.forEach((listener) => listener(copy))
    return copy
  }
  const page = (chatId) => {
    const state = session(chatId)
    const tab = state.tabs.find((t) => t.id === state.activeTabId)
    return { url: tab?.url ?? '', title: tab?.title ?? '' }
  }
  const done = async () => {}
  // Reload swaps the page text, so a find bar left open shows whether it searched the reloaded page.
  let findText = 'apples and pears, more apples, apples again'
  let findActive = 0
  let next = 100
  const browser = {
    // Present so the chrome unlocks; no surfaces, so no <webview> is ever created.
    webviews: {
      list: async () => ({ revision: 0, surfaces: [] }),
      onChange: () => () => {},
      attach: done, presented: done,
    },
    show: done, hide: done, close: done, goBack: done, goForward: done,
    reload: async (chatId) => {
      const state = session(chatId)
      const tab = state.tabs.find((open) => open.id === state.activeTabId)
      if (tab === undefined) return
      tab.loading = true; publish(state)
      await new Promise((resolve) => setTimeout(resolve, 300))
      findText = 'pears only'
      tab.loading = false; publish(state)
    },
    setSiteAdblock: async (chatId, blocking) => {
      const state = session(chatId)
      const shown = state.tabs.find((t) => t.id === state.activeTabId)
      const host = hostOf(shown?.signIn?.url ?? shown?.url ?? '')
      if (host === null) throw new Error('Ad blocking can only be switched for a website.')
      if (blocking) adblockOff.delete(host)
      else adblockOff.add(host)
      await browser.reload(chatId)
      sessions.forEach(publish)
    },
    stopLoading: done, clearData: done,
    // Page zoom is the only setting the stub keeps, so the address field's zoom button shows.
    configure: async (chatId, patch) => {
      const state = session(chatId)
      const tab = state.tabs.find((t) => t.id === state.activeTabId)
      if (tab && patch.zoomFactor !== undefined) tab.settings = { viewport: null, appearance: 'system', ...tab.settings, zoomFactor: patch.zoomFactor }
      publish(state)
    },
    // Every page "contains" this sentence, so find has something to count; signin.example
    // reads "pears only" once its sign-in popup is closed.
    findInPage: async (chatId, query, { forward, next }) => {
      const state = session(chatId)
      const tab = state.tabs.find((t) => t.id === state.activeTabId)
      const visible = tab?.url.includes('signin.example') && tab.signIn === undefined ? 'pears only' : findText
      const matches = visible.split(query.toLowerCase()).length - 1
      findActive = matches === 0 ? 0 : !next ? 1 : ((findActive - 1 + (forward ? 1 : -1) + matches) % matches) + 1
      return { matches, active: findActive }
    },
    stopFind: done,
    reopenClosedTab: async (chatId) => publish(session(chatId)),
    navigate: async (url, chatId) => {
      const state = session(chatId)
      const tab = state.tabs.find((t) => t.id === state.activeTabId)
      if (tab) Object.assign(tab, { url, title: new URL(url).host })
      if (tab) delete tab.signIn
      if (new URL(url).host === 'fail.example') window.__manorPasswordListFails = 1
      if (tab && new URL(url).host === 'signin.example') tab.signIn = { url: 'https://login.example/authorize' }
      if (tab && new URL(url).host === 'login.example') {
        offers.set(tab.id, { kind: 'save', origin: 'https://login.example', username: 'work@example.com' })
      }
      publish(state)
      return page(chatId)
    },
    snapshot: async (chatId) => ({ ...page(chatId), text: '', elements: [] }),
    screenshot: async () => { throw new Error('No pages in the verify stub') },
    click: async (selector, chatId) => ({ ...page(chatId), selector }),
    type: async (selector) => ({ selector }),
    press: async (key) => ({ key }),
    scroll: async (deltaX, deltaY) => ({ deltaX, deltaY }),
    tabs: async (chatId, select) => {
      const state = session(chatId)
      if (select !== undefined) {
        state.activeTabId = select
        state.tabs.forEach((t) => { if (t.id === select) t.unseen = false })
      }
      return publish(state)
    },
    newTab: async (chatId, url) => {
      const state = session(chatId)
      const tab = { id: `tab-${next++}`, title: url ? new URL(url).host : '', url: url ?? 'about:blank',
        loading: false, canGoBack: false, canGoForward: false }
      state.tabs.push(tab)
      state.activeTabId = tab.id
      return publish(state)
    },
    closeTab: async (tabId, chatId) => {
      const state = session(chatId)
      const at = state.tabs.findIndex((t) => t.id === tabId)
      state.tabs = state.tabs.filter((t) => t.id !== tabId)
      if (state.activeTabId === tabId) state.activeTabId = state.tabs[Math.max(0, at - 1)]?.id ?? null
      return publish(state)
    },
    pinTab: async (tabId, chatId, pinned) => {
      const state = session(chatId)
      const tab = state.tabs.find((t) => t.id === tabId)
      if (tab) tab.pinned = pinned
      state.tabs = [...state.tabs.filter((t) => t.pinned), ...state.tabs.filter((t) => !t.pinned)]
      return publish(state)
    },
    moveTab: async (tabId, chatId, index) => {
      const state = session(chatId)
      const tab = state.tabs.find((t) => t.id === tabId)
      const rest = state.tabs.filter((t) => t.id !== tabId)
      const pins = rest.filter((t) => t.pinned).length
      const at = tab.pinned ? Math.min(index, pins) : Math.max(index, pins)
      rest.splice(at, 0, tab)
      state.tabs = rest
      return publish(state)
    },
    history: async () => [],
    bookmarks: async () => [],
    // No page renders here, so a fill shows as the active tab's title instead.
    fillPassword: async (chatId, loginId) => {
      window.__manorPasswordFills.push({ chatId, loginId })
      const state = session(chatId)
      const tab = state.tabs.find((t) => t.id === state.activeTabId)
      const login = vault.find((entry) => entry.id === loginId)
      if (tab && login) tab.title = `Filled ${login.username}`
      publish(state)
    },
    // An agent's fill request: the lookup names the active tab's exact origin, and the
    // fill insists on that tab and origin, as the desktop host does.
    findSavedLogin: async (chatId, username) => {
      const state = session(chatId)
      const tab = state.tabs.find((t) => t.id === state.activeTabId)
      if (!tab) throw new Error('This chat has no browser tab to fill.')
      const origin = originOf(tab.signIn?.url ?? tab.url)
      const login = vault.find((entry) => entry.origin === origin && (username === undefined || entry.username === username))
      return { tabId: tab.id, pageId: 1, origin, ...(login ? { login: { id: login.id, username: login.username } } : {}), passwordField: true }
    },
    // A secret card binds the active tab like a saved-login fill does; the value is
    // counted, never kept, so the stub holds nothing a test could mistake for storage.
    findPasswordField: async (chatId) => {
      const state = session(chatId)
      const tab = state.tabs.find((t) => t.id === state.activeTabId)
      if (!tab) throw new Error('This chat has no browser tab to fill.')
      return { tabId: tab.id, pageId: 1, origin: originOf(tab.signIn?.url ?? tab.url), passwordField: true }
    },
    fillSecret: async (chatId, target) => {
      const state = session(chatId)
      const tab = state.tabs.find((t) => t.id === state.activeTabId)
      if (!tab || tab.id !== target.tabId) throw new Error('The browser switched to another tab, so nothing was filled.')
      if (originOf(tab.signIn?.url ?? tab.url) !== target.origin) throw new Error('The page moved to another site, so nothing was filled.')
      tab.title = `Filled ${target.value.length} characters`
      publish(state)
    },
    fillSavedLogin: async (chatId, target) => {
      const state = session(chatId)
      const tab = state.tabs.find((t) => t.id === state.activeTabId)
      if (!tab || tab.id !== target.tabId) throw new Error('The browser switched to another tab before Fill was clicked, so nothing was filled.')
      const current = originOf(tab.signIn?.url ?? tab.url)
      if (current !== target.origin) {
        throw new Error(`The page moved from ${new URL(target.origin).host} to ${new URL(current).host} before Fill was clicked, so nothing was filled.`)
      }
      const login = vault.find((entry) => entry.id === target.loginId)
      window.__manorPasswordFills.push({ chatId, loginId: target.loginId, agent: true })
      tab.title = `Filled ${login.username}`
      publish(state)
      return { username: login.username }
    },
    answerPasswordOffer: async (chatId, tabId, choice) => {
      const offer = offers.get(tabId)
      offers.delete(tabId)
      if (offer && choice === 'save') {
        vault.push({ id: `login-${next++}`, origin: offer.origin, username: offer.username, source: 'manor', updatedAt: Date.now() })
      }
      if (offer && choice === 'never') neverSave.push({ origin: offer.origin, source: 'manor' })
      publish(session(chatId))
    },
    savedPasswords: async () => {
      if (window.__manorPasswordListFails > 0) {
        window.__manorPasswordListFails -= 1
        throw new Error('Manor Safe Storage is unavailable, so passwords cannot be read.')
      }
      return savedList()
    },
    removeSavedPasswords: async (target) => {
      const keep = (entry) => target !== undefined &&
        ('loginId' in target ? entry.id !== target.loginId : entry.origin !== target.neverSaveOrigin)
      vault.splice(0, vault.length, ...vault.filter(keep))
      neverSave.splice(0, neverSave.length, ...neverSave.filter(keep))
      sessions.forEach(publish)
      return savedList()
    },
    cancelSignIn: async (tabId, chatId) => {
      const tab = session(chatId).tabs.find((t) => t.id === tabId)
      if (tab) delete tab.signIn
      publish(session(chatId))
    },
    diaProfileStatus: async () => ({ enabled: false, available: true, profileName: 'Default' }),
    selectPageContext: async () => null,
    onState: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
  }
  window.manorDesktop = { browser }
})()
