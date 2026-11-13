import type { UsageReportProvider } from '@manor/contracts'

/**
 * How each provider is named and coloured on the Usage pages. The colour is the `--color-series-*` token, so the cost
 * chart, the share bars and the limit bars read as one.
 */
export const PROVIDER_PRESENTATION: Record<UsageReportProvider, { label: string; color: string }> = {
  codex: { label: 'Codex', color: 'var(--color-series-codex)' },
  claude: { label: 'Claude Code', color: 'var(--color-series-claude)' },
  grok: { label: 'Grok Build', color: 'var(--color-series-grok)' },
  cursor: { label: 'Cursor', color: 'var(--color-series-cursor)' },
  unknown: { label: 'Unknown provider', color: 'var(--color-series-unknown)' },
}
