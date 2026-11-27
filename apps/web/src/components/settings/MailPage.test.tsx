import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_HOUSE_SETTINGS, type AgentConfig, type Effort, type HouseSettings } from '@manor/contracts'
import { MailPage } from './MailPage'

// The shared picker needs a browser; the page is tested through the props it hands it.
const menu = vi.hoisted(() => ({ props: null as null | { model: string; effort: string; disabled: boolean; defaults?: unknown; onChange: (model: string, effort: Effort) => void } }))
vi.mock('../SideRuntimeMenu', () => ({
  SideRuntimeMenu: (props: NonNullable<typeof menu.props>) => {
    menu.props = props
    return null
  },
}))

const cos = { id: 'chief', name: 'Avery', driver: 'claude', model: 'claude-opus-5-5', effort: 'high', isCos: true } as unknown as AgentConfig

let view: ReactTestRenderer
let saved: HouseSettings[]
const show = (settings: HouseSettings, agents: AgentConfig[] = [cos]) =>
  act(() => { view = create(<MailPage settings={settings} agents={agents} onSave={(next) => { saved.push(next) }} />) })

beforeEach(() => {
  saved = []
  menu.props = null
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})
afterEach(() => {
  act(() => view.unmount())
  vi.unstubAllGlobals()
})

describe('Settings, Mail', () => {
  it('shows the default agent\'s own model until one is picked, and saves a pick', () => {
    show(DEFAULT_HOUSE_SETTINGS)
    expect(menu.props).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', disabled: false, defaults: { model: 'claude-opus-5-5', effort: 'high' } })
    act(() => menu.props!.onChange('claude-sonnet-5-5', 'low'))
    expect(saved.map(({ mailDraftModel, mailDraftEffort }) => [mailDraftModel, mailDraftEffort])).toEqual([['claude-sonnet-5-5', 'low']])
  })

  it('saves null for both when the pick is the default agent\'s own again', () => {
    show({ ...DEFAULT_HOUSE_SETTINGS, mailDraftModel: 'claude-sonnet-5-5', mailDraftEffort: 'low' })
    expect(menu.props).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'low' })
    act(() => menu.props!.onChange('claude-opus-5-5', 'high'))
    expect(saved.map(({ mailDraftModel, mailDraftEffort }) => [mailDraftModel, mailDraftEffort])).toEqual([[null, null]])
  })

  it('disables the control without a default agent', () => {
    show(DEFAULT_HOUSE_SETTINGS, [])
    expect(menu.props!.disabled).toBe(true)
  })
})
