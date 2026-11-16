import type { ComposioAlias, ComposioApp, ComposioConnectedApp, ComposioPageConnect } from '@manor/contracts'
import type { WorkspaceState } from '../../state'
import type { Manor } from '../../useWorkspace'

export const ALL_CATEGORIES = 'all'

/**
 * The page's own short set of categories, each fed by the Composio category names it
 * gathers. Composio files its 1,700-odd apps under about a hundred names; shown as is,
 * that is a hundred thin groups. A name Composio adds later lands in Other until it is
 * listed here. Knowledge work first, coding last.
 */
export const APP_CATEGORIES = [
  {
    id: 'productivity',
    label: 'Productivity',
    hint: 'Tasks, projects, calendars, notes and forms.',
    composio: ['productivity', 'project management', 'task management', 'product management', 'scheduling & booking', 'calendar',
      'notes', 'time tracking software', 'team collaboration', 'event management', 'bookmark managers', 'forms & surveys'],
  },
  {
    id: 'communication',
    label: 'Communication',
    hint: 'Email, chat, calls, meetings and social accounts.',
    composio: ['email', 'communication', 'team chat', 'phone & sms', 'video conferencing', 'webinars', 'transactional email',
      'notifications', 'ai meeting assistants', 'social media accounts'],
  },
  {
    id: 'documents',
    label: 'Documents',
    hint: 'Files, storage, spreadsheets and signatures.',
    composio: ['documents', 'file management & storage', 'content & files', 'documents & ocr', 'ai document extraction', 'spreadsheets',
      'signatures', 'proposal & invoice management'],
  },
  {
    id: 'research',
    label: 'Research',
    hint: 'Web search, scraping, news, places and public data.',
    composio: ['web search & research', 'ai web scraping', 'web scraping & browser', 'news & lifestyle', 'places & weather', 'education',
      'online courses', 'legal & public records', 'reviews', 'people & contact data', 'company data', 'market data', 'social & creator data'],
  },
  {
    id: 'data',
    label: 'Data',
    hint: 'Analytics, business intelligence, dashboards and databases.',
    composio: ['analytics', 'business intelligence', 'dashboards', 'databases'],
  },
  {
    id: 'design',
    label: 'Design',
    hint: 'Images, video, audio, websites and media generation.',
    composio: ['images & design', 'video & audio', 'audio & speech', 'transcription', 'media generation', 'video generation',
      'ai content generation', 'website builders', 'website & app building', 'app builder', 'gaming', 'lifestyle & entertainment', 'fitness'],
  },
  {
    id: 'business',
    label: 'Business',
    hint: 'CRM, sales, marketing, commerce, payments, accounting and HR.',
    composio: ['crm', 'sales & crm', 'contact management', 'ai sales tools', 'marketing automation', 'marketing', 'email newsletters',
      'drip emails', 'social media marketing', 'ads & conversion', 'seo & ai visibility', 'call tracking', 'url shortener', 'ecommerce',
      'commerce', 'payment processing', 'accounting', 'taxes', 'fundraising', 'human resources', 'hr talent & recruitment',
      'customer support', 'support', 'customer appreciation'],
  },
  {
    id: 'ai',
    label: 'AI',
    hint: 'Models, agents, chatbots and assistants.',
    composio: ['artificial intelligence', 'ai agents', 'ai models', 'ai chatbots', 'ai assistants', 'ai safety compliance detection'],
  },
  {
    id: 'coding',
    label: 'Coding',
    hint: 'Developer tools, hosting, monitoring and security.',
    composio: ['developer tools', 'server monitoring', 'it operations', 'security & identity tools', 'internet of things'],
  },
  {
    id: 'other',
    label: 'Other',
    hint: 'Apps Composio files under none of the categories above.',
    composio: [],
  },
] as const satisfies readonly { id: string; label: string; hint: string; composio: readonly string[] }[]

export type AppCategory = (typeof APP_CATEGORIES)[number]
export type AppCategoryId = AppCategory['id']

const CATEGORY_OF = new Map<string, AppCategoryId>(
  APP_CATEGORIES.flatMap((category) => category.composio.map((name) => [name, category.id] as const)),
)

/**
 * The one category an app is shown under: the first of its Composio categories that
 * maps, since Composio lists the main one first. "model context protocol" says how an
 * app is reached rather than what it does, so it maps to nothing and the next one decides.
 */
export const appCategory = (app: Pick<ComposioApp, 'categories'>): AppCategoryId =>
  app.categories.map((name) => CATEGORY_OF.get(name.trim().toLowerCase())).find((id) => id !== undefined) ?? 'other'

/** Inside a category, what can connect from the page comes before what needs setup in Composio. */
const CONNECT_ORDER: Record<ComposioApp['connect'], number> = { one_click: 0, no_auth: 1, own_credentials: 2 }

export interface CategoryGroup {
  category: AppCategory
  apps: ComposioApp[]
}

/** The catalogue in category order, without empty categories; each keeps the catalogue's name order inside its connect order. */
export function groupByCategory(apps: readonly ComposioApp[]): CategoryGroup[] {
  const buckets = new Map<AppCategoryId, ComposioApp[]>()
  for (const app of apps) {
    const id = appCategory(app)
    const bucket = buckets.get(id)
    if (bucket === undefined) buckets.set(id, [app])
    else bucket.push(app)
  }
  return APP_CATEGORIES.flatMap((category) => {
    const bucket = buckets.get(category.id)
    return bucket === undefined ? [] : [{ category, apps: bucket.sort((left, right) => CONNECT_ORDER[left.connect] - CONNECT_ORDER[right.connect]) }]
  })
}

export const aliasLabel = (alias: string): string => `${alias.charAt(0).toUpperCase()}${alias.slice(1)}`

/** Name, slug, description and Composio category, so "mail" finds Gmail and "crm" finds HubSpot. */
export function appMatches(app: ComposioApp, query: string): boolean {
  if (query.length === 0) return true
  return app.name.toLowerCase().includes(query) ||
    app.slug.toLowerCase().includes(query) ||
    app.description.toLowerCase().includes(query) ||
    app.categories.some((category) => category.includes(query))
}

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
