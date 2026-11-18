import type { ProviderConnection, ProviderUsage } from '@manor/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { UsageDialogContent, UsagePanel } from '../src/components/UsagePanel'

const claude: ProviderUsage = {
  provider: 'claude',
  status: 'ok',
  plan: 'max',
  fetchedAt: 1_000,
  windows: [
    { label: '5-hour limit', usedPercent: 63, severity: 'normal', binding: false },
    { label: 'Weekly', usedPercent: 74, severity: 'normal', binding: true },
    { label: 'Weekly Fable', usedPercent: 45, severity: 'normal', binding: false },
  ],
}

const codex: ProviderUsage = {
  provider: 'codex',
  status: 'ok',
  plan: 'plus',
  fetchedAt: 1_000,
  windows: [{ label: 'Weekly', usedPercent: 4, minutes: 10080 }],
}

// The pure reading behind this panel (peakUsed, displayPercent, heatOf,
// resetLabel, card order) is shared with the mobile app and tested in
// `packages/client-runtime/src/usage.test.ts`.

describe('the usage rings', () => {
  const closed = (perProvider: ProviderUsage[]) =>
    renderToStaticMarkup(<UsagePanel perProvider={perProvider} connections={[]} now={() => 1_000} onOpenDetails={() => {}} />)

  it('draws one ring per provider, in card order, filled to what is left of its fullest window', () => {
    const html = closed([codex, claude])

    expect(html).toContain('aria-label="Usage, Claude 26% left, Codex 96% left"')
    expect(html.indexOf('data-usage-ring="claude"')).toBeLessThan(html.indexOf('data-usage-ring="codex"'))
    // The cards live in a dialog; nothing inside it is rendered until it is opened.
    expect(html).not.toContain('Weekly Fable')
  })

  it('leaves out a provider that is not available', () => {
    const html = closed([claude, { provider: 'grok', status: 'unavailable', fetchedAt: 1_000, windows: [] }])

    expect(html).toContain('data-usage-ring="claude"')
    expect(html).not.toContain('data-usage-ring="grok"')
    expect(html).not.toContain('Grok')
  })

  it('heats a ring from the provider\'s own alarm level', () => {
    const spent: ProviderUsage = {
      ...claude,
      windows: [{ label: 'Weekly', usedPercent: 100, severity: 'critical', binding: true }],
    }
    const html = closed([spent, codex])

    expect(html).toContain('Claude 0% left')
    expect(html).not.toContain('stroke-danger')
    expect(html).toContain('stroke-muted')
  })

  it('holds the place with the gauge mark before the first reading lands', () => {
    for (const html of [closed([]), closed([{ provider: 'codex', status: 'unavailable', fetchedAt: 1_000, windows: [] }])]) {
      expect(html).toContain('aria-label="Usage"')
      expect(html).not.toContain('data-usage-ring')
      expect(html).not.toContain('%')
    }
  })
})

describe('the usage dialog', () => {
  const noop = () => {}

  it('renders every provider as a card with its plan and its windows', () => {
    const html = renderToStaticMarkup(<UsageDialogContent connections={[]} perProvider={[claude, codex]} now={1_000} onOpenDetails={noop} />)

    expect(html).toContain('claude')
    expect(html).toContain('max')
    expect(html).toContain('Weekly Fable')
    expect(html).toContain('codex')
    expect(html).toContain('plus')
    // The bar and its number are what is left, so a nearly fresh plan reads as a full bar.
    expect(html).toContain('96% left')
    expect(html).toContain('width:96%')
  })

  it('says unavailable rather than drawing an empty meter', () => {
    const down: ProviderUsage = { provider: 'cursor', status: 'unavailable', fetchedAt: 1_000, windows: [] }
    const html = renderToStaticMarkup(<UsageDialogContent connections={[]} perProvider={[down]} now={1_000} onOpenDetails={noop} />)

    expect(html).toContain('Unavailable')
    expect(html).not.toContain('%')
  })

  it('says so when no provider is reporting at all', () => {
    const html = renderToStaticMarkup(<UsageDialogContent connections={[]} perProvider={[]} now={1_000} onOpenDetails={noop} />)

    expect(html).toContain('No connected provider is reporting usage.')
  })

  it('keeps the way into the history below the cards', () => {
    const html = renderToStaticMarkup(<UsageDialogContent connections={[]} perProvider={[claude]} now={1_000} onOpenDetails={noop} />)

    expect(html).toContain('Usage details')
  })

  it('puts the multi-window providers on the top row regardless of probe order', () => {
    const grok: ProviderUsage = { provider: 'grok', status: 'ok', fetchedAt: 1_000, windows: [{ label: 'Weekly', usedPercent: 12 }] }
    const cursor: ProviderUsage = { provider: 'cursor', status: 'ok', plan: 'Ultra', fetchedAt: 1_000, windows: [{ label: 'Included', usedPercent: 1 }] }
    const html = renderToStaticMarkup(
      <UsageDialogContent connections={[]} perProvider={[codex, grok, cursor, claude]} now={1_000} onOpenDetails={noop} />,
    )

    const at = (name: string) => html.indexOf(`>${name}<`)
    expect(at('claude')).toBeGreaterThanOrEqual(0)
    expect(at('claude')).toBeLessThan(at('cursor'))
    expect(at('cursor')).toBeLessThan(at('grok'))
    expect(at('grok')).toBeLessThan(at('codex'))
  })

  it('does not add a subtitle under Cursor Models', () => {
    const cursor: ProviderUsage = {
      provider: 'cursor',
      status: 'ok',
      plan: 'Ultra',
      fetchedAt: 1_000,
      windows: [
        { label: 'Cursor Models', usedPercent: 1 },
        { label: 'Other Models', usedPercent: 2 },
      ],
    }
    const html = renderToStaticMarkup(<UsageDialogContent connections={[]} perProvider={[cursor]} now={1_000} onOpenDetails={noop} />)

    expect(html).not.toContain('Composer 2.5')
  })

  const row = (provider: ProviderConnection['provider'], state: ProviderConnection['state']): ProviderConnection => ({
    provider,
    installed: state !== 'install',
    version: state === 'install' ? null : '1.0.0',
    signedIn: state === 'ready' ? true : state === 'sign_in' ? false : null,
    state,
    canSignIn: true,
    canInstall: false,
  })
  const grok: ProviderUsage = { provider: 'grok', status: 'ok', fetchedAt: 1_000, windows: [{ label: 'Weekly', usedPercent: 12 }] }

  it('leaves out a provider that is not signed in or not installed', () => {
    const html = renderToStaticMarkup(
      <UsageDialogContent
        perProvider={[claude, codex, grok]}
        connections={[row('claude', 'ready'), row('codex', 'sign_in'), row('grok', 'install')]}
        now={1_000}
        onOpenDetails={noop}
      />,
    )

    expect(html).toContain('>claude<')
    expect(html).not.toContain('>codex<')
    expect(html).not.toContain('>grok<')
  })

  it('keeps a provider whose sign-in is unknown or not yet checked', () => {
    const html = renderToStaticMarkup(
      <UsageDialogContent perProvider={[claude, codex]} connections={[row('claude', 'attention')]} now={1_000} onOpenDetails={noop} />,
    )

    expect(html).toContain('>claude<')
    expect(html).toContain('>codex<')
  })

  it('says so in one line when no provider is connected', () => {
    const html = renderToStaticMarkup(
      <UsageDialogContent
        perProvider={[claude, codex]}
        connections={[row('claude', 'sign_in'), row('codex', 'install')]}
        now={1_000}
        onOpenDetails={noop}
      />,
    )

    expect(html).toContain('No connected provider is reporting usage.')
    expect(html).not.toContain('% left')
  })
})

describe('the pace mark on a dialog bar', () => {
  const hour = 3_600_000
  const timed: ProviderUsage = {
    provider: 'claude',
    status: 'ok',
    fetchedAt: 0,
    // A 5-hour window that opened 4 hours ago: 20% of its time is left.
    windows: [{ label: '5-hour limit', usedPercent: 39, minutes: 300, resetsAt: hour }],
  }

  it('sits where even spending would put the fill', () => {
    const html = renderToStaticMarkup(<UsageDialogContent perProvider={[timed]} connections={[]} now={0} onOpenDetails={() => {}} />)

    expect(html).toMatch(/data-pace-mark="true"[^>]*style="left:20%"/)
  })

  it('is left off a bar without window timing', () => {
    const html = renderToStaticMarkup(<UsageDialogContent perProvider={[claude]} connections={[]} now={0} onOpenDetails={() => {}} />)

    expect(html).not.toContain('data-pace-mark')
  })
})
