import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { expect, it } from 'vitest'
import { PanelsPage } from '../src/components/settings/PanelsPage'

it('shows the server refusing a Browser or Simulator save', () => {
  const text = 'Restart Manor to save this setting. The running server does not know it yet.'
  let page!: ReactTestRenderer
  act(() => {
    page = create(
      <PanelsPage
        settings={null}
        simulator={null}
        connected
        notice={{ kind: 'error', text }}
        onSave={() => true}
        onSimulatorAction={() => true}
        onDismissNotice={() => undefined}
      />,
    )
  })
  expect(JSON.stringify(page.toJSON())).toContain(text)
})
