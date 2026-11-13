import { createHmac, timingSafeEqual } from 'node:crypto'
import type { MyMindArtifact, MyMindArtifactKind, MyMindSpace } from '@manor/contracts'
import type { MyMindConfig } from './config.js'

const API_ORIGIN = 'https://api.mymind.com'
const USER_AGENT = 'manor/1.0'
const RESULT_PAGE_SIZE = 60
const THUMBNAIL_SIZE = '1200x1200'
const AGENT_SEARCH_LIMIT = 12
const AGENT_PREVIEW_SIZE = '900x900'
const AGENT_INSPECTION_LIMIT = 4
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024

export const MYMIND_THUMBNAIL_PREFIX = '/internal/mymind-thumbnail/'

export interface MyMindListing {
  objects: MyMindArtifact[]
  spaces: MyMindSpace[]
  hasMore: boolean
}

export interface MyMindInspection {
  artifacts: Array<{
    artifact: MyMindArtifact
    preview?: { bytes: Uint8Array; contentType: string }
  }>
  spaces: MyMindSpace[]
}

export interface MyMindClient {
  /** Proves the key pair against a small read-only endpoint without spending search credits. */
  verify(): Promise<void>
  list(query?: string): AsyncGenerator<MyMindListing>
  /** Semantic, relevance-ranked search for an agent that was explicitly sent here. */
  search(query: string): Promise<MyMindListing>
  /** Full metadata plus actual preview pixels for at most four chosen results. */
  inspect(ids: readonly string[]): Promise<MyMindInspection>
  fetchThumbnail(url: string): Promise<{ bytes: Uint8Array; contentType: string } | undefined>
}

type Fetcher = typeof fetch

const base64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url')

/** The request-bound JWT shape published by mymind's official reference client. */
export function signMyMindRequest(
  config: MyMindConfig,
  method: string,
  path: string,
  now = Math.floor(Date.now() / 1_000),
): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', kid: config.keyId }))
  const payload = base64url(JSON.stringify({ method: method.toUpperCase(), path, iat: now, exp: now + 300 }))
  const input = `${header}.${payload}`
  const signature = createHmac('sha256', Buffer.from(config.secret, 'base64')).update(input).digest('base64url')
  return `${input}.${signature}`
}

export function createMyMindClient(config: MyMindConfig, fetcher: Fetcher = fetch): MyMindClient {
  let spaces: Promise<MyMindSpace[]> | undefined

  const fetchApi = (path: string, query?: URLSearchParams, accept = 'application/json') => {
    const url = new URL(path, API_ORIGIN)
    if (query !== undefined) url.search = query.toString()
    return fetcher(url, {
      headers: {
        Authorization: `Bearer ${signMyMindRequest(config, 'GET', path)}`,
        Accept: accept,
        'User-Agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(20_000),
    })
  }

  const request = async (path: string, query?: URLSearchParams): Promise<unknown> => {
    const response = await fetchApi(path, query)
    if (!response.ok) {
      let detail = response.statusText
      try {
        const problem = (await response.json()) as { detail?: unknown }
        if (typeof problem.detail === 'string') detail = problem.detail
      } catch {
        // A status and a short status text are still an honest, credential-free error.
      }
      throw new Error(`mymind answered ${response.status}: ${detail}`)
    }
    return response.json()
  }

  const listSpaces = () => {
    spaces ??= request('/spaces').then(normalizeSpaces)
    return spaces
  }

  const objectsById = async (ids: readonly string[]): Promise<MyMindArtifact[]> => {
    const uniqueIds = [...new Set(ids)]
    if (uniqueIds.length === 0) return []
    const params = new URLSearchParams({ contentAs: 'text/markdown' })
    for (const id of uniqueIds) params.append('id', id)
    params.set('limit', String(uniqueIds.length))
    const objects = normalizeObjects(await request('/objects', params), (id) => thumbnailCapability(config, id))
    const byId = new Map(objects.map((object) => [object.id, object]))
    return uniqueIds.flatMap((id) => {
      const object = byId.get(id)
      return object === undefined ? [] : [object]
    })
  }

  const fetchThumbnailById = async (
    id: string,
    size: string,
  ): Promise<{ bytes: Uint8Array; contentType: string } | undefined> => {
    const path = `/objects/${encodeURIComponent(id)}/thumbnail`
    const response = await fetchApi(path, new URLSearchParams({ size }), 'image/*')
    if (response.status === 404 || response.status === 422) return undefined
    if (!response.ok) await throwMyMindError(response)
    const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim() ?? ''
    if (!contentType.startsWith('image/')) throw new Error('mymind returned a non-image thumbnail')
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_PREVIEW_BYTES) throw new Error('mymind returned an oversized thumbnail')
    return { bytes, contentType }
  }

  return {
    async verify() {
      normalizeSpaces(await request('/spaces'))
    },
    async *list(query = '') {
      const params = new URLSearchParams({ contentAs: 'text/markdown' })
      const trimmed = query.trim()
      if (trimmed.length > 0) params.set('q', trimmed)
      const [response, knownSpaces] = await Promise.all([
        fetchApi('/objects', params, 'application/jsonl'),
        listSpaces(),
      ])
      if (!response.ok) await throwMyMindError(response)

      let page: MyMindArtifact[] = []
      for await (const rawObject of jsonLines(response)) {
        page.push(...normalizeObjects([rawObject], (id) => thumbnailCapability(config, id)))
        if (page.length <= RESULT_PAGE_SIZE) continue
        yield { objects: page.slice(0, RESULT_PAGE_SIZE), spaces: knownSpaces, hasMore: true }
        page = page.slice(RESULT_PAGE_SIZE)
      }
      yield { objects: page, spaces: knownSpaces, hasMore: false }
    },
    async search(query) {
      const trimmed = query.trim()
      if (trimmed.length === 0) throw new Error('Artifact search needs a query.')
      const params = new URLSearchParams({
        q: trimmed,
        limit: String(AGENT_SEARCH_LIMIT),
        semantic: 'true',
      })
      const ids = normalizeSearchIds(await request('/search', params)).slice(0, AGENT_SEARCH_LIMIT)
      const [objects, knownSpaces] = await Promise.all([objectsById(ids), listSpaces()])
      return { objects, spaces: knownSpaces, hasMore: ids.length === AGENT_SEARCH_LIMIT }
    },
    async inspect(ids) {
      const safeIds = [...new Set(ids)].slice(0, AGENT_INSPECTION_LIMIT)
      const [objects, knownSpaces] = await Promise.all([objectsById(safeIds), listSpaces()])
      const artifacts = await Promise.all(objects.map(async (artifact) => {
        const preview = artifact.imageUrl === undefined
          ? undefined
          : await fetchThumbnailById(artifact.id, AGENT_PREVIEW_SIZE)
        return { artifact, ...(preview === undefined ? {} : { preview }) }
      }))
      return { artifacts, spaces: knownSpaces }
    },
    async fetchThumbnail(url) {
      const id = thumbnailId(config, url)
      if (id === undefined) return undefined
      return fetchThumbnailById(id, THUMBNAIL_SIZE)
    },
  }
}

async function throwMyMindError(response: Response): Promise<never> {
  let detail = response.statusText
  try {
    const problem = (await response.json()) as { detail?: unknown }
    if (typeof problem.detail === 'string') detail = problem.detail
  } catch {
    // A status and a short status text are still an honest, credential-free error.
  }
  throw new Error(`mymind answered ${response.status}: ${detail}`)
}

/** Streams the official JSONL response and cancels the HTTP body when its page session closes. */
async function* jsonLines(response: Response): AsyncGenerator<unknown> {
  if (response.body === null) throw new Error('mymind returned an empty object stream.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim().length === 0) continue
        yield parseJsonLine(line)
      }
      if (done) break
    }
    if (buffer.trim().length > 0) yield parseJsonLine(buffer)
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line)
  } catch {
    throw new Error('mymind returned an invalid object stream.')
  }
}

function normalizeSearchIds(value: unknown): string[] {
  const matches = record(value)?.matches
  if (!Array.isArray(matches)) throw new Error('mymind returned an invalid search result.')
  return [...new Set(matches.flatMap((match) => {
    const id = limitedString(record(match)?.id, 160)
    return id === undefined ? [] : [id]
  }))]
}

function normalizeObjects(value: unknown, thumbnailUrl: (id: string) => string): MyMindArtifact[] {
  if (!Array.isArray(value)) throw new Error('mymind returned an invalid object list.')
  return value.flatMap((item) => {
    const object = record(item)
    const id = limitedString(object?.id, 160)
    if (object === undefined || id === undefined) return []
    const blob = record(object.blob)
    const screenshot = record(object.screenshot)
    const entity = record(object.mainEntity) ?? record(object.entity)
    const content = limited(contentBody(object.content), 120_000)
    const note = limited(Array.isArray(object.notes) ? contentBody(record(object.notes[0])?.content) : undefined, 12_000)
    const url = websiteUrl(record(object.source)?.url) ?? websiteUrl(entity?.url)
    const imageUrl = blob === undefined && screenshot === undefined ? undefined : thumbnailUrl(id)
    const types = entityTypes(entity?.['@type'])
    const kind = artifactKind(types, string(blob?.type), content, url)
    const title = limited(string(object.title)?.trim() || titleFromContent(content) || 'Untitled artifact', 500) ?? 'Untitled artifact'
    const tags = Array.isArray(object.tags)
      ? object.tags.flatMap((tag) => {
          const name = string(record(tag)?.name)?.trim()
          return name === undefined || name.length === 0 ? [] : [name.slice(0, 240)]
        }).slice(0, 200)
      : []
    const spaces = Array.isArray(object.spaces)
      ? object.spaces.flatMap((space) => {
          const spaceId = limitedString(record(space)?.id, 160)
          return spaceId === undefined ? [] : [spaceId]
        }).slice(0, 100)
      : []

    return [{
      id,
      title,
      kind,
      summary: limited(string(object.summary)?.trim() || undefined, 12_000),
      content,
      note,
      url,
      imageUrl,
      imageWidth: finiteNumber(blob?.width) ?? finiteNumber(screenshot?.width),
      imageHeight: finiteNumber(blob?.height) ?? finiteNumber(screenshot?.height),
      tags,
      spaces,
      created: string(object.created) ?? '',
      bumped: string(object.bumped) ?? string(object.created) ?? '',
    }]
  })
}

/** A stable, unguessable same-origin capability rather than a private media path. */
function thumbnailCapability(config: MyMindConfig, id: string): string {
  const encoded = base64url(id)
  const signature = thumbnailSignature(config, encoded)
  return `${MYMIND_THUMBNAIL_PREFIX}${encoded}.${signature}`
}

function thumbnailId(config: MyMindConfig, value: string): string | undefined {
  const url = new URL(value, 'http://manor')
  if (url.origin !== 'http://manor' || url.search.length > 0 || !url.pathname.startsWith(MYMIND_THUMBNAIL_PREFIX)) {
    return undefined
  }
  const capability = url.pathname.slice(MYMIND_THUMBNAIL_PREFIX.length)
  const separator = capability.lastIndexOf('.')
  if (separator <= 0) return undefined
  const encoded = capability.slice(0, separator)
  const provided = Buffer.from(capability.slice(separator + 1), 'base64url')
  const expected = Buffer.from(thumbnailSignature(config, encoded), 'base64url')
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return undefined
  try {
    const id = Buffer.from(encoded, 'base64url').toString('utf8')
    return id.length > 0 && id.length <= 160 ? id : undefined
  } catch {
    return undefined
  }
}

const thumbnailSignature = (config: MyMindConfig, encodedId: string): string =>
  createHmac('sha256', Buffer.from(config.secret, 'base64'))
    .update(`thumbnail:${encodedId}`)
    .digest('base64url')

function normalizeSpaces(value: unknown): MyMindSpace[] {
  if (!Array.isArray(value)) throw new Error('mymind returned an invalid Spaces list.')
  return value.flatMap((item) => {
    const space = record(item)
    const id = limitedString(space?.id, 160)
    const name = limitedString(space?.name, 240)?.trim()
    if (id === undefined || name === undefined || name.length === 0) return []
    return [{ id, name, color: string(space?.color) }]
  })
}

const IMAGE_TYPES = new Set(['ImageObject', 'Photograph', 'Screenshot', 'Painting', 'Palette'])
const ARTICLE_TYPES = new Set(['Article', 'ScholarlyArticle', 'WebPage', 'Periodical'])

function artifactKind(
  types: readonly string[],
  mime: string | undefined,
  content: string | undefined,
  url: string | undefined,
): MyMindArtifactKind {
  if (types.includes('Product')) return 'product'
  if (types.some((type) => IMAGE_TYPES.has(type)) || mime?.startsWith('image/') === true) return 'image'
  if (types.some((type) => ARTICLE_TYPES.has(type))) return 'article'
  if (types.includes('Note') || types.includes('Quotation') || (content !== undefined && url === undefined)) return 'note'
  return 'other'
}

function entityTypes(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const limited = (value: string | undefined, max: number): string | undefined => value?.slice(0, max)
const limitedString = (value: unknown, max: number): string | undefined => limited(string(value), max)
const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

function contentBody(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  const body = record(value)?.body
  return typeof body === 'string' ? body.trim() || undefined : undefined
}

function websiteUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined
  } catch {
    return undefined
  }
}

function titleFromContent(content: string | undefined): string | undefined {
  const first = content?.split('\n').find((line) => line.trim().length > 0)?.replace(/^#+\s*/, '').trim()
  return first === undefined || first.length === 0 ? undefined : first.slice(0, 160)
}
