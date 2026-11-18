import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { CATALOG_DRIVERS, DEFAULT_HOUSE_SETTINGS, MODELS, type ProviderConnection } from '@manor/contracts'
import { ModelsPage } from './ModelsPage'

const page = (disabledModels: string[], connections: ProviderConnection[] = []) => renderToStaticMarkup(
  <ModelsPage
    settings={{ ...DEFAULT_HOUSE_SETTINGS, disabledModels }}
    connections={connections}
    notice={null}
    onCheck={() => {}}
    onSave={() => true}
    onDismissNotice={() => {}}
  />,
)

describe('Settings, Models', () => {
  it('keeps a provider that is not signed in, muted with the reason', () => {
    const grok: ProviderConnection = { provider: 'grok', installed: true, version: '1', signedIn: false, state: 'sign_in', canSignIn: true, canInstall: false }
    const html = page([], [grok])
    expect(html).toContain('Not signed in')
    expect(html).toContain('Grok 4.7')
  })

  it('will not turn the last model off', () => {
    const all = CATALOG_DRIVERS.flatMap((driver) => MODELS[driver].map((option) => option.value))
    const html = page(all.filter((model) => model !== 'grok-4.7'))
    expect(html).toContain('The last model on stays on.')
    expect(html).toMatch(/aria-label="Grok 4.7"[^>]*disabled/)
  })
})
