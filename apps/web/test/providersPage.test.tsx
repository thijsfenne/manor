import type { ProviderConnection, SystemInfo } from '@manor/contracts'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { ProvidersPage } from '../src/components/settings/SystemPages'

const info: SystemInfo = {
  version: '0.0.1', commit: null, startedAt: '2026-11-10T00:00:00.000Z',
  providers: [
    { driver: 'claude', command: 'claude', version: '2.1.0' },
    { driver: 'codex', command: 'codex', version: '0.167.0' },
    { driver: 'grok', command: 'grok', version: null },
    { driver: 'cursor', command: 'cursor-agent', version: '2026.11.05' },
  ],
  memory: { path: null, pinned: false, pending: null }, vault: { path: null, pinned: false, pending: null }, logs: [],
  canKeepAwake: false,
}
const row = (provider: ProviderConnection['provider'], rest: Partial<ProviderConnection>): ProviderConnection =>
  ({ provider, installed: true, version: '1.0.0', signedIn: null, state: 'ready', canSignIn: true, canInstall: false, ...rest })

it('words each provider state and offers the one action that fits it', async () => {
  // The real action answers whether it was sent; leaving the page must survive that.
  const onCheck = vi.fn(() => true)
  const onSignIn = vi.fn()
  const onCancelSignIn = vi.fn()
  const onInstall = vi.fn()
  let page!: ReactTestRenderer
  await act(async () => {
    page = create(
      <ProvidersPage
        info={info}
        updates={[]}
        connections={[
          row('claude', { state: 'ready', signedIn: true, plan: 'max', account: 'someone@example.invalid' }),
          row('codex', { state: 'sign_in', signedIn: false, message: 'Sign in did not finish. Try again.' }),
          row('grok', { state: 'install', installed: false, version: null, canSignIn: false }),
          row('cursor', { state: 'signing_in', signedIn: false }),
        ]}
        onRequest={() => undefined}
        onUpdate={() => true}
        onCheck={onCheck}
        onSignIn={onSignIn}
        onCancelSignIn={onCancelSignIn}
        onInstall={onInstall}
      />,
    )
  })
  const text = JSON.stringify(page.toJSON())
  const button = (label: string) => page.root.findAllByType('button').find((node) => node.children.join('') === label)

  expect(onCheck).toHaveBeenCalledTimes(1)
  expect(text).toContain('Signed in')
  expect(text).toContain('max')
  expect(text).toContain('Sign in did not finish. Try again.')
  expect(text).toContain('Not installed')
  expect(text).not.toContain('Version unknown')
  expect(text).toContain('Finish in your browser…')

  act(() => button('Sign in')?.props.onClick())
  expect(onSignIn).toHaveBeenCalledWith('codex')
  act(() => button('Cancel')?.props.onClick())
  expect(onCancelSignIn).toHaveBeenCalledWith('cursor')
  expect(() => act(() => page.unmount())).not.toThrow()
})

it('offers the installer where Manor can run one, and shows it running', async () => {
  const onInstall = vi.fn()
  const onCancelSignIn = vi.fn()
  const render = (connections: ProviderConnection[]) => {
    let page!: ReactTestRenderer
    act(() => {
      page = create(
        <ProvidersPage
          info={info} updates={[]} connections={connections}
          onRequest={() => undefined} onUpdate={() => true} onCheck={() => true}
          onSignIn={() => undefined} onCancelSignIn={onCancelSignIn} onInstall={onInstall}
        />,
      )
    })
    return page
  }
  const button = (page: ReactTestRenderer, label: string) =>
    page.root.findAllByType('button').find((node) => node.children.join('') === label)

  const missing = render([
    row('claude', { state: 'install', installed: false, version: null, canSignIn: false, canInstall: true }),
    row('grok', { state: 'install', installed: false, version: null, canSignIn: false }),
  ])
  // Grok has no installer Manor can run, so its row only says it is missing.
  expect(JSON.stringify(missing.toJSON())).toContain('Not installed')
  act(() => button(missing, 'Install')?.props.onClick())
  expect(onInstall).toHaveBeenCalledWith('claude')

  const running = render([row('claude', { state: 'installing', installed: false, version: null, canSignIn: false })])
  expect(JSON.stringify(running.toJSON())).toContain('Installing')
  act(() => button(running, 'Cancel')?.props.onClick())
  expect(onCancelSignIn).toHaveBeenCalledWith('claude')
})

it('says where the keys are kept from the path the server reported', async () => {
  const render = (shown: SystemInfo) => {
    let page!: ReactTestRenderer
    act(() => {
      page = create(
        <ProvidersPage
          info={shown} updates={[]} connections={[]} onRequest={() => undefined} onUpdate={() => true}
          onCheck={() => true} onSignIn={() => undefined} onCancelSignIn={() => undefined} onInstall={() => undefined}
        />,
      )
    })
    return page
  }
  const reported = render({ ...info, envFile: '/Users/someone/.manor/.env' })
  expect(JSON.stringify(reported.toJSON())).toContain('Kept in ~/.manor/.env on the Mac')
  act(() => reported.unmount())
  const older = render(info)
  expect(JSON.stringify(older.toJSON())).toContain('Kept in the server’s .env file on the Mac')
  act(() => older.unmount())
})
