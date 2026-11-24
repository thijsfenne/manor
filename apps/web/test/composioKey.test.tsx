import type { ReactNode } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ConnectorsView } from '../src/components/connectors/ConnectorsView'
import type { ComposioBinding } from '../src/components/connectors/composioCatalogue'
import type { RequestEvents, RequestResponse } from '../src/useRequest'

vi.mock('../src/components/Modal', () => ({
  Modal: ({ title, children }: { title: string; children: ReactNode }) => <section aria-label={title}>{children}</section>,
  ModalFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
}))
vi.mock('../src/components/ui/Select', () => ({ Select: () => null }))

const text = (node: ReactTestInstance): string =>
  node.children.map((child) => typeof child === 'string' ? child : text(child)).join('')

function renderPage(binding: Partial<ComposioBinding>, envFile?: string) {
  const listeners = new Set<(response: RequestResponse) => void>()
  const requestEvents: RequestEvents = { subscribe: (next) => { listeners.add(next); return () => { listeners.delete(next) } } }
  const composio: ComposioBinding = {
    catalog: null, accounts: null, key: 'none',
    list: vi.fn(() => true), connect: () => true, disconnect: () => true, setKey: vi.fn(() => true), removeKey: vi.fn(() => true),
    ...binding,
  }
  let view!: ReactTestRenderer
  const page = (next: ComposioBinding) => (
      <ConnectorsView
        requestEvents={requestEvents}
        agents={[]}
        registry={[]}
        hostStatuses={[]}
        mymind={null}
        notice={null}
        onSave={() => true}
        onVerify={() => true}
        onVerifyMyMind={() => true}
        onDelete={() => true}
        onDismissNotice={() => undefined}
        onDialogChange={() => undefined}
        live
        composio={next}
        envFile={envFile}
      />
  )
  act(() => { view = create(page(composio)) })
  return {
    view,
    composio,
    answer: (response: RequestResponse) => act(() => { for (const listener of listeners) listener(response) }),
    rerender: (change: Partial<ComposioBinding>) => act(() => view.update(page({ ...composio, ...change }))),
  }
}

describe('the Composio key on the Connectors page', () => {
  let view: ReactTestRenderer | undefined
  afterEach(() => act(() => view?.unmount()))

  it('leads the page with the setup card, and does not ask for a catalogue', () => {
    const page = renderPage({ accounts: { connected: [], connects: [], unavailable: 'The Composio API key is missing on this Manor host.' } })
    view = page.view
    const all = text(view.root)
    const card = view.root.findByProps({ 'aria-labelledby': 'composio-setup-title' })
    // The card comes before the search field and every connector row.
    expect(all.indexOf('Connect your apps')).toBeLessThan(all.indexOf('Connected'))
    expect(text(card)).toContain('Manor needs a Composio API key to do that, and creating one is free.')
    expect(text(card)).toContain('1. Get a key')
    expect(text(card)).toContain('2. Paste it here')
    expect(card.findAll((node) => node.type === 'img' && node.props.src?.includes('logos.composio.dev'))).toHaveLength(8)
    expect(card.findByProps({ href: 'https://dashboard.composio.dev/~/project/settings/api-keys' }).props.target).toBe('_blank')
    expect(card.findAll((node) => node.type === 'input' && node.props.type === 'password')).toHaveLength(1)
    expect(all).toContain('The app catalogue appears here once the key is saved.')
    expect(all).not.toContain('missing on this Manor host')
    expect(all).not.toContain('Composio accounts:')
    expect(all).not.toContain('Loading the Composio catalogue')
    expect(page.composio.list).not.toHaveBeenCalled()
  })

  it('has no setup card once a key is there', () => {
    view = renderPage({ key: 'manor' }).view
    expect(view.root.findAll((node) => node.props['aria-labelledby'] === 'composio-setup-title')).toHaveLength(0)
    expect(text(view.root)).not.toContain('Connect your apps')
  })

  it('sends the key once on Save, then shows Composio\'s refusal', () => {
    const page = renderPage({})
    view = page.view
    const input = view.root.find((node) => node.type === 'input' && node.props.type === 'password')
    act(() => input.props.onChange({ target: { value: 'ak_test_value_123' } }))
    act(() => view!.root.findByType('form' as never).props.onSubmit({ preventDefault: () => undefined }))
    expect(page.composio.setKey).toHaveBeenCalledTimes(1)
    const [sent, requestId] = vi.mocked(page.composio.setKey).mock.calls[0]!
    expect(sent).toBe('ak_test_value_123')
    expect(text(view.root)).toContain('Checking…')
    page.answer({ type: 'notice', kind: 'error', text: 'Composio did not accept this key. Check that you copied the whole project API key.', requestId })
    expect(text(view.root)).toContain('Composio did not accept this key.')
    expect(text(view.root)).toContain('Save')
  })

  it('shows under the catalogue that a saved key did not start Composio', () => {
    const page = renderPage({})
    view = page.view
    const input = view.root.find((node) => node.type === 'input' && node.props.type === 'password')
    act(() => input.props.onChange({ target: { value: 'ak_test_value_123' } }))
    act(() => view!.root.findByType('form' as never).props.onSubmit({ preventDefault: () => undefined }))
    const [, requestId] = vi.mocked(page.composio.setKey).mock.calls[0]!
    page.rerender({ key: 'manor' })
    const notice = 'The key is saved, but Composio did not start. Press Test on the Composio row, or try again later.'
    page.answer({ type: 'notice', kind: 'info', text: notice, requestId })
    expect(text(view.root)).toContain('The Composio key is saved in Manor’s data folder.')
    expect(text(view.root)).toContain(notice)
  })

  it('shows where an outside key is set, with no form and no way to remove it', () => {
    const page = renderPage({ key: 'checkout' }, '/Users/anna/.manor/.env')
    view = page.view
    const all = text(view.root)
    expect(all).toContain('The Composio key is set outside Manor, in ~/.manor/.env. Change it there.')
    expect(view.root.findAll((node) => node.type === 'input' && node.props.type === 'password')).toHaveLength(0)
    expect(all).not.toContain('Remove key')
    expect(page.composio.list).toHaveBeenCalled()
  })

  it('falls back to a plain name when an older server does not report its env file', () => {
    view = renderPage({ key: 'checkout' }).view
    expect(text(view.root)).toContain('The Composio key is set outside Manor, in the server’s .env file. Change it there.')
  })

  it('offers Remove key for Manor\'s own key, behind a confirm that keeps the Composio accounts', () => {
    const page = renderPage({ key: 'manor' })
    view = page.view
    act(() => view!.root.find((node) => node.type === 'button' && text(node) === 'Remove key').props.onClick())
    expect(text(view.root)).toContain('Chats that are running keep access until they finish.')
    expect(text(view.root)).toContain('nothing is disconnected there')
    const confirm = view.root.findAll((node) => node.type === 'button' && text(node) === 'Remove key').at(-1)!
    act(() => confirm.props.onClick())
    expect(page.composio.removeKey).toHaveBeenCalledTimes(1)
  })
})
