import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createMyMindClient, signMyMindRequest } from '../src/mymind.js'

const config = {
  keyId: 'key_123',
  secret: Buffer.from('0123456789abcdef').toString('base64'),
}

const decode = (part: string): unknown => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))

describe('mymind request signing', () => {
  it('binds a short-lived HS256 token to the method and path', () => {
    const token = signMyMindRequest(config, 'get', '/objects', 1_700_000_000)
    const [header, payload, signature] = token.split('.')
    if (header === undefined || payload === undefined || signature === undefined) throw new Error('expected a JWT')

    expect(decode(header)).toEqual({ alg: 'HS256', kid: 'key_123' })
    expect(decode(payload)).toEqual({ method: 'GET', path: '/objects', iat: 1_700_000_000, exp: 1_700_000_300 })
    expect(signature).toBe(
      createHmac('sha256', Buffer.from(config.secret, 'base64'))
        .update(`${header}.${payload}`)
        .digest('base64url'),
    )
  })
})

describe('the read-only mymind client', () => {
  it('verifies credentials through spaces without spending a search request', async () => {
    const paths: string[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      paths.push(new URL(input.toString()).pathname)
      return Response.json([{ id: 'space_1', name: 'Inspiration' }])
    }) as unknown as typeof fetch

    await createMyMindClient(config, fetcher).verify()

    expect(paths).toEqual(['/spaces'])
  })

  it('signs the path without its query and projects objects into the browser-safe contract', async () => {
    const requests: { url: URL; authorization: string; accept: string }[] = []
    const rawObjects = [{
      id: 'object_1',
      title: 'A useful reference',
      summary: 'Short summary',
      content: { body: 'Longer **markdown** body' },
      notes: [{ content: { body: 'My note' } }],
      source: { url: 'https://example.com/article' },
      screenshot: { path: 'private/screenshot-key', width: 1200, height: 800 },
      mainEntity: { '@type': ['Article', 'WebPage'] },
      tags: [{ name: 'Research' }],
      spaces: [{ id: 'space_1' }],
      created: '2026-08-20T10:00:00.000Z',
      bumped: '2026-08-21T10:00:00.000Z',
    }, ...Array.from({ length: 60 }, (_, index) => ({
      id: `object_${index + 2}`,
      title: `Artifact ${index + 2}`,
      created: '2026-08-19T10:00:00.000Z',
      bumped: '2026-08-19T10:00:00.000Z',
    }))]
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input.toString())
      const headers = new Headers(init?.headers)
      requests.push({
        url,
        authorization: headers.get('authorization') ?? '',
        accept: headers.get('accept') ?? '',
      })
      if (url.pathname === '/objects/object_1/thumbnail') {
        return new Response(Uint8Array.from([1, 2, 3]), {
          status: 200,
          headers: { 'content-type': 'image/webp' },
        })
      }
      const body = url.pathname === '/spaces'
        ? JSON.stringify([{ id: 'space_1', name: 'Inspiration', color: '#123456' }])
        : rawObjects.map((object) => JSON.stringify(object)).join('\n')
      return new Response(body, {
        status: 200,
        headers: { 'content-type': url.pathname === '/spaces' ? 'application/json' : 'application/jsonl' },
      })
    }) as unknown as typeof fetch

    const pages = []
    for await (const page of createMyMindClient(config, fetcher).list('useful reference')) pages.push(page)
    const listing = pages[0]
    if (listing === undefined) throw new Error('expected a first page')

    expect(requests.map(({ url }) => url.pathname)).toEqual(['/objects', '/spaces'])
    expect(requests[0]?.url.searchParams.get('q')).toBe('useful reference')
    expect(requests[0]?.url.searchParams.get('contentAs')).toBe('text/markdown')
    expect(requests[0]?.url.searchParams.has('limit')).toBe(false)
    expect(requests[0]?.accept).toBe('application/jsonl')
    const token = requests[0]?.authorization.replace('Bearer ', '').split('.')[1]
    expect(token === undefined ? undefined : decode(token)).toMatchObject({ method: 'GET', path: '/objects' })
    expect(listing.objects[0]).toEqual({
        id: 'object_1',
        title: 'A useful reference',
        kind: 'article',
        summary: 'Short summary',
        content: 'Longer **markdown** body',
        note: 'My note',
        url: 'https://example.com/article',
        imageUrl: expect.stringMatching(/^\/internal\/mymind-thumbnail\//),
        imageWidth: 1200,
        imageHeight: 800,
        tags: ['Research'],
        spaces: ['space_1'],
        created: '2026-08-20T10:00:00.000Z',
        bumped: '2026-08-21T10:00:00.000Z',
    })
    expect(listing.objects).toHaveLength(60)
    expect(listing.spaces).toEqual([{ id: 'space_1', name: 'Inspiration', color: '#123456' }])
    expect(listing.hasMore).toBe(true)
    expect(pages[1]).toMatchObject({ hasMore: false, objects: [{ id: 'object_61' }] })

    const thumbnailUrl = listing.objects[0]?.imageUrl
    if (thumbnailUrl === undefined) throw new Error('expected a thumbnail capability')
    await expect(createMyMindClient(config, fetcher).fetchThumbnail(`${thumbnailUrl}tampered`)).resolves.toBeUndefined()
    await expect(createMyMindClient(config, fetcher).fetchThumbnail(thumbnailUrl)).resolves.toEqual({
      bytes: Uint8Array.from([1, 2, 3]),
      contentType: 'image/webp',
    })
    expect(requests.at(-1)?.url.pathname).toBe('/objects/object_1/thumbnail')
    expect(requests.at(-1)?.url.searchParams.get('size')).toBe('1200x1200')
  })

  it('does not include credentials in an API error', async () => {
    const fetcher = vi.fn(async () => new Response(
      JSON.stringify({ detail: 'Signature rejected' }),
      { status: 401, statusText: 'Unauthorized', headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch

    await expect(createMyMindClient(config, fetcher).list().next()).rejects.toThrow('mymind answered 401: Signature rejected')
    await expect(createMyMindClient(config, fetcher).list().next()).rejects.not.toThrow(config.secret)
  })

  it('uses semantic search, preserves relevance order and returns real preview pixels for inspection', async () => {
    const requests: URL[] = []
    const objects = [
      {
        id: 'object_2',
        title: 'Dense editorial dashboard',
        summary: 'A compact dashboard with strong hierarchy.',
        screenshot: { width: 900, height: 700 },
        mainEntity: { '@type': 'Screenshot' },
        tags: [{ name: 'dashboard' }],
        spaces: [{ id: 'space_1' }],
        created: '2026-08-20T10:00:00.000Z',
        bumped: '2026-08-20T10:00:00.000Z',
      },
      {
        id: 'object_1',
        title: 'Calm finance interface',
        summary: 'Muted colors and generous whitespace.',
        blob: { type: 'image/png', width: 1000, height: 800 },
        tags: [{ name: 'fintech' }],
        spaces: [{ id: 'space_1' }],
        created: '2026-08-21T10:00:00.000Z',
        bumped: '2026-08-21T10:00:00.000Z',
      },
    ]
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(input.toString())
      requests.push(url)
      if (url.pathname === '/search') {
        return Response.json({ matches: [{ id: 'object_1', score: 0.9 }, { id: 'object_2', score: 0.8 }] })
      }
      if (url.pathname === '/spaces') return Response.json([{ id: 'space_1', name: 'Design inspiration' }])
      if (url.pathname === '/objects') return Response.json(objects)
      if (url.pathname === '/objects/object_1/thumbnail') {
        return new Response(Uint8Array.from([1, 2, 3]), { headers: { 'content-type': 'image/png' } })
      }
      if (url.pathname === '/objects/object_2/thumbnail') return new Response('', { status: 422 })
      return new Response('', { status: 404 })
    }) as unknown as typeof fetch
    const client = createMyMindClient(config, fetcher)

    const search = await client.search('calm dashboard inspiration')
    const inspection = await client.inspect(['object_1', 'object_2'])

    expect(requests[0]?.pathname).toBe('/search')
    expect(requests[0]?.searchParams.get('semantic')).toBe('true')
    expect(requests[0]?.searchParams.get('limit')).toBe('12')
    expect(search.objects.map(({ id }) => id)).toEqual(['object_1', 'object_2'])
    expect(search.spaces).toEqual([{ id: 'space_1', name: 'Design inspiration' }])
    const objectRequest = requests.find(({ pathname }) => pathname === '/objects')
    expect(objectRequest?.searchParams.getAll('id')).toEqual(['object_1', 'object_2'])
    expect(inspection.artifacts[0]?.preview).toEqual({
      bytes: Uint8Array.from([1, 2, 3]),
      contentType: 'image/png',
    })
    expect(inspection.artifacts[1]?.preview).toBeUndefined()
    expect(requests.find(({ pathname }) => pathname === '/objects/object_1/thumbnail')?.searchParams.get('size'))
      .toBe('900x900')
  })
})
