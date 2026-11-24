import { DEFAULT_HOUSE_SETTINGS, type ProviderConnection, type SystemInfo } from '@manor/contracts'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { dailyLogWriter, MemoryPage } from '../src/components/settings/SystemPages'

// The shared picker needs a DOM this suite does not have; what matters here is what the row hands it.
vi.mock('../src/components/SideRuntimeMenu', () => ({
  SideRuntimeMenu: ({ model, effort, defaults, onChange }: { model: string; effort: string; defaults: { model: string; effort: string }; onChange: (model: string, effort: string) => void }) => (
    <button data-defaults={`${defaults.model} ${defaults.effort}`} onClick={() => onChange('gpt-6-luna', 'high')}>{`${model} ${effort}`}</button>
  ),
}))

const info = (memory: Partial<SystemInfo['memory']> = {}, vault: Partial<SystemInfo['vault']> = {}): SystemInfo => ({
  version: '0.0.1', commit: null, startedAt: '2026-11-10T00:00:00.000Z', providers: [], logs: [],
  memory: { path: '/Users/someone/.manor/memory', pinned: false, pending: null, ...memory },
  vault: { path: '/Users/someone/.manor/knowledge', pinned: false, pending: null, ...vault },
  canKeepAwake: false,
})
const row = (provider: ProviderConnection['provider'], state: ProviderConnection['state']): ProviderConnection =>
  ({ provider, installed: state !== 'install', version: '1.0.0', signedIn: state === 'ready', state, canSignIn: true, canInstall: false })

const text = (page: ReactTestRenderer) => JSON.stringify(page.toJSON())
const button = (page: ReactTestRenderer, label: string, at = 0) =>
  page.root.findAll((node) => node.type === 'button' && node.children.join('') === label)[at]!

async function render(props: Partial<Parameters<typeof MemoryPage>[0]> = {}) {
  const onSave = vi.fn()
  const onReveal = vi.fn()
  const onRequest = vi.fn()
  let page!: ReactTestRenderer
  await act(async () => {
    page = create(
      <MemoryPage
        info={info()}
        settings={DEFAULT_HOUSE_SETTINGS}
        connections={[row('claude', 'sign_in'), row('codex', 'ready')]}
        onRequest={onRequest}
        onCheck={() => true}
        onSave={onSave}
        onReveal={onReveal}
        {...props}
      />,
    )
  })
  return { page, onSave, onReveal, onRequest }
}

afterEach(() => { vi.unstubAllGlobals() })

it('moves a folder through the Finder sheet, shows it in Finder and says who writes the log', async () => {
  vi.stubGlobal('window', { manorDesktop: { chooseFolder: () => Promise.resolve('/Users/someone/Notes') } })
  const { page, onSave, onReveal, onRequest } = await render()

  expect(text(page)).toContain('/Users/someone/.manor/memory')
  expect(text(page)).toContain('Runs on ')
  expect(text(page)).toContain('Codex')

  await act(async () => { button(page, 'Choose…', 1).props.onClick() })
  expect(onSave).toHaveBeenCalledWith({ ...DEFAULT_HOUSE_SETTINGS, knowledgeDir: '/Users/someone/Notes' })
  // Asked on the way in and again after the move, for what the next start will use.
  expect(onRequest).toHaveBeenCalledTimes(2)

  await act(async () => { button(page, 'Show in Finder', 0).props.onClick() })
  expect(onReveal).toHaveBeenCalledWith('memory')
  // The real action answers whether it was sent; leaving the page must survive that.
  await act(async () => { page.unmount() })
})

it('takes a typed path where there is no Finder sheet', async () => {
  vi.stubGlobal('window', {})
  const { page, onSave } = await render()
  await act(async () => { button(page, 'Choose…', 0).props.onClick() })
  const field = page.root.findByType('input')
  await act(async () => { field.props.onChange({ target: { value: ' ~/Notes ' } }) })
  await act(async () => { button(page, 'Save').props.onClick() })
  expect(onSave).toHaveBeenCalledWith({ ...DEFAULT_HOUSE_SETTINGS, memoryDir: '~/Notes' })
  expect(page.root.findAllByType('input')).toHaveLength(0)
})

it('has one Note AI model row under Knowledge, on Sonnet 5.5 at medium until another is picked', async () => {
  vi.stubGlobal('window', {})
  const { page, onSave } = await render()
  expect(text(page)).toContain('Note AI model')
  const menu = button(page, 'claude-sonnet-5-5 medium')
  expect(menu.props['data-defaults']).toBe('claude-sonnet-5-5 medium')
  await act(async () => { menu.props.onClick() })
  expect(onSave).toHaveBeenCalledWith({ ...DEFAULT_HOUSE_SETTINGS, noteAiModel: 'gpt-6-luna', noteAiEffort: 'high' })
})

it('says when a move waits for a restart, and lets it be taken back', async () => {
  const { page, onSave } = await render({
    info: info({ pending: '/Users/someone/Notes' }),
    settings: { ...DEFAULT_HOUSE_SETTINGS, memoryDir: '/Users/someone/Notes' },
  })
  expect(text(page)).toContain('the next time Manor starts')
  await act(async () => { button(page, 'Keep the current folder').props.onClick() })
  expect(onSave).toHaveBeenCalledWith({ ...DEFAULT_HOUSE_SETTINGS, memoryDir: '/Users/someone/.manor/memory' })
})

it('offers no move for a folder the environment decides, and says so when nobody can write', async () => {
  const { page } = await render({
    info: info({ pinned: true, path: '/Users/someone/Notes' }),
    connections: [row('claude', 'sign_in'), row('codex', 'install')],
  })
  expect(text(page)).toContain('Set by MANOR_MEMORY_DIR')
  expect(page.root.findAll((node) => node.type === 'button' && node.children.join('') === 'Choose…')).toHaveLength(1)
  expect(text(page)).toContain('No provider is signed in')
})

it('names no writer before the providers were asked', () => {
  expect(dailyLogWriter([])).toBeUndefined()
  expect(dailyLogWriter([row('claude', 'install'), row('grok', 'attention')])?.provider).toBe('grok')
  expect(dailyLogWriter([row('claude', 'signing_in')])).toBeNull()
})

it('names the file that sets a pinned folder, with the home folder as ~, or the launch environment', async () => {
  const { page } = await render({ info: info({ pinned: true, pinnedIn: '/Users/someone/.manor/.env' }) })
  expect(text(page)).toContain('Set by MANOR_MEMORY_DIR in ~/.manor/.env.')
  expect(text(page)).not.toContain('apps/server')
  await act(async () => { page.unmount() })

  // No file set it: the variable was already there when Manor started.
  const launched = await render({ info: info({ pinned: true }) })
  expect(text(launched.page)).toContain('Set by MANOR_MEMORY_DIR in the environment Manor started with.')
  await act(async () => { launched.page.unmount() })
})
