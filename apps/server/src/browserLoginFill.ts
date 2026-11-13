import { z } from 'zod'
import type { BrowserActor, BrowserBroker } from './browserBroker.js'
import { EffectDeclinedError, type EffectBroker } from './effectBroker.js'
import { BROWSER_FILL_LOGIN_TOOL } from './effectPolicy.js'
import { BUILT_IN_BROWSER_MCP_NAME } from './mcp/browserAttachment.js'
import type { SecretPage } from './secretRequests.js'

/**
 * What the agent hears back: the site, the username and what happened. The password
 * never reaches this process, because the desktop host keeps it to itself.
 */
export type LoginFillResult =
  | { status: 'filled' | 'declined'; site: string; username: string }
  | { status: 'no_saved_login'; site: string; next: string }

const Lookup = z.object({
  tabId: z.string(),
  pageId: z.number(),
  origin: z.string().url(),
  login: z.object({ id: z.string(), username: z.string() }).optional(),
  passwordField: z.boolean(),
})
const Filled = z.object({ username: z.string() })

export interface LoginFillContext {
  chatId: string
  /** The broker session driven; see `BrowserCapabilities`. */
  sessionId: string
  actor: BrowserActor
  turnId: string
  canApprove: boolean
}

/**
 * The password step a secret card will fill, bound now so the card can name its site.
 * The value goes to this tab, page and exact origin or nowhere; the desktop checks them
 * again at the fill, the way it does for a saved login.
 */
export async function secretPasswordPage(
  broker: Pick<BrowserBroker, 'isReady' | 'session'>,
  turn: { sessionId: string; actor: BrowserActor; turnId: string; canApprove: boolean; canFillLogin: boolean } | undefined,
): Promise<SecretPage> {
  if (turn === undefined || !turn.canApprove || !turn.canFillLogin) {
    throw new Error('This turn has no browser to fill. Open the password step first, or use target command.')
  }
  if (!broker.isReady()) throw new Error('Filling a password field needs the Manor desktop app, which is not connected.')
  const actor = { ...turn.actor, turnId: turn.turnId }
  const lookup = Lookup.parse(await broker.session(turn.sessionId, actor, (browser) =>
    browser.dispatch(BROWSER_FILL_LOGIN_TOOL, { step: 'probe' })))
  const site = new URL(lookup.origin).host
  if (!lookup.passwordField) {
    throw new Error(`The open page on ${site} has no password field. Go to the password step, then call request_secret again.`)
  }
  const { tabId, pageId, origin } = lookup
  return {
    site,
    fill: async (value) => {
      await broker.session(turn.sessionId, actor, (browser) =>
        browser.dispatch(BROWSER_FILL_LOGIN_TOOL, { step: 'fill_secret', tabId, pageId, origin, value }))
    },
  }
}

/**
 * An agent asks to fill a login Manor has saved for the page it is on. The user's click
 * on the card is the fill; the desktop then insists on the tab and exact origin the
 * card named and on a real password field. The agent's `username` only picks among
 * several saved logins for that origin.
 */
export async function fillSavedLogin(
  { broker, effects }: { broker: Pick<BrowserBroker, 'isReady' | 'session'>; effects: Pick<EffectBroker, 'authorize'> },
  context: LoginFillContext,
  username: string | undefined,
): Promise<LoginFillResult> {
  if (!context.canApprove) {
    throw new Error('browser_fill_login was refused: this unattended turn has nobody to approve a sign-in. Ask the user to sign in themselves.')
  }
  if (!broker.isReady()) throw new Error('Filling a saved login needs the Manor desktop app, which is not connected.')
  return broker.session(context.sessionId, { ...context.actor, turnId: context.turnId }, async (browser) => {
    const lookup = Lookup.parse(await browser.dispatch(BROWSER_FILL_LOGIN_TOOL, {
      step: 'lookup',
      ...(username === undefined ? {} : { username }),
    }))
    const site = new URL(lookup.origin).host
    const login = lookup.login
    if (login === undefined) {
      return {
        status: 'no_saved_login',
        site,
        next: 'Ask the user to sign in themselves. Manor offers to save the login once they have.',
      }
    }
    if (!lookup.passwordField) {
      throw new Error(`This page has no password field to fill. The saved username for ${site} is ${login.username}: enter it, continue to the password step, then call browser_fill_login again.`)
    }
    try {
      await effects.authorize({
        chatId: context.chatId,
        agentId: context.actor.id,
        turnId: context.turnId,
        canApprove: context.canApprove,
        connector: { id: 'builtin_browser', name: BUILT_IN_BROWSER_MCP_NAME },
        tool: BROWSER_FILL_LOGIN_TOOL,
        effect: 'confirm_write',
        reviewArguments: { origin: lookup.origin, username: login.username },
      }, { waitForHuman: (ask) => browser.waitForHuman(ask, { samePage: false }) })
    } catch (error: unknown) {
      if (error instanceof EffectDeclinedError) return { status: 'declined', site, username: login.username }
      throw error
    }
    const filled = Filled.parse(await browser.dispatch(BROWSER_FILL_LOGIN_TOOL, {
      step: 'fill',
      tabId: lookup.tabId,
      pageId: lookup.pageId,
      origin: lookup.origin,
      loginId: login.id,
    }))
    return { status: 'filled', site, username: filled.username }
  })
}
