import { ipcRenderer } from 'electron'

/**
 * Runs in every browser guest's main frame, in its own isolated world, so the page
 * never sees it. It reports logins the user submits, fills one they picked in Manor's
 * chrome or approved on an agent's card, and hands back the page-first shortcuts
 * the page did not use. The main process decides which site a login belongs to and whether a key counts.
 *
 * A sandboxed preload cannot import a sibling module, so the channel names are
 * copied from `browserPasswordAutofill.ts` and `browserChannels.ts`, and the keys
 * from `PAGE_FIRST_KEYS` in `browserShortcuts.ts`.
 */
const CAPTURE_CHANNEL = 'manor:browser-password:capture'
const FILL_CHANNEL = 'manor:browser-password:fill'
const FILLED_CHANNEL = 'manor:browser-password:filled'
const UNHANDLED_KEY_CHANNEL = 'manor:browser:unhandled-key'
const PAGE_FIRST_KEYS = ['f', 'k', 'b', 's', ';']

const USERNAME_SELECTOR = [
  'input[autocomplete~="username"]',
  'input[type="email"]',
  'input[type="text"]',
  'input[type="tel"]',
  'input:not([type])',
].join(',')
const USERNAME_NAME = /user|email|login|identifier|account/i
/** What a formless sign-in button says, for the custom-button logins some sites build without a form. */
const SIGN_IN_LABEL = /\b(sign|log)[\s-]?in\b|\blogin\b|\bnext\b|\binloggen\b|\baanmelden\b|\bvolgende\b/i
const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set

/** A submitted form, or the inputs outside every form for a formless login. */
type Scope = HTMLFormElement | null

/** Laid out and seen: a hidden or transparent decoy field is never filled or read. */
function visible(input: HTMLInputElement): boolean {
  return !input.disabled && input.getClientRects().length > 0 &&
    input.checkVisibility({ opacityProperty: true, visibilityProperty: true })
}

/** A form's own controls, including `form="…"` ones outside it, or every input no form owns. */
function inputs(selector: string, scope: Scope): HTMLInputElement[] {
  const found = scope === null
    ? [...document.querySelectorAll<HTMLInputElement>(selector)].filter((input) => input.form === null)
    : [...scope.elements].filter((element): element is HTMLInputElement =>
      element instanceof HTMLInputElement && element.matches(selector))
  return found.filter(visible)
}

function passwordFields(scope: Scope): HTMLInputElement[] {
  return inputs('input[type="password"]', scope)
}

function looksLikeUsername(input: HTMLInputElement): boolean {
  return /\busername\b/.test(input.autocomplete) || input.type === 'email' ||
    USERNAME_NAME.test(`${input.name} ${input.id}`)
}

/** The field before the password in its scope, or a lone username step of a two-page login. */
function usernameFor(password: HTMLInputElement | null, scope: Scope): HTMLInputElement | null {
  const candidates = inputs(USERNAME_SELECTOR, scope)
  const explicit = candidates.find((input) => /\busername\b/.test(input.autocomplete))
  if (explicit !== undefined) return explicit
  if (password === null) return candidates.find(looksLikeUsername) ?? null
  const before = candidates.filter((input) =>
    (input.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)
  return before.at(-1) ?? null
}

/** Reports what the submitted scope holds; the main process decides whether it is worth an offer. */
function capture(scope: Scope): void {
  const fields = passwordFields(scope).filter((field) => field.value !== '')
  const password = fields.find((field) => field.autocomplete === 'new-password') ?? fields[0]
  if (password !== undefined) {
    ipcRenderer.send(CAPTURE_CHANNEL, { kind: 'login', username: usernameFor(password, scope)?.value ?? '', password: password.value })
    return
  }
  const username = usernameFor(null, scope)
  if (username !== null && username.value.trim() !== '') ipcRenderer.send(CAPTURE_CHANNEL, { kind: 'username', username: username.value })
}

/**
 * A custom sign-in button of a login no form owns. A form's own buttons never count:
 * its login is reported by the submit event, which fires only once validation passed.
 */
function formlessSignIn(control: Element): boolean {
  const native = control instanceof HTMLButtonElement || control instanceof HTMLInputElement ? control : null
  if (native?.form != null || control.closest('form') !== null) return false
  const label = `${control.getAttribute('aria-label') ?? ''} ${control.textContent ?? ''} ${native instanceof HTMLInputElement ? native.value : ''}`
  return SIGN_IN_LABEL.test(label)
}

/** The username field of a page that asks for it alone, the first step of a two-page login. */
function loneUsername(): HTMLInputElement | null {
  const candidates = [...document.querySelectorAll<HTMLInputElement>(USERNAME_SELECTOR)].filter(visible)
  return candidates.find((input) => /\busername\b/.test(input.autocomplete)) ?? candidates.find(looksLikeUsername) ?? null
}

function fill(input: HTMLInputElement, value: string): void {
  input.focus()
  insert(input, value)
}

/** Sets the value the way typing would, so the page's own listeners hear it. */
function insert(input: HTMLInputElement, value: string): void {
  valueSetter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

document.addEventListener('submit', (event) => {
  if (event.target instanceof HTMLFormElement) capture(event.target)
}, true)
// Formless logins have no submit event, so Enter and their sign-in button stand in for it.
document.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && event.target instanceof HTMLInputElement && event.target.form === null) capture(null)
}, true)
document.addEventListener('click', (event) => {
  const control = event.target instanceof Element
    ? event.target.closest('button, input[type="submit"], input[type="image"], [role="button"]')
    : null
  if (control !== null && formlessSignIn(control)) capture(null)
}, true)

// ⌘F, ⌘K and the like belong to the page first, as in Chrome. Read after dispatch, so
// every page listener has had its chance to claim the key with preventDefault.
window.addEventListener('keydown', (event) => {
  // Only a key the user typed: a page dispatching its own KeyboardEvent never reaches Manor.
  if (!event.isTrusted || !event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat) return
  if (!PAGE_FIRST_KEYS.includes(event.key.toLowerCase())) return
  setTimeout(() => {
    if (!event.defaultPrevented) ipcRenderer.send(UNHANDLED_KEY_CHANNEL, event.key.toLowerCase())
  }, 0)
}, true)

/**
 * A password an agent asked for is filled for the page, not for the agent's eyes: when
 * the page later turns the field into plain text (a show-password eye) while it still
 * holds that password, the value is cleared, so a screenshot cannot read it.
 */
function hideFromReveal(field: HTMLInputElement, password: string): void {
  const observer = new MutationObserver(() => {
    if (field.type === 'password' || !field.value.includes(password)) return
    observer.disconnect()
    insert(field, '')
  })
  observer.observe(field, { attributes: true, attributeFilter: ['type'] })
}

/**
 * An agent's fill: a real password field or nothing. The page's own focus and input
 * handlers run inside the fill, so the field's type is checked again after focusing it
 * and after inserting the password; a field that turned to text is emptied.
 */
function fillForAgent(passwordField: HTMLInputElement | null, username: string, password: string): boolean {
  if (passwordField === null || passwordField.type !== 'password') return false
  const usernameField = usernameFor(passwordField, passwordField.form)
  if (usernameField !== null && username !== '') fill(usernameField, username)
  passwordField.focus()
  if (passwordField.type !== 'password' || !passwordField.isConnected || !visible(passwordField)) return false
  hideFromReveal(passwordField, password)
  // Focused and checked above; focusing again would run the page's focus handlers after the check.
  insert(passwordField, password)
  if (passwordField.type === 'password') return true
  insert(passwordField, '')
  return false
}

ipcRenderer.on(FILL_CHANNEL, (_event, request: unknown) => {
  if (typeof request !== 'object' || request === null) return
  const { username, password, requestId, probe, agent } = request as Record<string, unknown>
  const passwordField = [...document.querySelectorAll<HTMLInputElement>('input[type="password"]')].find(visible) ?? null
  // An agent's request is answered either way; the user's own key fill is not.
  const answer = (filled: boolean) => {
    if (typeof requestId === 'string') ipcRenderer.send(FILLED_CHANNEL, { requestId, filled })
  }
  if (probe === true) {
    answer(passwordField !== null)
    return
  }
  if (typeof username !== 'string' || typeof password !== 'string') return answer(false)
  if (agent === true) return answer(fillForAgent(passwordField, username, password))
  // The user's own key may fill a lone username step too.
  const usernameField = passwordField === null ? loneUsername() : usernameFor(passwordField, passwordField.form)
  if (usernameField !== null && username !== '') fill(usernameField, username)
  if (passwordField !== null) fill(passwordField, password)
})
