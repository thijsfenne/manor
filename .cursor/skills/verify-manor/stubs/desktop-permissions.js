// Stand-in for the Electron preload's `window.manorDesktop.permissions`, so the headless
// spike can show Settings → Permissions as the desktop app does. Load it with
// `MANOR_VERIFY_INIT_SCRIPT=$PWD/.cursor/skills/verify-manor/stubs/desktop-permissions.js`
// on `launch`. Accessibility starts granted and Screen Recording not granted. Open
// System Settings on a row makes it pending, and that grant arrives four seconds
// later, as when the user switches Manor on in System Settings.
(() => {
  const status = { 'accessibility': 'granted', 'screen-recording': 'not-granted' }
  window.__manorOpenedPanes = []
  const permissions = {
    status: async () => ({ ...status }),
    open: async (id) => {
      window.__manorOpenedPanes.push(id)
      if (status[id] === 'granted') return
      status[id] = 'pending'
      setTimeout(() => { status[id] = 'granted' }, 4_000)
    },
  }
  window.manorDesktop = { ...(window.manorDesktop ?? {}), permissions }
})()
