import { RefreshIcon } from '@hugeicons/core-free-icons'
import type { LocalServer } from '@manor/contracts'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { IconButton } from './ui/IconButton'

/**
 * A blank tab's page: the web servers running on this Mac, one click from opening.
 * Loads once when the tab shows it and again on refresh; nothing polls.
 */
export function BrowserLocalServers({ load, disabled, onOpen }: {
  load: () => Promise<LocalServer[]>
  disabled: boolean
  onOpen(url: string): void
}) {
  const headingId = useId()
  const [servers, setServers] = useState<LocalServer[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const request = useRef(0)

  const refresh = useCallback(() => {
    const current = ++request.current
    setBusy(true)
    setError(null)
    void load().then(
      (next) => { if (request.current === current) setServers(next) },
      (reason: unknown) => { if (request.current === current) setError(reason instanceof Error ? reason.message : String(reason)) },
    ).finally(() => { if (request.current === current) setBusy(false) })
  }, [load])

  useEffect(() => {
    refresh()
    return () => { request.current += 1 }
  }, [refresh])

  return (
    <section aria-labelledby={headingId} className="h-full overflow-y-auto">
      <div className="mx-auto w-full max-w-[680px] px-4 py-5">
        <div className="mb-2 flex items-center justify-between gap-2 pl-1">
          <h2 id={headingId} className="m-0 text-label font-medium text-muted">Local</h2>
          <IconButton icon={RefreshIcon} label="Refresh local servers" disabled={busy} onClick={refresh} />
        </div>
        {error !== null ? (
          <p role="alert" className="m-0 pl-1 text-label leading-relaxed text-danger">{error}</p>
        ) : servers === null ? (
          <p className="m-0 pl-1 text-label leading-relaxed text-dim">Looking for local servers…</p>
        ) : servers.length === 0 ? (
          <p className="m-0 pl-1 text-label leading-relaxed text-dim">No local servers running.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {servers.map((server) => (
              <li key={server.port}>
                <LocalServerRow server={server} disabled={disabled} onOpen={onOpen} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

function LocalServerRow({ server, disabled, onOpen }: { server: LocalServer; disabled: boolean; onOpen(url: string): void }) {
  const host = `localhost:${server.port}`
  return (
    <button type="button" disabled={disabled} onClick={() => onOpen(server.url)}
      className="flex w-full min-w-0 cursor-pointer items-center gap-3.5 rounded-xl border border-line bg-transparent p-2 text-left [font:inherit] text-text hover:bg-surface-2 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent">
      {/* A miniature of the page's window: it stands for a web page, so it stays page white in either theme. */}
      <span aria-hidden className="flex h-[52px] w-[80px] flex-none flex-col justify-center gap-0.5 overflow-hidden rounded-lg bg-page px-2 shadow-sm">
        <span className="mb-1 flex gap-[3px]">
          <span className="h-1 w-1 rounded-full bg-danger" />
          <span className="h-1 w-1 rounded-full bg-warn-fill" />
          <span className="h-1 w-1 rounded-full bg-ok" />
        </span>
        <span className="truncate text-[9px] leading-[11px] font-medium text-on-page">{server.title}</span>
        <span className="truncate text-[8px] leading-[10px] text-on-page/50">{host}</span>
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[15px] leading-5 font-medium">{server.title}</span>
        <span className="truncate text-label text-muted">{host}</span>
      </span>
      <span aria-hidden className="mr-2 h-2 w-2 flex-none rounded-full bg-ok ring-4 ring-ok/15" />
    </button>
  )
}
