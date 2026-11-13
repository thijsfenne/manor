import type { ComposioApp } from '@manor/contracts'

const TOOLKITS_ENDPOINT = 'https://backend.composio.dev/api/v3.1/toolkits'
const AUTH_CONFIGS_ENDPOINT = 'https://backend.composio.dev/api/v3.1/auth_configs'
const REQUEST_TIMEOUT_MS = 20_000
/** Composio's page maximum; the whole catalogue (about 1,600 apps) is two pages. */
const PAGE_LIMIT = 1000
const MAX_PAGES = 20
const DESCRIPTION_CHARS = 220

type JsonRecord = Record<string, unknown>
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Every page of one Composio list endpoint. */
async function listAll(endpoint: string, apiKey: string, request: typeof fetch, label: string): Promise<JsonRecord[]> {
  const items: JsonRecord[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const url = new URL(endpoint)
    url.searchParams.set('limit', String(PAGE_LIMIT))
    if (cursor !== undefined) url.searchParams.set('cursor', cursor)
    const response = await request(url, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: { 'x-api-key': apiKey },
    })
    if (!response.ok) throw new Error(`Composio ${label} listing answered HTTP ${response.status}`)
    const json = await response.json() as unknown
    if (!isRecord(json) || !Array.isArray(json.items)) throw new Error(`Composio ${label} listing returned no items`)
    for (const item of json.items) if (isRecord(item)) items.push(item)
    cursor = typeof json.next_cursor === 'string' && json.next_cursor.length > 0 ? json.next_cursor : undefined
    if (cursor === undefined) return items
  }
  throw new Error(`Composio ${label} listing did not end after ${MAX_PAGES} pages`)
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= DESCRIPTION_CHARS) return flat
  const cut = flat.slice(0, DESCRIPTION_CHARS)
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), DESCRIPTION_CHARS - 40)).replace(/[,;:.\s]+$/, '')}…`
}

/**
 * Composio's whole app catalogue, trimmed to what the Connectors page shows. An app
 * connects in one click when Composio manages its sign-in, it registers its own client
 * (DCR), or this project already holds an enabled auth config for it.
 */
export async function fetchComposioCatalog(apiKey: string, request: typeof fetch = fetch): Promise<ComposioApp[]> {
  const [toolkits, authConfigs] = await Promise.all([
    listAll(TOOLKITS_ENDPOINT, apiKey, request, 'toolkit'),
    listAll(AUTH_CONFIGS_ENDPOINT, apiKey, request, 'auth config'),
  ])
  const configured = new Set(authConfigs.flatMap((config) => {
    const slug = isRecord(config.toolkit) ? config.toolkit.slug : undefined
    return typeof slug === 'string' && config.status !== 'DISABLED' ? [slug] : []
  }))
  const apps: ComposioApp[] = []
  for (const toolkit of toolkits) {
    const { slug, name } = toolkit
    if (typeof slug !== 'string' || slug.length === 0 || typeof name !== 'string' || name.length === 0) continue
    const meta = isRecord(toolkit.meta) ? toolkit.meta : {}
    const categories = Array.isArray(meta.categories)
      ? meta.categories.flatMap((category) =>
          isRecord(category) && typeof category.name === 'string' ? [category.name.slice(0, 80)] : []).slice(0, 12)
      : []
    const oneClick = strings(toolkit.composio_managed_auth_schemes).length > 0 ||
      strings(toolkit.auth_schemes).includes('DCR_OAUTH') || configured.has(slug)
    apps.push({
      slug: slug.slice(0, 120),
      name: name.slice(0, 200),
      description: typeof meta.description === 'string' ? shorten(meta.description) : '',
      categories,
      connect: oneClick ? 'one_click' : toolkit.no_auth === true ? 'no_auth' : 'own_credentials',
    })
  }
  return apps.sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
}
