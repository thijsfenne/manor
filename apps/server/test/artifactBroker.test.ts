import type { MyMindArtifact } from '@manor/contracts'
import { describe, expect, it, vi } from 'vitest'
import { ArtifactBroker } from '../src/artifactBroker.js'
import type { MyMindClient } from '../src/mymind.js'

const artifact: MyMindArtifact = {
  id: 'object_1',
  title: 'Calm finance interface',
  kind: 'image',
  summary: 'Muted colors and generous whitespace.',
  imageUrl: '/internal/mymind-thumbnail/signed',
  tags: ['fintech'],
  spaces: ['space_1'],
  created: '2026-08-21T10:00:00.000Z',
  bumped: '2026-08-21T10:00:00.000Z',
}

const client = (): MyMindClient => ({
  async verify() {},
  async *list() {
    yield { objects: [artifact], spaces: [], hasMore: false }
  },
  search: vi.fn(async () => ({
    objects: [artifact],
    spaces: [{ id: 'space_1', name: 'Design inspiration' }],
    hasMore: false,
  })),
  inspect: vi.fn(async () => ({
    artifacts: [{
      artifact,
      preview: { bytes: Uint8Array.from([1, 2, 3]), contentType: 'image/png' },
    }],
    spaces: [{ id: 'space_1', name: 'Design inspiration' }],
  })),
  fetchThumbnail: vi.fn(async () => undefined),
})

describe('ArtifactBroker', () => {
  it('returns compact semantic candidates before any pixels are requested', async () => {
    const mymind = client()
    const result = await new ArtifactBroker(mymind).request('artifact_search', {
      query: 'calm dashboard inspiration',
    })

    expect(mymind.search).toHaveBeenCalledWith('calm dashboard inspiration')
    expect(result).toMatchObject({
      artifacts: [{
        id: 'object_1',
        title: 'Calm finance interface',
        spaces: ['Design inspiration'],
        hasPreview: true,
      }],
    })
    expect(JSON.stringify(result)).not.toContain('AQID')
  })

  it('returns actual preview bytes only for explicitly inspected ids', async () => {
    const mymind = client()
    const result = await new ArtifactBroker(mymind).request('artifact_view', { ids: ['object_1'] })

    expect(mymind.inspect).toHaveBeenCalledWith(['object_1'])
    expect(result).toMatchObject({
      artifacts: [{
        id: 'object_1',
        preview: { mimeType: 'image/png', data: 'AQID' },
      }],
    })
  })

  it('rejects broad or malformed calls before spending mymind credits', async () => {
    const mymind = client()
    const broker = new ArtifactBroker(mymind)

    await expect(broker.request('artifact_search', { query: '' })).rejects.toThrow('needs a query')
    await expect(broker.request('artifact_view', { ids: Array.from({ length: 5 }, (_, index) => String(index)) }))
      .rejects.toThrow('one to four')
    expect(mymind.search).not.toHaveBeenCalled()
    expect(mymind.inspect).not.toHaveBeenCalled()
  })
})
