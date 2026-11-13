import type { ComposioAlias, ComposioApp, ComposioConnectedApp, McpServerConfig } from '@manor/contracts'
import type { ComposioMarketplacePorts } from './composioMarketplace.js'
import type { ComposioConnectState } from './mcp/composioRegistration.js'
import { COMPOSIO_MCP_NAME, composioApiKeyEnv } from './mcp/composioAttachment.js'
import { fetchComposioCatalog } from './mcp/composioCatalog.js'
import {
  composioSessionId,
  createComposioConnectLink,
  disconnectComposioApp,
  listComposioConnectedApps,
} from './mcp/composioRegistration.js'

/** Composio's API with this host's key; links belong to the registered row's session. */
export function liveComposioMarketplacePorts(
  mcpServers: () => readonly McpServerConfig[],
  env: NodeJS.ProcessEnv = process.env,
): ComposioMarketplacePorts {
  const apiKey = () => {
    const name = composioApiKeyEnv(env)
    const value = name === undefined ? undefined : env[name]
    if (value === undefined || value.length === 0) throw new Error('The Composio API key is missing on this Manor host.')
    return value
  }
  return {
    catalog: async () => fetchComposioCatalog(apiKey()),
    connectedApps: async () => listComposioConnectedApps(apiKey()),
    createLink: async (toolkit, alias) => {
      const key = apiKey()
      const session = composioSessionId(mcpServers().find((server) => server.name === COMPOSIO_MCP_NAME), toolkit)
      return createComposioConnectLink(key, session, toolkit, alias)
    },
    disconnect: async (toolkit, alias) => disconnectComposioApp(apiKey(), toolkit, alias),
  }
}

export interface MockComposio {
  ports: ComposioMarketplacePorts
  /** Where a mock account's sign-in stands, for the spike's connect-card poller. */
  accountState: (accountId: string) => ComposioConnectState | undefined
}

const MOCK_APPS: readonly (Omit<ComposioApp, 'connect'> & { connect?: ComposioApp['connect'] })[] = [
  { slug: 'gmail', name: 'Gmail', description: 'Read, search and draft email in a Google mailbox.', categories: ['email'] },
  { slug: 'googlecalendar', name: 'Google Calendar', description: 'Create, move and read events across Google calendars.', categories: ['scheduling & booking'] },
  { slug: 'googledrive', name: 'Google Drive', description: 'Find, read and organise files and folders in Google Drive.', categories: ['documents'] },
  { slug: 'googlesheets', name: 'Google Sheets', description: 'Read and update spreadsheets, rows and ranges.', categories: ['productivity'] },
  { slug: 'github', name: 'GitHub', description: 'Repositories, issues, pull requests and code review.', categories: ['developer tools'] },
  { slug: 'linear', name: 'Linear', description: 'Issues, projects and cycles for product teams.', categories: ['project management'] },
  { slug: 'notion', name: 'Notion', description: 'Pages, databases and notes in a Notion workspace.', categories: ['productivity', 'documents'] },
  { slug: 'slack', name: 'Slack', description: 'Channels, threads and direct messages.', categories: ['team collaboration'] },
  { slug: 'figma', name: 'Figma', description: 'Files, comments and components in Figma.', categories: ['images & design'] },
  { slug: 'jira', name: 'Jira', description: 'Issues, sprints and boards in Jira.', categories: ['project management'] },
  { slug: 'confluence', name: 'Confluence', description: 'Spaces and pages in a Confluence wiki.', categories: ['documents'] },
  { slug: 'dropbox', name: 'Dropbox', description: 'Files and shared folders in Dropbox.', categories: ['documents'] },
  { slug: 'hubspot', name: 'HubSpot', description: 'Contacts, deals and pipelines in HubSpot CRM.', categories: ['crm'] },
  { slug: 'spotify', name: 'Spotify', description: 'Playlists, saved tracks and playback.', categories: ['entertainment & media'] },
  { slug: 'todoist', name: 'Todoist', description: 'Tasks, projects and due dates.', categories: ['productivity'] },
  { slug: 'youtube', name: 'YouTube', description: 'Channels, playlists and video details.', categories: ['video & audio'] },
  { slug: 'airtable', name: 'Airtable', description: 'Bases, tables and records.', categories: ['databases'] },
  { slug: 'asana', name: 'Asana', description: 'Tasks, projects and portfolios.', categories: ['project management'] },
  { slug: 'trello', name: 'Trello', description: 'Boards, lists and cards.', categories: ['project management'] },
  { slug: 'outlook', name: 'Outlook', description: 'Mail and calendar in Microsoft 365.', categories: ['email'] },
  { slug: 'failbox', name: 'Failbox', description: 'A spike app whose sign-in always fails.', categories: ['developer tools'] },
  { slug: 'twitter', name: 'Twitter', description: 'Posts, timelines and bookmarks.', categories: ['social media'] },
  { slug: 'hackernews', name: 'Hacker News', description: 'Stories and comments from Hacker News.', categories: ['news & lifestyle'], connect: 'no_auth' },
  { slug: 'weathermap', name: 'Weathermap', description: 'Current weather and forecasts for any place.', categories: ['news & lifestyle'], connect: 'no_auth' },
  { slug: 'stripe', name: 'Stripe', description: 'Payments, customers and invoices.', categories: ['payment processing'], connect: 'own_credentials' },
  { slug: 'shopify', name: 'Shopify', description: 'Products, orders and customers.', categories: ['ecommerce'], connect: 'own_credentials' },
  { slug: 'mailchimp', name: 'Mailchimp', description: 'Audiences, campaigns and reports.', categories: ['marketing automation'], connect: 'own_credentials' },
  { slug: 'zendesk', name: 'Zendesk', description: 'Tickets, users and help center articles.', categories: ['customer support'], connect: 'own_credentials' },
]

const FILLER_FIRST = ['Acorn', 'Beacon', 'Cinder', 'Delta', 'Ember', 'Fable', 'Granite', 'Harbor', 'Indigo', 'Juniper', 'Kestrel', 'Lumen', 'Meridian', 'Nimbus', 'Orbit', 'Pylon', 'Quill', 'Ridge', 'Summit', 'Tandem', 'Umber', 'Vertex', 'Willow', 'Zephyr']
const FILLER_SECOND = ['Analytics', 'Billing', 'Forms', 'Inbox', 'Labs', 'Metrics', 'Notes', 'Ops', 'Pages', 'Queue', 'Relay', 'Signals', 'Sync', 'Tasks', 'Vault', 'Works', 'Desk', 'Hub', 'Flow', 'Base', 'Stack', 'Track', 'Cloud', 'Scan', 'Grid']
const FILLER_CATEGORIES = ['analytics', 'developer tools', 'marketing automation', 'crm', 'documents', 'productivity', 'ai agents', 'security & identity tools']

/**
 * The spike's Composio: the apps above plus 600 filler apps that need their own
 * credentials, so the page is judged at catalogue scale, three seeded accounts, and sign-ins that land `delayMs` after the link
 * was made (or fail, for an app whose slug says so). Nothing leaves the process.
 */
export function mockComposio(delayMs = 6_000): MockComposio {
  const filler: ComposioApp[] = FILLER_FIRST.flatMap((first, row) => FILLER_SECOND.map((second, column) => ({
    slug: `${first}${second}`.toLowerCase(),
    name: `${first} ${second}`,
    description: `${first} ${second} for teams that want ${second.toLowerCase()} without the busywork.`,
    categories: [FILLER_CATEGORIES[(row + column) % FILLER_CATEGORIES.length]!],
    connect: 'own_credentials' as const,
  })))
  const apps: ComposioApp[] = [
    ...MOCK_APPS.map((app) => ({ ...app, connect: app.connect ?? 'one_click' })),
    ...filler,
  ].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))

  let next = 0
  const accounts = new Map<string, { toolkit: string; alias: ComposioAlias; createdAt: number; seeded?: true }>([
    ['ca_mock_gmail', { toolkit: 'gmail', alias: 'personal', createdAt: 0, seeded: true }],
    ['ca_mock_github', { toolkit: 'github', alias: 'personal', createdAt: 0, seeded: true }],
    ['ca_mock_notion', { toolkit: 'notion', alias: 'work', createdAt: 0, seeded: true }],
  ])
  const accountState = (accountId: string): ComposioConnectState | undefined => {
    const account = accounts.get(accountId)
    if (account === undefined) return undefined
    if (account.seeded === true || Date.now() - account.createdAt >= delayMs) {
      return account.toolkit.includes('fail')
        ? { status: 'failed', reason: 'Composio reported the sign-in as failed.' }
        : { status: 'active' }
    }
    return { status: 'pending' }
  }
  const connectedApps = (): ComposioConnectedApp[] => {
    const byToolkit = new Map<string, Set<string>>()
    for (const [id, account] of accounts) {
      if (accountState(id)?.status !== 'active') continue
      byToolkit.set(account.toolkit, (byToolkit.get(account.toolkit) ?? new Set()).add(account.alias))
    }
    return [...byToolkit.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([toolkit, aliases]) => ({ toolkit, aliases: [...aliases].sort() }))
  }
  return {
    accountState,
    ports: {
      catalog: async () => apps,
      connectedApps: async () => connectedApps(),
      createLink: async (toolkit, alias) => {
        next += 1
        const accountId = `ca_mock_${toolkit}_${next}`
        accounts.set(accountId, { toolkit, alias, createdAt: Date.now() })
        return { url: `https://connect.composio.dev/link/mock-${toolkit}-${next}`, accountId }
      },
      disconnect: async (toolkit, alias) => {
        let removed = 0
        for (const [id, account] of accounts) {
          if (account.toolkit === toolkit && account.alias === alias) {
            accounts.delete(id)
            removed += 1
          }
        }
        return removed
      },
    },
  }
}
