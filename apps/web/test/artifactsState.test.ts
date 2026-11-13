import { describe, expect, it } from 'vitest'
import type { MyMindArtifact } from '@manor/contracts'
import { askMoreMyMindObjects, askMyMindObjects, emptyWorkspace, reduce } from '../src/state'

const artifact = (id: string): MyMindArtifact => ({
  id,
  title: id,
  kind: 'image',
  tags: [],
  spaces: [],
  created: '2026-08-24T00:00:00.000Z',
  bumped: '2026-08-24T00:00:00.000Z',
})

describe('Artifacts state', () => {
  it('distinguishes an unavailable host from a configured mymind connection', () => {
    expect(emptyWorkspace.artifacts.status).toBe('unknown')
    expect(reduce(emptyWorkspace, {
      type: 'mymind_status',
      available: false,
      env: [],
      problem: null,
      check: null,
    }).artifacts.status).toBe('none')
    expect(reduce(emptyWorkspace, {
      type: 'mymind_status',
      available: true,
      env: [],
      problem: null,
      check: null,
    }).artifacts.status).toBe('ready')
  })

  it('drops a slower result for the search the user already left', () => {
    const asked = askMyMindObjects(emptyWorkspace, 'new', 'request-new')
    const stale = reduce(asked, {
      type: 'mymind_objects',
      requestId: 'request-old',
      query: 'old',
      append: false,
      result: { status: 'ready', objects: [], spaces: [], hasMore: false },
    })
    expect(stale).toBe(asked)

    const landed = reduce(asked, {
      type: 'mymind_objects',
      requestId: 'request-new',
      query: 'new',
      append: false,
      result: { status: 'ready', objects: [], spaces: [], hasMore: false },
    })
    expect(landed.artifacts).toMatchObject({ query: 'new', askingQuery: null, error: null })
  })

  it('appends streamed pages once and keeps their order', () => {
    const asked = askMyMindObjects(emptyWorkspace, '', 'request-1')
    const first = reduce(asked, {
      type: 'mymind_objects',
      requestId: 'request-1',
      query: '',
      append: false,
      result: { status: 'ready', objects: [artifact('one'), artifact('two')], spaces: [], hasMore: true },
    })
    const loading = askMoreMyMindObjects(first, 'request-1')
    expect(loading.artifacts.loadingMore).toBe(true)

    const next = reduce(loading, {
      type: 'mymind_objects',
      requestId: 'request-1',
      query: '',
      append: true,
      result: { status: 'ready', objects: [artifact('two'), artifact('three')], spaces: [], hasMore: false },
    })
    expect(next.artifacts.objects.map(({ id }) => id)).toEqual(['one', 'two', 'three'])
    expect(next.artifacts).toMatchObject({ loadingMore: false, hasMore: false, error: null })
  })
})
