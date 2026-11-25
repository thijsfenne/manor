import type { PhoneAccess } from '@manor/contracts'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it, vi } from 'vitest'
import { PhonePage } from '../src/components/settings/PhonePage'

// The page asks again whenever the window comes back to the front.
vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined })

const ACCESS: PhoneAccess = { tailscale: { state: 'checking' }, devices: [] }

function render(access: PhoneAccess | null, account?: { onForget: () => void }) {
  let page!: ReactTestRenderer
  act(() => {
    page = create(
      <PhonePage
        access={access}
        pairingLink={null}
        {...(account === undefined ? {} : { account })}
        notice={null}
        requestEvents={{ subscribe: () => () => {} }}
        onRequest={() => undefined}
        onSetServing={() => true}
        onCreateLink={() => true}
        onRevoke={() => true}
        onDismissNotice={() => undefined}
      />,
    )
  })
  return page
}

const forgetButton = (page: ReactTestRenderer) =>
  page.root.findAllByType('button').find((node) => node.children.includes('Forget this Mac'))

it('offers Forget this Mac in a paired browser, before and after the Mac answers', () => {
  const onForget = vi.fn()
  expect(forgetButton(render(null, { onForget }))).toBeDefined()
  const page = render(ACCESS, { onForget })
  act(() => forgetButton(page)!.props.onClick())
  expect(onForget).toHaveBeenCalledTimes(1)
})

it('has no Forget this Mac where nobody signs in', () => {
  expect(forgetButton(render(null))).toBeUndefined()
  expect(forgetButton(render(ACCESS))).toBeUndefined()
})
