import { Bookmark01Icon } from '@hugeicons/core-free-icons'
import type { BrowserBookmark } from '@manor/contracts'
import { IconButton } from './ui/IconButton'
import { Menu, useMenu } from './ui/Menu'

export function BrowserBookmarksMenu({ bookmarks, loading, error, disabled, onRetry, onOpen }: {
  bookmarks: BrowserBookmark[] | null
  loading: boolean
  error: string | null
  disabled: boolean
  onRetry(): void
  onOpen(url: string): void
}) {
  const [menu, trigger] = useMenu({ maxHeight: 360, minHeight: 180, minWidth: 320, disabled })

  return <>
    <IconButton ref={trigger} icon={Bookmark01Icon} label="Bookmarks"
      aria-haspopup="menu" aria-expanded={menu.open} disabled={disabled}
      onClick={menu.toggle} />
    <Menu menu={menu} label="Bookmarks">
      <p className="m-0 px-3 py-2 text-label font-medium text-text">Bookmarks</p>
      {error === null ? null : (
        <div className="px-3 py-2 text-meta text-danger" role="alert">
          <p className="m-0">{error}</p>
          <button type="button" role="menuitem" className="mt-1 cursor-pointer border-0 bg-transparent p-0 text-meta text-text underline-offset-2 hover:underline"
            onClick={onRetry}>Try again</button>
        </div>
      )}
      {bookmarks === null ? (
        error === null ? <p role="status" className="m-0 px-3 py-2 text-meta text-dim">
          {loading ? 'Loading bookmarks…' : 'No bookmarks available.'}
        </p> : null
      ) : bookmarks.length === 0 ? (
        <p className="m-0 px-3 py-2 text-meta text-dim">No bookmarks yet. Save a page with the star beside the address.</p>
      ) : bookmarks.map((bookmark) => (
        <button key={bookmark.url} type="button" role="menuitem"
          className="flex w-full min-w-0 flex-col rounded-button-sm border-0 bg-transparent px-3 py-2 text-left hover:bg-user-bg"
          onClick={() => { menu.close(); onOpen(bookmark.url) }}>
          <span className="w-full truncate text-label text-text">{bookmark.title || bookmark.url}</span>
          <span className="w-full truncate text-meta text-muted">{bookmark.url}</span>
        </button>
      ))}
    </Menu>
  </>
}
