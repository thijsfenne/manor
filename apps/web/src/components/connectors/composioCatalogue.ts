import type { ComposioAlias, ComposioApp, ComposioConnectedApp, ComposioPageConnect } from '@manor/contracts'
import type { WorkspaceState } from '../../state'
import type { Manor } from '../../useWorkspace'

export const ALL_CATEGORIES = 'all'

const ACRONYMS = new Set(['ai', 'api', 'crm', 'erp', 'hr', 'it', 'seo', 'sms'])

/** Composio names categories in lower case ("ai agents"); the page shows "AI agents". */
export const categoryLabel = (name: string): string => {
  const words = name.split(' ').map((word) => ACRONYMS.has(word) ? word.toUpperCase() : word)
  const first = words[0] ?? ''
  return [`${first.charAt(0).toUpperCase()}${first.slice(1)}`, ...words.slice(1)].join(' ')
}

export const aliasLabel = (alias: string): string => `${alias.charAt(0).toUpperCase()}${alias.slice(1)}`

/** Name, slug, description and category, so "mail" finds Gmail and "crm" finds HubSpot. */
export function appMatches(app: ComposioApp, query: string): boolean {
  if (query.length === 0) return true
  return app.name.toLowerCase().includes(query) ||
    app.slug.toLowerCase().includes(query) ||
    app.description.toLowerCase().includes(query) ||
    app.categories.some((category) => category.includes(query))
}

export function categoryOptions(apps: readonly ComposioApp[]): { value: string; label: string }[] {
  const names = new Set(apps.flatMap((app) => app.categories))
  return [
    { value: ALL_CATEGORIES, label: 'All categories' },
    ...[...names].sort((left, right) => left.localeCompare(right)).map((name) => ({ value: name, label: categoryLabel(name) })),
  ]
}

export const CONNECT_GROUPS: readonly { kind: ComposioApp['connect']; label: string; hint?: string }[] = [
  { kind: 'one_click', label: 'Connect in one click' },
  { kind: 'no_auth', label: 'No sign-in needed', hint: 'Agents can use these without an account.' },
  { kind: 'own_credentials', label: 'Needs its own credentials', hint: 'Set up an auth config in Composio first; then they connect here.' },
]

/** What the page shows for one app: its aliases already in, and the connect the user started last. */
export interface AppAccountState {
  aliases: readonly string[]
  connect?: ComposioPageConnect
}

export function accountStateFor(
  slug: string,
  connected: readonly ComposioConnectedApp[],
  connects: readonly ComposioPageConnect[],
): AppAccountState {
  const aliases = connected.find((app) => app.toolkit === slug)?.aliases ?? []
  const mine = connects.filter((connect) => connect.toolkit === slug)
  // A sign-in still open outranks an older outcome for the other alias.
  const connect = mine.find((entry) => entry.status === 'waiting') ?? mine.find((entry) => entry.status === 'failed' && !aliases.includes(entry.alias))
  return connect === undefined ? { aliases } : { aliases, connect }
}

export const openAliases = (aliases: readonly string[], all: readonly ComposioAlias[]): ComposioAlias[] =>
  all.filter((alias) => !aliases.includes(alias))

/** The Composio marketplace as the page sees it: shared state plus its requests. */
export interface ComposioBinding {
  catalog: WorkspaceState['composioCatalog']
  accounts: WorkspaceState['composioAccounts']
  /** Where the host's key comes from; null until the server says. */
  key: WorkspaceState['composioKey']
  list: () => boolean
  connect: (toolkit: string, alias: ComposioAlias, requestId: string) => boolean
  disconnect: (toolkit: string, alias: ComposioAlias | null, requestId: string) => boolean
  setKey: (key: string, requestId: string) => boolean
  removeKey: (requestId: string) => boolean
}

/** The same binding from both places the page opens: Plugins and Settings. */
export const composioBinding = (manor: Manor): ComposioBinding => ({
  catalog: manor.workspace.composioCatalog,
  accounts: manor.workspace.composioAccounts,
  key: manor.workspace.composioKey,
  list: manor.listComposioApps,
  connect: manor.connectComposioApp,
  disconnect: manor.disconnectComposioApp,
  setKey: manor.setComposioKey,
  removeKey: manor.removeComposioKey,
})
