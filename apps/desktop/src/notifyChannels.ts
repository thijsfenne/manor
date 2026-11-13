/**
 * The one main-to-renderer push channel notifications have, held here for the same
 * reason `BROWSER_STATE_CHANNEL` is: the sandboxed preload cannot import a sibling
 * module, so it writes the literal out a second time and `smoke:preload` proves the
 * two still agree. A disagreement here is a notification you can click that does
 * nothing at all.
 */
export const NOTIFY_ACTIVATE_CHANNEL = 'manor:notify:activate'
