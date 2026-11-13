import type { ComposioApp, McpServerConfig, SkillConfig } from '@manor/contracts'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ConnectorsView } from '../src/components/connectors/ConnectorsView'
import type { ComposioBinding } from '../src/components/connectors/composioCatalogue'
import type { RequestEvents } from '../src/useRequest'
import {
  availableSkillSortOptions,
  SkillDialog,
  SkillsView,
  sortSkills,
} from '../src/components/skills/SkillsView'

vi.mock('../src/components/Modal', () => ({
  Modal: ({ title, children }: { title: string; children: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  ModalFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
}))

vi.mock('../src/components/ui/Select', () => ({
  Select: ({
    value,
    options,
    label,
  }: {
    value: string
    options: readonly { value: string; label: string }[]
    label: string
  }) => (
    <select aria-label={label} value={value} onChange={() => undefined}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>{option.label}</option>
      ))}
    </select>
  ),
}))

const connector = (name: string): McpServerConfig => ({
  id: `mcp_${name.toLowerCase()}`,
  name,
  command: 'npx',
  args: [],
  envKeys: [],
  description: `${name} connector`,
  writes: false,
  effectPolicy: 'confirm_writes',
  tools: [],
  readOnlyTools: [],
  schemaChars: 0,
})

const skill = (name: string, usageCount?: number, lastUsedAt?: string): SkillConfig => ({
  id: name.toLowerCase(),
  name,
  description: `${name} skill`,
  instructions: 'Use this skill.',
  sources: ['claude'],
  usageCount,
  lastUsedAt,
})
const requestEvents: RequestEvents = { subscribe: () => () => {} }
const noComposio: ComposioBinding = {
  catalog: null, accounts: null, key: null, list: () => true, connect: () => true, disconnect: () => true, setKey: () => true, removeKey: () => true,
}

describe('plugin registry layouts', () => {
  it('shows connectors alphabetically in a responsive two-column list', () => {
    const html = renderToStaticMarkup(
      <ConnectorsView
        requestEvents={requestEvents}
        agents={[]}
        registry={[connector('Zulu'), connector('Alpha')]}
        hostStatuses={[]}
        mymind={{
          available: true,
          env: [
            { key: 'MANOR_MYMIND_KEY_ID', present: true },
            { key: 'MANOR_MYMIND_SECRET', present: true },
          ],
          problem: null,
          check: null,
        }}
        notice={null}
        onSave={() => true}
        onVerify={() => true}
        onVerifyMyMind={() => true}
        onDelete={() => true}
        onDismissNotice={() => undefined}
        onDialogChange={() => undefined}
        live={false}
        composio={noComposio}
      />,
    )

    expect(html).toContain('grid grid-cols-2 gap-x-8 gap-y-2 max-[760px]:grid-cols-1')
    expect(html.indexOf('Alpha connector')).toBeLessThan(html.indexOf('Zulu connector'))
    expect(html).toContain('type="button" aria-label="Open Alpha"')
    expect(html).toContain('type="button" aria-label="Open mymind"')
    expect(html).toContain('px-2 py-2 text-left')
    expect(html).toContain('rounded-lg bg-surface text-muted')
    expect(html).toContain('hover:bg-surface-2')
    expect(html).not.toContain('mt-0.5')
    expect(html).not.toContain('>Edit<')
    expect(html).not.toContain('attached to')
  })

  it('lists connected Composio apps first, then the catalogue grouped by how each app connects', () => {
    const app = (slug: string, name: string, connect: ComposioApp['connect']): ComposioApp =>
      ({ slug, name, description: `${name} tools`, categories: ['productivity'], connect })
    const html = renderToStaticMarkup(
      <ConnectorsView
        requestEvents={requestEvents}
        agents={[]}
        registry={[connector('Figma')]}
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
        composio={{
          ...noComposio,
          catalog: { apps: [app('stripe', 'Stripe', 'own_credentials'), app('github', 'GitHub', 'one_click'), app('linear', 'Linear', 'one_click')] },
          accounts: { connected: [{ toolkit: 'github', aliases: ['personal'] }], connects: [{ toolkit: 'linear', alias: 'work', status: 'waiting' }] },
        }}
      />,
    )

    expect(html.indexOf('Disconnect GitHub')).toBeLessThan(html.indexOf('Connect in one click'))
    expect(html).toContain('Composio · Personal')
    expect(html).toContain('logos.composio.dev/api/github')
    expect(html).toContain('Add Work')
    expect(html).toContain('Finish in your browser')
    expect(html.indexOf('Connect in one click')).toBeLessThan(html.indexOf('Needs its own credentials'))
    expect(html).toContain('Own credentials')
    expect(html).not.toContain('Connect Stripe')
  })

  it('keeps an unavailable connector visible with its reason', () => {
    const unavailable = { ...connector('Composio'), unavailable: 'Composio could not connect. Try reconnecting.' }
    const html = renderToStaticMarkup(
      <ConnectorsView
        requestEvents={requestEvents}
        agents={[]}
        registry={[unavailable]}
        hostStatuses={[]}
        mymind={null}
        notice={null}
        onSave={() => true}
        onVerify={() => true}
        onVerifyMyMind={() => true}
        onDelete={() => true}
        onDismissNotice={() => undefined}
        onDialogChange={() => undefined}
        live={false}
        composio={noComposio}
      />,
    )

    expect(html).toContain('Open Composio')
    expect(html).toContain('Unavailable')
    expect(html).toContain('Composio could not connect. Try reconnecting.')
  })

  it('without a key, leads with the setup card and lets the Composio row wait instead of failing', () => {
    const composioRow = { ...connector('composio'), unavailable: 'The Composio API key is missing on this Manor host.' }
    const html = renderToStaticMarkup(
      <ConnectorsView
        requestEvents={requestEvents}
        agents={[]}
        registry={[composioRow, connector('Alpha')]}
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
        composio={{ ...noComposio, key: 'none' }}
      />,
    )

    expect(html.indexOf('Connect your apps')).toBeLessThan(html.indexOf('Search connectors and apps'))
    expect(html.indexOf('Connect your apps')).toBeLessThan(html.indexOf('Alpha connector'))
    expect(html).toContain('Starts once the Composio key is saved')
    expect(html).not.toContain('missing on this Manor host')
    expect(html).not.toContain('>Unavailable<')
  })

  it('shows skills alphabetically in the same responsive two-column list', () => {
    const html = renderToStaticMarkup(
      <SkillsView
        requestEvents={requestEvents}
        agents={[]}
        skills={[
          skill('Zulu', 12, '2026-08-24T12:00:00.000Z'),
          skill('Alpha', 0, '2026-08-23T12:00:00.000Z'),
        ]}
        candidates={[]}
        notice={null}
        onListCandidates={() => true}
        onImport={() => true}
        onDelete={() => true}
        onDismissNotice={() => undefined}
        onDialogChange={() => undefined}
      />,
    )

    expect(html).toContain('grid grid-cols-2 gap-x-8 gap-y-2 max-[760px]:grid-cols-1')
    expect(html.indexOf('Alpha skill')).toBeLessThan(html.indexOf('Zulu skill'))
    expect(html).toContain('>0 uses<')
    expect(html).toContain('>12 uses<')
    expect(html).toContain('type="button" aria-label="Open Alpha"')
    expect(html).toContain('px-2 py-2 text-left')
    expect(html).toContain('rounded-lg bg-surface text-[var(--color-skill)]')
    expect(html).toContain('hover:bg-surface-2')
    expect(html).toContain('focus:border-dim pl-10')
    expect(html).toContain('aria-label="Sort skills"')
    expect(html).toContain('<option value="name" selected="">A–Z</option>')
    expect(html).toContain('>Uses<')
    expect(html).toContain('>A–Z<')
    expect(html).toContain('>Recent<')
    expect(html).not.toContain('aria-pressed')
    expect(html).not.toContain('mt-0.5')
    expect(html).not.toContain('>View<')
    expect(html).not.toContain('$alpha')
    expect(html).not.toContain('attached to')
  })

  it('hides sort modes whose telemetry is unavailable', () => {
    expect(availableSkillSortOptions([skill('Alpha')])).toEqual([
      { value: 'name', label: 'A–Z' },
    ])
    expect(availableSkillSortOptions([skill('Alpha', 0)])).toEqual([
      { value: 'uses', label: 'Uses' },
      { value: 'name', label: 'A–Z' },
    ])
  })

  it('moves skill provenance, bundle size, and attachments into the popup', () => {
    const html = renderToStaticMarkup(
      <SkillDialog
        pending={false}
        skill={{ ...skill('Alpha', 7), fileCount: 2, bundleBytes: 7 * 1024 }}
        holders={['Sage', 'Smith', 'Jeeves', 'Argus']}
        notice={null}
        onDelete={() => true}
        onClose={() => undefined}
      />,
    )

    expect(html).toContain('$alpha')
    expect(html).toContain('Claude · 2 files · 7 KB · attached to Sage, Smith, Jeeves, Argus')
  })

  it('sorts known usage and recent timestamps descending, leaving unknown telemetry last', () => {
    const skills = [
      skill('Alpha'),
      skill('Beta', 3, '2026-08-20T09:00:00.000Z'),
      skill('Gamma', 8, '2026-08-21T09:00:00.000Z'),
      skill('Delta', 3, '2026-08-22T09:00:00.000Z'),
    ]

    expect(sortSkills(skills, 'name').map(({ name }) => name)).toEqual(['Alpha', 'Beta', 'Delta', 'Gamma'])
    expect(sortSkills(skills, 'uses').map(({ name }) => name)).toEqual(['Gamma', 'Beta', 'Delta', 'Alpha'])
    expect(sortSkills(skills, 'recent').map(({ name }) => name)).toEqual(['Delta', 'Gamma', 'Beta', 'Alpha'])
  })
})
