import { useEffect, useMemo, useState } from 'react'
import { RefreshIcon } from '@hugeicons/core-free-icons'
import { CONTEXT_FILE_NAMES, type ContextFile, type ContextFileName, type ContextFiles } from '@manor/contracts'
import type { Notice } from '../../state'
import { useRequest, type RequestEvents } from '../../useRequest'
import { Icon } from '../Icon'
import { Button } from '../ui/Button'
import { RequestNotice } from '../ui/RequestNotice'
import { TextEditor, sourceTextExtensions } from '../ui/TextEditor'
import { SaveBar, SettingsPage, useUnsavedGuard } from './SettingsLayout'

/** How often an open page looks at the disk, so an outside edit shows up while it is open. */
const POLL_MS = 4_000

/** One file as it is being edited: the text, the disk version it started from, and what a save in flight sent. */
interface Draft {
  text: string
  base: string
  baseContent: string
  sent?: string
}

const draftOf = (file: ContextFile): Draft => ({ text: file.content, base: file.hash, baseContent: file.content })

/**
 * Brings each draft up to what the disk now says without ever dropping typed text: a
 * clean draft follows the disk, a draft that already says what the disk says (its own
 * save landing) takes the new version, a draft typed past its own save takes that save
 * as its base, and any other dirty one keeps its text. The conflict is then visible as
 * a dirty draft whose base is no longer the disk's version.
 */
export function reconcileDrafts(drafts: Partial<Record<ContextFileName, Draft>>, files: readonly ContextFile[]) {
  let changed = false
  const next = { ...drafts }
  for (const file of files) {
    const draft = next[file.name]
    if (draft !== undefined && draft.base === file.hash) continue
    if (draft === undefined || draft.text === file.content || draft.text === draft.baseContent) {
      next[file.name] = draftOf(file)
      changed = true
    } else if (draft.sent === file.content) {
      next[file.name] = { text: draft.text, base: file.hash, baseContent: file.content }
      changed = true
    }
  }
  return changed ? next : drafts
}

const ESTIMATED_CHARS_PER_TOKEN = 4

/**
 * The standing instructions every coding CLI on this Mac reads, edited where they live.
 * Nothing is copied into Manor: a save writes the file in the memory folder, and a
 * save over a file that changed on disk since it was opened is refused, never merged.
 */
export function ContextFilesPage({ files, notice, requestEvents, onRequest, onSave, onDismissNotice, onDirtyChange }: {
  /** Null until the first read lands. */
  files: ContextFiles | null
  notice: Notice | null
  requestEvents: RequestEvents
  onRequest: () => void
  onSave: (name: ContextFileName, content: string, baseHash: string, requestId: string) => boolean
  onDismissNotice: () => void
  onDirtyChange: (dirty: boolean) => void
}) {
  const request = useRequest(requestEvents)
  const [selected, setSelected] = useState<ContextFileName>('soul.md')
  const [drafts, setDrafts] = useState<Partial<Record<ContextFileName, Draft>>>({})
  const [offline, setOffline] = useState(false)

  // Read on the way in, again while open, and whenever the window comes back to the front.
  useEffect(() => {
    onRequest()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') onRequest()
    }, POLL_MS)
    window.addEventListener('focus', onRequest)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', onRequest)
    }
  }, [onRequest])

  useEffect(() => {
    if (files !== null) setDrafts((current) => reconcileDrafts(current, files.files))
  }, [files])

  const onDisk = useMemo(() => new Map(files?.files.map((file) => [file.name, file])), [files])
  const isDirty = (name: ContextFileName) => {
    const draft = drafts[name]
    return draft !== undefined && draft.text !== draft.baseContent
  }
  const anyDirty = CONTEXT_FILE_NAMES.some(isDirty)
  useUnsavedGuard(anyDirty, onDirtyChange)

  const disk = onDisk.get(selected)
  const draft = drafts[selected]
  const dirty = isDirty(selected)
  const conflict = dirty && disk !== undefined && draft !== undefined && disk.hash !== draft.base

  const save = (baseHash?: string) => {
    if (draft === undefined || disk === undefined) return
    setOffline(false)
    onDismissNotice()
    const base = baseHash ?? draft.base
    const name = selected
    const text = draft.text
    if (!request.start((requestId) => onSave(name, text, base, requestId))) {
      setOffline(true)
      return
    }
    // Typing may go on while this is in flight; the disk saying `text` is then this save.
    setDrafts((current) => {
      const own = current[name]
      return own === undefined ? current : { ...current, [name]: { ...own, sent: text } }
    })
  }

  const reloadTheirs = () => {
    if (disk === undefined) return
    setDrafts((current) => ({ ...current, [selected]: draftOf(disk) }))
  }

  const discard = () => {
    if (draft === undefined) return
    setDrafts((current) => ({ ...current, [selected]: { ...draft, text: draft.baseContent } }))
  }

  // The Save button's own rule, for ⌘S too: disabled clean, in conflict or in flight.
  const saveOpen = () => {
    if (dirty && !conflict && !request.pending) save()
  }

  const total = CONTEXT_FILE_NAMES.reduce((sum, name) => sum + (drafts[name]?.text.length ?? 0), 0)

  return (
    <SettingsPage
      title="Context files"
      description="Shared with Claude Code, Codex and Grok."
      {...(files?.root ? { onSaveShortcut: saveOpen } : {})}
    >
      {files === null ? (
        <p className="m-0 text-label text-dim">Reading the files…</p>
      ) : files.root === null ? (
        <p className="m-0 text-[14px] text-muted">
          This server has no memory folder, so there are no files here to edit.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Context file">
            {CONTEXT_FILE_NAMES.map((name) => {
              const present = onDisk.has(name)
              const current = name === selected
              return (
                <button
                  key={name}
                  type="button"
                  aria-pressed={current}
                  className={`flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border-0 px-3 text-label outline-none focus-visible:outline-2 focus-visible:outline-primary ${
                    current ? 'bg-user-bg text-text' : 'bg-transparent text-muted hover:bg-surface-2 hover:text-text'
                  }`}
                  onClick={() => setSelected(name)}
                >
                  {name}
                  {present ? null : <span className="text-dim">missing</span>}
                  {isDirty(name) ? <span aria-label="unsaved" className="h-1.5 w-1.5 rounded-full bg-warn-fill" /> : null}
                </button>
              )
            })}
          </div>

          {disk === undefined || draft === undefined ? (
            <p className="m-0 text-[14px] text-muted">{selected} is not on disk in {files.root}.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 text-label text-dim">
                <span className="min-w-0 truncate" title={`${files.root}/${selected}`}>{files.root}/{selected}</span>
                <span className="tabular-nums">
                  {draft.text.length.toLocaleString('en')} characters, about {Math.round(draft.text.length / ESTIMATED_CHARS_PER_TOKEN).toLocaleString('en')} tokens in every prompt
                </span>
              </div>

              {conflict ? (
                <div className="rounded-xl border border-line bg-surface-2 px-3.5 py-2.5" role="alert">
                  <p className="m-0 text-label leading-relaxed text-muted">
                    {selected} changed on disk while you were editing it. Your text is still here, so pick which one wins.
                  </p>
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <Button size="small" variant="primary" disabled={request.pending} onClick={() => save(disk.hash)}>
                      {request.pending ? 'Saving…' : 'Overwrite theirs'}
                    </Button>
                    <Button size="small" className="inline-flex items-center gap-1.5" onClick={reloadTheirs}>
                      <Icon icon={RefreshIcon} size={13} />
                      Reload theirs
                    </Button>
                  </div>
                </div>
              ) : null}

              <div className="min-h-[360px] rounded-xl border border-line px-4 py-3">
                <TextEditor
                  path={`context:${selected}`}
                  text={draft.text}
                  extensions={sourceTextExtensions(selected, { lineNumbers: false })}
                  onChange={(text) => setDrafts((current) => {
                    const own = current[selected]
                    return own === undefined ? current : { ...current, [selected]: { ...own, text } }
                  })}
                />
              </div>
              <p className="m-0 text-label text-dim tabular-nums">All five files: {total.toLocaleString('en')} characters.</p>
            </>
          )}
          {notice !== null ? (
            <RequestNotice notice={notice} onDismiss={onDismissNotice} />
          ) : offline ? (
            <p className="m-0 text-label text-danger" role="status">Nothing was sent, the connection is down. Try again once it is back.</p>
          ) : null}
        </div>
      )}
      {files?.root ? (
        <SaveBar
          dirty={dirty}
          pending={request.pending}
          canSave={!conflict}
          saveLabel={`Save ${selected}`}
          onSave={saveOpen}
          onDiscard={discard}
        />
      ) : null}
    </SettingsPage>
  )
}
