/**
 * The one main-to-renderer push channel the browser has. The preload cannot import
 * this — a sandboxed preload's `require` has no sibling modules — so it writes the
 * same literal out and `smoke:preload` proves the two still agree.
 */
export const BROWSER_STATE_CHANNEL = 'manor:browser:state'
export const BROWSER_PREVIEW_CHANNEL = 'manor:browser:preview'
export const BROWSER_SHORTCUT_CHANNEL = 'manor:browser:shortcut'
/** A Manor key typed in a focused web page; the preload replays it as a keydown on `window`. */
export const HOUSE_KEY_CHANNEL = 'manor:house-key'
/** From the guest preload: a page-first key the page left alone. Copied into `browserGuestPreload.ts`. */
export const GUEST_UNHANDLED_KEY_CHANNEL = 'manor:browser:unhandled-key'
