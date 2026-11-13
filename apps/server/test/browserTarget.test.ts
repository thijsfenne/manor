import { describe, expect, it } from 'vitest'
import { BrowserBroker, type BrowserHostSocket } from '../src/browserBroker.js'
import { browserTabsNote } from '../src/browserTarget.js'

const sage = { id: 'sage', name: 'Sage' }

describe('browserTabsNote', () => {
  it('lists tabs as data without the explicit @browser instructions', async () => {
    const broker = new BrowserBroker()
    const sent: string[] = []
    const desktop: BrowserHostSocket = { send: (payload) => void sent.push(payload) }
    broker.register(desktop)
    const note = browserTabsNote(broker, 'browser:home', sage)
    const { requestId } = JSON.parse(sent[0] ?? '{}') as { requestId: string }
    broker.settle(desktop, {
      requestId, ok: true,
      result: { chatId: 'browser:home', activeTabId: 't1', tabs: [{ id: 't1', title: 'Docs', url: 'https://example.com' }] },
    })
    const text = await note
    expect(text).toContain('https://example.com')
    expect(text).not.toContain('@browser')
  })

  it('is one plain sentence when no desktop is connected', async () => {
    await expect(browserTabsNote(new BrowserBroker(), 'browser:home', sage))
      .resolves.toBe('[Manor] The Manor browser is not reachable right now; answer without it.')
  })
})
