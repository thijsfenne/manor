import type { MyMindArtifact, MyMindSpace } from '@manor/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { artifactContext, ArtifactsView } from '../src/components/artifacts/ArtifactsView'

const destinations = [{ id: 'chat_1', kind: 'chat' as const, label: 'Sage', detail: 'Current', usedIds: [] }]

const artifact: MyMindArtifact = {
  id: 'object_1',
  title: 'A useful reference',
  kind: 'article',
  summary: 'A concise summary.',
  note: 'Remember this part.',
  url: 'https://example.com/article',
  tags: ['Research'],
  spaces: ['space_1'],
  created: '2026-08-20T10:00:00.000Z',
  bumped: '2026-08-21T10:00:00.000Z',
}
const spaces: MyMindSpace[] = [{ id: 'space_1', name: 'Inspiration' }]

describe('Artifacts', () => {
  it('turns an explicit selection into existing chat context instead of a second attachment system', () => {
    expect(artifactContext(artifact, spaces)).toEqual({
      id: 'mymind:object_1',
      kind: 'artifact',
      url: 'https://example.com/article',
      title: 'A useful reference',
      label: 'Article from mymind',
      text: 'A concise summary.\n\nRemember this part.\n\nTags: Research\n\nSpaces: Inspiration',
      html: '',
    })
  })

  it('shows browse controls and explains why Add to chat is unavailable with nothing picked', () => {
    const html = renderToStaticMarkup(
      <ArtifactsView
        objects={[artifact]}
        spaces={spaces}
        query=""
        loading={false}
        loadingMore={false}
        hasMore={false}
        error={null}
        destinations={[]}
        attachedContexts={[]}
        status="live"
        sidebarCollapsed={false}
        onToggleSidebar={() => {}}
        onSearch={() => {}}
        onLoadMore={() => {}}
        onOpenSource={() => {}}
        onAddToChat={() => {}}
      />,
    )

    expect(html).toContain('Search your artifacts')
    expect(html).toContain('>Spaces<')
    expect(html).toContain('>A useful reference<')
    expect(html).toContain('Pick up to three artifacts first')
    expect(html).toContain('0 / 3 selected')
    expect(html).toContain('disabled=""')
    expect(html).not.toContain('Clear artifact search')
  })

  it('names the chat the button will actually open', () => {
    const html = renderToStaticMarkup(
      <ArtifactsView
        objects={[artifact]}
        spaces={spaces}
        query=""
        loading={false}
        loadingMore={false}
        hasMore={false}
        error={null}
        destinations={destinations}
        attachedContexts={[]}
        status="live"
        sidebarCollapsed={false}
        onToggleSidebar={() => {}}
        onSearch={() => {}}
        onLoadMore={() => {}}
        onOpenSource={() => {}}
        onAddToChat={() => {}}
      />,
    )

    // Nothing is picked yet, so the face stays generic rather than promising a room.
    expect(html).toContain('Add to chat')
    expect(html).toContain('Choose which chat to add to')
  })

  it('offers a clear control while a search is active', () => {
    const html = renderToStaticMarkup(
      <ArtifactsView
        objects={[artifact]}
        spaces={spaces}
        query="research"
        loading={false}
        loadingMore={false}
        hasMore={false}
        error={null}
        destinations={destinations}
        attachedContexts={[]}
        status="live"
        sidebarCollapsed={false}
        onToggleSidebar={() => {}}
        onSearch={() => {}}
        onLoadMore={() => {}}
        onOpenSource={() => {}}
        onAddToChat={() => {}}
      />,
    )

    expect(html).toContain('value="research"')
    expect(html).toContain('Clear artifact search')
  })

  it('shows progress while the next infinite-scroll page is loading', () => {
    const html = renderToStaticMarkup(
      <ArtifactsView
        objects={[artifact]}
        spaces={spaces}
        query=""
        loading={false}
        loadingMore
        hasMore
        error={null}
        destinations={destinations}
        attachedContexts={[]}
        status="live"
        sidebarCollapsed={false}
        onToggleSidebar={() => {}}
        onSearch={() => {}}
        onLoadMore={() => {}}
        onOpenSource={() => {}}
        onAddToChat={() => {}}
      />,
    )

    expect(html).toContain('Loading more artifacts')
  })

  it('marks an artifact already attached to the current chat', () => {
    const context = artifactContext(artifact, spaces)
    const html = renderToStaticMarkup(
      <ArtifactsView
        objects={[artifact]}
        spaces={spaces}
        query=""
        loading={false}
        loadingMore={false}
        hasMore={false}
        error={null}
        destinations={destinations}
        attachedContexts={[context]}
        status="live"
        sidebarCollapsed={false}
        onToggleSidebar={() => {}}
        onSearch={() => {}}
        onLoadMore={() => {}}
        onOpenSource={() => {}}
        onAddToChat={() => {}}
      />,
    )

    expect(html).toContain('0 / 3 selected · 1 in chat')
    expect(html).toContain('A useful reference is already in chat')
  })
})
