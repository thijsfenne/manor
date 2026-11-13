import type { UserInputQuestion } from '@manor/contracts'
import { describe, expect, it, vi } from 'vitest'
import { BrowserBroker } from '../src/browserBroker.js'
import { fillSavedLogin } from '../src/browserLoginFill.js'
import { EffectBroker } from '../src/effectBroker.js'

const PASSWORD = 'correct-horse-battery-staple'
const context = {
  chatId: 'chat_1',
  sessionId: 'chat_1',
  actor: { id: 'sage', name: 'Sage' },
  turnId: 'turn_1',
  canApprove: true,
}

/**
 * A desktop host that answers the two steps of a fill. Its answers carry a stray
 * password on purpose: whatever a host sends, the agent's result must not repeat it.
 */
function desktop(broker: BrowserBroker, lookup: Record<string, unknown>, fill: () => Record<string, unknown> = () => ({ username: 'sam', password: PASSWORD })) {
  const steps: Array<Record<string, unknown>> = []
  broker.register({
    send(payload) {
      const message = JSON.parse(payload) as { requestId: string; arguments: Record<string, unknown> }
      steps.push(message.arguments)
      queueMicrotask(() => {
        try {
          const result = message.arguments.step === 'lookup' ? lookup : fill()
          broker.settle(this, { requestId: message.requestId, ok: true, result })
        } catch (error: unknown) {
          broker.settle(this, { requestId: message.requestId, ok: false, error: (error as Error).message })
        }
      })
    },
  })
  return steps
}

const savedLogin = {
  tabId: 'tab_1',
  pageId: 7,
  origin: 'https://github.com',
  login: { id: 'login_1', username: 'sam', password: PASSWORD },
  passwordField: true,
  password: PASSWORD,
}

function card(answer: string) {
  const asked: UserInputQuestion[][] = []
  const effects = new EffectBroker({
    request: vi.fn(async (_context, questions: UserInputQuestion[]) => {
      asked.push(questions)
      return { allow_effect: answer }
    }),
  })
  return { effects, asked }
}

describe('fillSavedLogin', () => {
  it('fills after Fill on the card, and tells the agent only the site and username', async () => {
    const broker = new BrowserBroker()
    const steps = desktop(broker, savedLogin)
    const { effects, asked } = card('Fill')

    const result = await fillSavedLogin({ broker, effects }, context, undefined)

    expect(result).toEqual({ status: 'filled', site: 'github.com', username: 'sam' })
    expect(JSON.stringify(result)).not.toContain(PASSWORD)
    expect(asked).toEqual([[expect.objectContaining({
      question: 'Sign in to github.com as sam?',
      optionsOnly: true,
      desktopOnly: true,
      options: [expect.objectContaining({ label: 'Fill' }), expect.objectContaining({ label: "Don't fill" })],
    })]])
    expect(JSON.stringify(asked)).not.toContain(PASSWORD)
    // The fill is bound to the tab and origin the card named.
    expect(steps).toEqual([{ step: 'lookup' }, { step: 'fill', tabId: 'tab_1', pageId: 7, origin: 'https://github.com', loginId: 'login_1' }])
  })

  it('reports a decline without filling', async () => {
    const broker = new BrowserBroker()
    const steps = desktop(broker, savedLogin)
    const { effects } = card("Don't fill")

    const result = await fillSavedLogin({ broker, effects }, context, 'sam')

    expect(result).toEqual({ status: 'declined', site: 'github.com', username: 'sam' })
    expect(steps).toEqual([{ step: 'lookup', username: 'sam' }])
  })

  it('says there is no saved login without raising a card', async () => {
    const broker = new BrowserBroker()
    desktop(broker, { tabId: 'tab_1', pageId: 7, origin: 'https://example.com', passwordField: true })
    const { effects, asked } = card('Fill')

    const result = await fillSavedLogin({ broker, effects }, context, undefined)

    expect(result).toMatchObject({ status: 'no_saved_login', site: 'example.com' })
    expect(asked).toEqual([])
  })

  it('passes on the refusal when the page moved to another origin before the click', async () => {
    const broker = new BrowserBroker()
    desktop(broker, savedLogin, () => {
      throw new Error('The page moved from github.com to phish.test before Fill was clicked, so nothing was filled.')
    })
    const { effects } = card('Fill')

    await expect(fillSavedLogin({ broker, effects }, context, undefined)).rejects.toThrow(/moved from github.com to phish.test/)
  })

  it('refuses an unattended turn before the desktop or a card is asked', async () => {
    const broker = new BrowserBroker()
    const steps = desktop(broker, savedLogin)
    const { effects, asked } = card('Fill')

    await expect(fillSavedLogin({ broker, effects }, { ...context, canApprove: false }, undefined)).rejects.toThrow(/unattended turn/)
    expect(steps).toEqual([])
    expect(asked).toEqual([])
  })

  it('fails with one sentence when the desktop app is not connected', async () => {
    const { effects } = card('Fill')
    await expect(fillSavedLogin({ broker: new BrowserBroker(), effects }, context, undefined))
      .rejects.toThrow('Filling a saved login needs the Manor desktop app, which is not connected.')
  })
})
