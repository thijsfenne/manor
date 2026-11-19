import { useEffect, useMemo, useRef, useState, type FormEvent, type MouseEvent } from 'react'
import { Cancel01Icon, Search01Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import {
  MAX_PAGE_CONTEXT_ATTACHMENTS,
  type MyMindArtifact,
  type MyMindArtifactKind,
  type MyMindSpace,
  type PageContextAttachment,
} from '@manor/contracts'
import type { ConnectionStatus } from '../../useWorkspace'
import { Icon } from '../Icon'
import { WorkspaceHeader } from '../WorkspaceHeader'
import { useHeaderRows } from '../TopBar'
import { SegmentedControl, type SegmentOption } from '../ui/SegmentedControl'
import { AddToChatButton, type ChatDestination } from './AddToChatButton'
import { ArtifactDetailDialog } from './ArtifactDetailDialog'
import { artifactBody, artifactContext, artifactContextId, formatDate, kindLabel, plainText } from './artifact'
import { artifactColumns, columnsFor } from './masonry'

export { artifactContext } from './artifact'

type Filter = 'all' | MyMindArtifactKind | 'spaces' | `space:${string}`
type ArtifactSection = Exclude<Filter, `space:${string}`>

const KIND_FILTERS: readonly SegmentOption<ArtifactSection>[] = [
  { value: 'all', label: 'All', tabId: 'artifacts-tab-all', panelId: 'artifacts-panel' },
  { value: 'image', label: 'Images', tabId: 'artifacts-tab-image', panelId: 'artifacts-panel' },
  { value: 'article', label: 'Articles', tabId: 'artifacts-tab-article', panelId: 'artifacts-panel' },
  { value: 'note', label: 'Notes', tabId: 'artifacts-tab-note', panelId: 'artifacts-panel' },
  { value: 'product', label: 'Products', tabId: 'artifacts-tab-product', panelId: 'artifacts-panel' },
  { value: 'spaces', label: 'Spaces', tabId: 'artifacts-tab-spaces', panelId: 'artifacts-panel' },
]

interface ArtifactsViewProps {
  objects: MyMindArtifact[]
  spaces: MyMindSpace[]
  query: string
  loading: boolean
  loadingMore: boolean
  hasMore: boolean
  error: string | null
  /** Where a selection may be sent, current chat first. Empty means nowhere yet. */
  destinations: readonly ChatDestination[]
  /** What the chat on screen already holds, which is what the cards mark. */
  attachedContexts: PageContextAttachment[]
  status: ConnectionStatus
  sidebarCollapsed: boolean
  /** Absent where there is no sidebar to bring back. */
  onToggleSidebar?: () => void
  onSearch: (query: string) => void
  onLoadMore: () => void
  onOpenSource: (url: string) => void
  onAddToChat: (contexts: PageContextAttachment[], destination: ChatDestination) => void
}

/** The mymind browse, inspect and hand-to-chat loop. The API remains the only store. */
export function ArtifactsView({
  objects,
  spaces,
  query,
  loading,
  loadingMore,
  hasMore,
  error,
  destinations,
  attachedContexts,
  status,
  sidebarCollapsed,
  onToggleSidebar,
  onSearch,
  onLoadMore,
  onOpenSource,
  onAddToChat,
}: ArtifactsViewProps) {
  const headerRows = useHeaderRows()
  const [search, setSearch] = useState(query)
  const [filter, setFilter] = useState<Filter>('all')
  const [selected, setSelected] = useState<Set<string>>(() => new Set())
  const [detailId, setDetailId] = useState<string | null>(null)
  const [gridWidth, setGridWidth] = useState(0)
  const requestedSearch = useRef(query)
  const searchTimer = useRef<number | null>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const resultsViewport = useRef<HTMLDivElement>(null)
  const loadMoreMarker = useRef<HTMLDivElement>(null)
  const attachedIds = useMemo(() => new Set(attachedContexts.map((context) => context.id)), [attachedContexts])

  useEffect(() => {
    const normalized = search.trim()
    if (normalized === requestedSearch.current) return
    searchTimer.current = window.setTimeout(() => {
      searchTimer.current = null
      requestedSearch.current = normalized
      onSearch(search)
    }, 250)
    return () => {
      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current)
      searchTimer.current = null
    }
  }, [onSearch, search])

  useEffect(() => {
    const root = resultsViewport.current
    const marker = loadMoreMarker.current
    if (root === null || marker === null || !hasMore || loading || loadingMore || error !== null) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting === true) onLoadMore()
      },
      { root, rootMargin: '640px 0px' },
    )
    observer.observe(marker)
    return () => observer.disconnect()
  }, [error, hasMore, loading, loadingMore, onLoadMore])

  // The grid's own width, not the window's: a sidebar folding away or a panel opening
  // changes how many columns fit without the viewport moving a pixel.
  useEffect(() => {
    const node = resultsViewport.current
    if (node === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? 0
      setGridWidth((current) => (Math.abs(current - width) < 1 ? current : width))
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  // A pick is a pick on something you can still see. Paging in keeps everything, so
  // this only ever fires on a search that replaced the library, and without it the
  // tray would hold ids for cards that are gone: full, unclearable, and unsendable.
  useEffect(() => {
    setSelected((current) => {
      if (current.size === 0) return current
      const present = new Set(objects.map((artifact) => artifact.id))
      const kept = new Set([...current].filter((id) => present.has(id)))
      return kept.size === current.size ? current : kept
    })
  }, [objects])

  const visible = useMemo(() => {
    if (filter === 'all' || filter === 'spaces') return objects
    if (filter.startsWith('space:')) {
      const spaceId = filter.slice('space:'.length)
      return objects.filter((artifact) => artifact.spaces.includes(spaceId))
    }
    return objects.filter((artifact) => artifact.kind === filter)
  }, [objects, filter])

  const columnCount = columnsFor(gridWidth)
  // Width is deliberately not an input: see `NOMINAL_COLUMN`. Only the column count
  // may move a card, so a sidebar folding away never reshuffles the wall.
  const columns = useMemo(() => artifactColumns(visible, columnCount), [visible, columnCount])

  const detail = objects.find((artifact) => artifact.id === detailId) ?? null
  const chosen = objects.filter((artifact) => selected.has(artifact.id))
  const chosenIds = chosen.map((artifact) => artifactContextId(artifact.id))
  // The tray counts what is actually still on screen. A selection kept as bare ids
  // through a search that replaced the library would show a full tray with nothing in
  // it: three of three picked, every checkbox refusing, and Add dead.
  const picked = chosen.length
  const section: ArtifactSection = filter.startsWith('space:') ? 'spaces' : (filter as ArtifactSection)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const normalized = search.trim()
    if (normalized === requestedSearch.current) return
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current)
    searchTimer.current = null
    requestedSearch.current = normalized
    onSearch(search)
  }

  const clearSearch = () => {
    if (search.length === 0) return
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current)
    searchTimer.current = null
    setSearch('')
    requestedSearch.current = ''
    onSearch('')
    searchInput.current?.focus({ preventScroll: true })
  }

  const toggle = (artifact: MyMindArtifact, event: MouseEvent) => {
    event.stopPropagation()
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(artifact.id)) next.delete(artifact.id)
      else if (next.size < MAX_PAGE_CONTEXT_ATTACHMENTS) next.add(artifact.id)
      return next
    })
  }

  const add = (destination: ChatDestination) => {
    if (chosen.length === 0) return
    onAddToChat(
      chosen.map((artifact) => artifactContext(artifact, spaces)),
      destination,
    )
    setSelected(new Set())
    setDetailId(null)
  }

  return (
    <section className={`relative grid min-h-0 min-w-0 ${headerRows} overflow-hidden bg-bg`}>
      <WorkspaceHeader
        section="artifacts"
        title="Artifacts"
        status={status}
        sidebarCollapsed={sidebarCollapsed}
        {...(onToggleSidebar === undefined ? {} : { onToggleSidebar })}
        accessoryGrow
        accessory={(
          <div className="flex min-w-0 items-center gap-3">
            <SegmentedControl
              label="Artifact type"
              options={KIND_FILTERS}
              value={section}
              onChange={setFilter}
            />
            <form className="ml-auto flex w-[clamp(180px,24vw,340px)] min-w-0 items-center" onSubmit={submit}>
              <div className="flex h-8 w-full items-center gap-2 rounded-lg border border-line bg-stage px-2.5 text-muted focus-within:border-dim">
                <Icon icon={Search01Icon} size={17} className="flex-none" />
                <input
                  ref={searchInput}
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search your artifacts"
                  aria-label="Search your artifacts"
                  className="min-w-0 flex-1 border-0 bg-transparent p-0 text-label text-text outline-none placeholder:text-dim"
                />
                {search.length === 0 ? null : (
                  <button
                    type="button"
                    aria-label="Clear artifact search"
                    title="Clear search"
                    className="grid h-6 w-6 flex-none cursor-pointer place-items-center rounded-md border-0 bg-transparent p-0 text-muted hover:bg-surface-2 hover:text-text"
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={clearSearch}
                  >
                    <Icon icon={Cancel01Icon} size={14} />
                  </button>
                )}
              </div>
            </form>
            {/* The cap, standing rather than appearing: a tray that fills up silently
                is a checkbox that stops working for no stated reason. */}
            <span
              className="hidden flex-none text-meta whitespace-nowrap text-muted lg:inline"
              aria-live="polite"
            >
              {selectionStatus(picked, attachedContexts.length)}
            </span>
            <AddToChatButton
              destinations={destinations}
              contextIds={chosenIds}
              emptyNote="Pick up to three artifacts first"
              onAdd={add}
            />
          </div>
        )}
      />

      <div
        id="artifacts-panel"
        role="tabpanel"
        aria-labelledby={`artifacts-tab-${section}`}
        className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]"
      >
        {section === 'spaces' ? (
          <div className="flex min-w-0 gap-1.5 overflow-x-auto border-b border-line px-6 pt-6 pb-2.5 lg:px-8">
            {spaces.map((space) => (
              <button
                key={space.id}
                type="button"
                onClick={() => setFilter(`space:${space.id}`)}
                className={`flex h-8 flex-none cursor-pointer items-center gap-1.5 rounded-chip border px-2.5 text-meta [font:inherit] ${
                  filter === `space:${space.id}`
                    ? 'border-primary bg-user-bg text-text'
                    : 'border-line bg-surface text-muted hover:text-text'
                }`}
              >
                {space.name}
              </button>
            ))}
          </div>
        ) : null}

        <div ref={resultsViewport} className="min-h-0 overflow-y-auto px-6 pt-8 pb-5 lg:px-8">
          {error !== null && objects.length === 0 ? (
            <div className="mx-auto mt-16 max-w-lg rounded-xl border border-line bg-raised p-5 text-center">
              <p className="m-0 text-label font-medium text-text">Artifacts could not be opened</p>
              <p className="mt-1 mb-0 text-label leading-5 text-muted">{error}</p>
              <button
                type="button"
                onClick={() => onSearch(search)}
                className="mt-4 h-9 cursor-pointer rounded-button border-0 bg-primary px-3 text-label font-medium text-on-primary"
              >
                Try again
              </button>
            </div>
          ) : loading && objects.length === 0 ? (
            <div className="grid h-full place-items-center text-label text-dim">Opening your artifacts…</div>
          ) : (
            <>
              {visible.length === 0 ? (
                <div className="grid min-h-48 place-items-center text-label text-dim">
                  {hasMore
                    ? 'Looking for matching artifacts…'
                    : query.length > 0
                      ? `Nothing found for “${query}”.`
                      : 'No artifacts in this view.'}
                </div>
              ) : (
                // Hand-filled columns, not CSS `columns`: see `masonry.ts` for why the
                // browser's own balancing cannot live next to an infinite scroll.
                <div className="flex items-start gap-3">
                  {columns.map((column, index) => (
                    <div key={index} className="flex min-w-0 flex-1 flex-col gap-3">
                      {column.map((artifact) => (
                        <ArtifactCard
                          key={artifact.id}
                          artifact={artifact}
                          selected={selected.has(artifact.id)}
                          attached={attachedIds.has(artifactContextId(artifact.id))}
                          selectionFull={picked >= MAX_PAGE_CONTEXT_ATTACHMENTS}
                          onOpen={() => setDetailId(artifact.id)}
                          onToggle={toggle}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              )}
              {hasMore || loadingMore || (error !== null && objects.length > 0) ? (
                <div
                  ref={loadMoreMarker}
                  className="flex min-h-14 items-center justify-center pt-2 text-meta text-dim"
                  aria-live="polite"
                >
                  {loadingMore ? (
                    'Loading more artifacts…'
                  ) : error !== null ? (
                    <button
                      type="button"
                      className="h-8 cursor-pointer rounded-button-sm border border-line bg-surface px-3 text-label text-text hover:bg-surface-2"
                      onClick={() => onSearch(search)}
                    >
                      Reload artifacts
                    </button>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>

      {detail === null ? null : (
        <ArtifactDetailDialog
          key={detail.id}
          artifact={detail}
          spaces={spaces.filter((space) => detail.spaces.includes(space.id))}
          destinations={destinations}
          attached={attachedIds.has(artifactContextId(detail.id))}
          otherSelection={chosen.some((artifact) => artifact.id !== detail.id)}
          onClose={() => setDetailId(null)}
          onOpenSource={onOpenSource}
          onAdd={(destination) => {
            onAddToChat([artifactContext(detail, spaces)], destination)
            setDetailId(null)
          }}
        />
      )}
    </section>
  )
}

function ArtifactCard({
  artifact,
  selected,
  attached,
  selectionFull,
  onOpen,
  onToggle,
}: {
  artifact: MyMindArtifact
  selected: boolean
  attached: boolean
  selectionFull: boolean
  onOpen: () => void
  onToggle: (artifact: MyMindArtifact, event: MouseEvent) => void
}) {
  const [imageFailed, setImageFailed] = useState(false)
  const hasImage = artifact.imageUrl !== undefined && !imageFailed
  // Only a card with nothing to look at keeps its words: everywhere else the picture
  // is the thing being recognised and a paragraph under it is a second one to read.
  const excerpt = hasImage ? undefined : artifactBody(artifact)
  return (
    <article className="group relative break-inside-avoid overflow-hidden rounded-xl border border-line bg-surface transition-colors hover:border-dim">
      <button
        type="button"
        aria-label={attached ? `${artifact.title} is already in chat` : `${selected ? 'Deselect' : 'Select'} ${artifact.title}`}
        aria-pressed={selected}
        disabled={!selected && selectionFull}
        title={
          attached
            ? 'Already in this chat'
            : !selected && selectionFull
              ? `Up to ${MAX_PAGE_CONTEXT_ATTACHMENTS} source attachments per message`
              : undefined
        }
        onClick={(event) => onToggle(artifact, event)}
        // Off state hidden outright, not merely emptied: a permanent grid of grey
        // squares over the artwork spends the one thing this view is for.
        className={`absolute top-2 left-2 z-[1] grid h-6 w-6 cursor-pointer place-items-center rounded-lg border text-meta duration-150 ease-fade disabled:cursor-default motion-safe:transition-opacity ${
          selected ? 'border-primary bg-primary text-on-primary' : 'border-line bg-raised/90 text-dim'
        } ${
          selected || attached
            ? 'opacity-100'
            : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
        }`}
      >
        {selected || attached ? <Icon icon={Tick02Icon} size={13} strokeWidth={2.2} /> : null}
      </button>
      <button type="button" className="block w-full cursor-pointer border-0 bg-transparent p-0 text-left" onClick={onOpen}>
        {!hasImage ? null : (
          <img
            src={artifact.imageUrl}
            alt=""
            loading="lazy"
            width={artifact.imageWidth}
            height={artifact.imageHeight}
            onError={() => setImageFailed(true)}
            className="block h-auto max-h-[520px] w-full object-cover"
          />
        )}
        <div className={`${hasImage ? '' : 'pt-12'} p-3`}>
          <h2 className="m-0 text-label leading-5 font-medium text-text">{artifact.title}</h2>
          {excerpt === undefined ? null : (
            <p className="mt-1.5 mb-0 line-clamp-6 text-meta leading-[1.55] whitespace-pre-line text-muted">
              {plainText(excerpt)}
            </p>
          )}
          <div className="mt-2 flex items-center justify-between gap-2 text-meta text-dim">
            <span>{kindLabel(artifact.kind)}</span>
            <span>{formatDate(artifact.bumped)}</span>
          </div>
        </div>
      </button>
    </article>
  )
}

const selectionStatus = (selected: number, attached: number): string => {
  const tray = `${selected} / ${MAX_PAGE_CONTEXT_ATTACHMENTS} selected`
  return attached > 0 ? `${tray}, ${attached} in chat` : tray
}
