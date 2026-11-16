import { ArrowLeft01Icon, ArrowRight01Icon, Cancel01Icon, Download04Icon } from '@hugeicons/core-free-icons'
import { describeBytes } from '@manor/client-runtime/attachments'
import { dmFileReadsAs, dmFileTypeLabel } from '@manor/client-runtime/dm-files'
import type { DmFile } from '@manor/contracts'
import { motion, useReducedMotion } from 'motion/react'
import { lazy, Suspense, useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type TouchEvent } from 'react'
import { createPortal } from 'react-dom'
import { saveDmFile } from '../../dmFileActions'
import { EASE_OUT, INSTANT } from '../../motion'
import { useStageTheme, wrappedPage } from '../DeliveredFiles'
import { FileMark } from '../fileMark'
import { Icon } from '../Icon'
import { Markdown } from '../Markdown'
import { FileThumb } from './FileThumb'

export interface FileViewerProps {
  /** The library's current filter, newest first. May hold unavailable files (no src). */
  files: readonly DmFile[]
  index: number
  onIndex: (index: number) => void
  onClose: () => void
}

type OnFail = (failed: boolean) => void

/** If the chunk itself cannot load, the PDF falls back to its card like any failed render. */
function PdfChunkMissing({ onFail }: { onFail: OnFail }) {
  useEffect(() => onFail(true), [onFail])
  return null
}
const PdfPages = lazy(() => import('./PdfPages').catch(() => ({ default: PdfChunkMissing })))

/** What Tab may land on inside the viewer, links in a read document included; it rings through these and never leaves. */
const FOCUSABLE = 'a[href], button:not(:disabled), video, iframe, [tabindex]:not([tabindex="-1"])'
/** A touch that travels this far sideways, and mostly sideways, steps to the next file. */
const SWIPE_PX = 48
/** The keys a delivered page hands back to the viewer. */
const PAGE_KEYS = ['Escape', 'ArrowLeft', 'ArrowRight'] as const
type PageKey = (typeof PAGE_KEYS)[number]

const roundButton = 'grid h-9 w-9 flex-none cursor-pointer place-items-center rounded-full border-0 bg-on-media/10 text-on-media [font:inherit] hover:bg-on-media/15 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-on-media/10'

/**
 * A DM's file library over the whole window: the open file on a dark stage, its title
 * and actions on top, a strip of every file in the current filter below. The stage is
 * dark in both themes, built from the media tokens and a dimmed backdrop rather than a
 * colour of its own. The parent mounts it on open, unmounts it on close and owns
 * `index`; arrows, a swipe and the strip all ask for a new one through `onIndex`.
 */
export function FileViewer({ files, index, onIndex, onClose }: FileViewerProps) {
  const reduce = useReducedMotion() ?? false
  const dialogRef = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const currentThumbRef = useRef<HTMLButtonElement>(null)
  const thumbsScrolled = useRef(false)
  const touchFrom = useRef<{ x: number; y: number } | null>(null)
  const [saveError, setSaveError] = useState<{ id: string; message: string } | null>(null)
  const at = Math.min(Math.max(index, 0), files.length - 1)
  const file = files[at]
  const count = files.length

  // Same contract as the dialog shell: focus moves in on arrival and returns to the row
  // that opened the viewer, so a keyboard user lands back in the library.
  useEffect(() => {
    const opener = document.activeElement
    closeRef.current?.focus()
    return () => {
      if (opener instanceof HTMLElement) opener.focus()
    }
  }, [])

  // The open file's thumbnail stays in view; the first placement jumps, later steps glide.
  useEffect(() => {
    currentThumbRef.current?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: reduce || !thumbsScrolled.current ? 'auto' : 'smooth' })
    thumbsScrolled.current = true
  }, [at, reduce])

  const step = (by: -1 | 1) => {
    const next = Math.min(count - 1, Math.max(0, at + by))
    if (next === at) return
    // The arrow that reaches an end turns disabled and would drop focus out of the
    // viewer, taking the keys with it; the viewer keeps focus instead.
    const active = document.activeElement
    if ((next === 0 || next === count - 1) && active instanceof HTMLElement && active.dataset.step !== undefined) dialogRef.current?.focus()
    onIndex(next)
  }

  const download = async (target: DmFile) => {
    setSaveError(null)
    const message = await saveDmFile(target)
    if (message !== null) setSaveError({ id: target.id, message })
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // A picture enlarged from a read document is a layer of its own: its keys stay its own.
    if (event.defaultPrevented) return
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
      return
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      step(event.key === 'ArrowLeft' ? -1 : 1)
      return
    }
    if (event.key !== 'Tab') return
    event.preventDefault()
    const stops = [...dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []]
    const from = stops.indexOf(document.activeElement as HTMLElement)
    const next = stops[(from + (event.shiftKey ? -1 : 1) + stops.length) % stops.length] ?? closeRef.current
    next?.focus()
  }

  const handleTouchStart = (event: TouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0]
    touchFrom.current = event.touches.length === 1 && touch !== undefined ? { x: touch.clientX, y: touch.clientY } : null
  }
  const handleTouchEnd = (event: TouchEvent<HTMLDivElement>) => {
    const from = touchFrom.current
    const touch = event.changedTouches[0]
    touchFrom.current = null
    if (from === null || touch === undefined) return
    const dx = touch.clientX - from.x
    if (Math.abs(dx) > SWIPE_PX && Math.abs(dx) > 2 * Math.abs(touch.clientY - from.y)) step(dx < 0 ? 1 : -1)
  }

  return createPortal(
    <motion.div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={file === undefined ? 'Files' : `${file.name}, ${at + 1} of ${count}`}
      tabIndex={-1}
      className="fixed inset-0 z-20 flex flex-col bg-media-scrim text-on-media outline-none backdrop-blur-md backdrop-brightness-40"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={reduce ? INSTANT : { duration: 0.18, ease: EASE_OUT }}
      onKeyDown={handleKeyDown}
    >
      <header className="relative flex h-19 flex-none items-center justify-center px-40">
        {file === undefined ? null : (
          <h2 className="m-0 min-w-0 max-w-full truncate rounded-full bg-on-media/10 px-3.5 py-1.5 text-[13px] font-medium" title={file.name}>
            {file.name}
          </h2>
        )}
        <div className="absolute top-5 right-5 flex items-center gap-2">
          {/* Held for one more round action of the same size. */}
          <span className="h-9 w-9 flex-none" aria-hidden="true" />
          <button
            type="button"
            aria-label="Download"
            title="Download"
            className={roundButton}
            disabled={file?.src === undefined}
            onClick={() => {
              if (file !== undefined) void download(file)
            }}
          >
            <Icon icon={Download04Icon} size={16} />
          </button>
          <button ref={closeRef} type="button" aria-label="Close" title="Close" className={roundButton} onClick={onClose}>
            <Icon icon={Cancel01Icon} size={16} />
          </button>
        </div>
        {saveError !== null && saveError.id === file?.id ? (
          <p role="alert" className="absolute top-16 right-5 m-0 max-w-80 text-right text-meta text-on-media/70">{saveError.message}</p>
        ) : null}
      </header>

      <div className="relative min-h-0 flex-1" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
        {file === undefined ? null : <FileBody key={file.id} file={file} onDownload={() => void download(file)} onPageKey={(key) => (key === 'Escape' ? onClose() : step(key === 'ArrowLeft' ? -1 : 1))} />}
        {count > 1 ? (
          <>
            <button type="button" data-step aria-label="Previous file" title="Previous" disabled={at === 0} className={`${roundButton} absolute top-1/2 left-5 -translate-y-1/2`} onClick={() => step(-1)}>
              <Icon icon={ArrowLeft01Icon} size={16} />
            </button>
            <button type="button" data-step aria-label="Next file" title="Next" disabled={at === count - 1} className={`${roundButton} absolute top-1/2 right-5 -translate-y-1/2`} onClick={() => step(1)}>
              <Icon icon={ArrowRight01Icon} size={16} />
            </button>
          </>
        ) : null}
      </div>

      {file === undefined ? null : (
        <p className="m-0 flex flex-none justify-center gap-2.5 px-6 pt-3 text-[13px] text-on-media/70">
          <span className="min-w-0 truncate">{file.name}</span>
          <span className="flex-none tabular-nums text-on-media/50">{`${at + 1} / ${count}`}</span>
        </p>
      )}

      {/* The bottom 64px stay clear for a message box under the strip. */}
      <div className="flex-none overflow-x-auto overscroll-contain px-6 pt-3 pb-16 [scrollbar-width:none]">
        <div className="mx-auto flex w-max gap-1.5 p-0.5">
          {files.map((item, position) => (
            <button
              key={item.id}
              ref={position === at ? currentThumbRef : undefined}
              type="button"
              aria-label={item.name}
              aria-current={position === at ? 'true' : undefined}
              className={`flex-none cursor-pointer rounded-lg border-0 bg-transparent p-0 [font:inherit] motion-safe:transition-opacity ${
                position === at ? 'opacity-100 ring-2 ring-picked' : 'opacity-55 hover:opacity-100'
              }`}
              onClick={() => onIndex(position)}
            >
              <FileThumb file={item} glyph={18} className="h-12 w-12 rounded-lg" />
            </button>
          ))}
        </div>
      </div>
    </motion.div>,
    document.body,
  )
}

/**
 * The open file, drawn by what it is. Keyed by file, so a step starts its loading
 * afresh; anything that fails to load or draw falls back to the file's card.
 */
function FileBody({ file, onDownload, onPageKey }: { file: DmFile; onDownload: () => void; onPageKey: (key: PageKey) => void }) {
  const [failed, setFailed] = useState(false)
  const [shown, setShown] = useState(false)
  const src = file.src
  if (src === undefined || failed) return <FileCard file={file} onDownload={onDownload} />
  if (file.page === true) return <PageFrame src={src} name={file.name} onKey={onPageKey} />
  if (file.kind === 'image') {
    return (
      <Centered>
        {shown ? null : <Loading />}
        {/* Capped by the stage, never upscaled: a small picture blown up reads worse. */}
        <img
          src={src}
          alt={file.name}
          draggable={false}
          className={`max-h-full max-w-full rounded-lg object-contain ${shown ? '' : 'opacity-0'}`}
          onLoad={() => setShown(true)}
          onError={() => setFailed(true)}
        />
      </Centered>
    )
  }
  if (file.kind === 'video') {
    return (
      <Centered>
        <video
          src={src}
          controls
          playsInline
          className="max-h-full max-w-full rounded-lg"
          onError={() => setFailed(true)}
          // The video seeks with the arrow keys while it has focus; the viewer leaves them be.
          onKeyDown={(event) => {
            if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') event.stopPropagation()
          }}
        />
      </Centered>
    )
  }
  if (file.kind === 'pdf') {
    return (
      <Suspense fallback={<Loading />}>
        <PdfPages src={src} loading={<Loading />} onFail={setFailed} />
      </Suspense>
    )
  }
  const readsAs = dmFileReadsAs(file)
  if (readsAs !== null) return <TextBody src={src} readsAs={readsAs} onFail={setFailed} />
  return <FileCard file={file} onDownload={onDownload} />
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="absolute inset-0 flex items-center justify-center px-16 py-4">{children}</div>
}

/** Shown only once a load has taken long enough to notice, so a quick one never flashes it. */
function Loading() {
  const reduce = useReducedMotion() ?? false
  return (
    <motion.p
      role="status"
      className="absolute inset-0 m-0 grid place-items-center text-[13px] text-on-media/60"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay: 0.3, duration: reduce ? 0 : 0.2 }}
    >
      Loading…
    </motion.p>
  )
}

/** A markdown or plain text file read into a page-like column that scrolls on the stage. */
function TextBody({ src, readsAs, onFail }: { src: string; readsAs: 'markdown' | 'text'; onFail: OnFail }) {
  const [text, setText] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    fetch(src, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`The file answered ${response.status}.`)
        return response.text()
      })
      .then(setText, () => {
        if (!controller.signal.aborted) onFail(true)
      })
    return () => controller.abort()
  }, [src, onFail])

  if (text === null) return <Loading />
  return (
    <div className="absolute inset-0 overflow-y-auto overscroll-contain px-16 py-4">
      <div className="mx-auto max-w-[780px] rounded-xl bg-raised px-8 py-7 text-text">
        {readsAs === 'markdown' ? (
          <div className="text-[15px] leading-relaxed">
            <Markdown text={text} variant="document" sources={false} />
          </div>
        ) : (
          <pre className="m-0 font-mono text-[13px] leading-relaxed break-words whitespace-pre-wrap">{text}</pre>
        )}
      </div>
    </div>
  )
}

/** A delivered HTML page, drawn by the server's sandboxed wrapper in the stage's theme. */
function PageFrame({ src, name, onKey }: { src: string; name: string; onKey: (key: PageKey) => void }) {
  const theme = useStageTheme()
  const [loaded, setLoaded] = useState(false)
  const frameRef = useRef<HTMLIFrameElement>(null)
  // A key pressed inside the page never reaches the viewer, so the server's prelude
  // reports the ones the viewer answers to.
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source === null || event.source !== wrappedPage(frameRef.current)) return
      const data: unknown = event.data
      if (typeof data !== 'object' || data === null || !('type' in data) || data.type !== 'manor:key' || !('key' in data)) return
      const key = PAGE_KEYS.find((candidate) => candidate === data.key)
      if (key !== undefined) onKey(key)
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [onKey])
  return (
    <div className="absolute inset-0 flex justify-center px-16 py-4">
      <div className="h-full w-full max-w-page overflow-hidden rounded-xl bg-raised">
        <iframe
          ref={frameRef}
          src={`${src}?view=1&theme=${theme}`}
          title={`Preview of ${name}`}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          className={`block h-full w-full border-0 bg-transparent motion-safe:transition-opacity duration-200 ${loaded ? 'opacity-100' : 'opacity-0'}`}
          // A frame whose colour scheme differs from its page paints an opaque plate,
          // so the empty start document stays light and the loaded page gets the stage's.
          style={{ colorScheme: loaded ? theme : 'light' }}
        />
      </div>
    </div>
  )
}

/** A file's kind for its card: the extension for a plain file, which says more than "File". */
function typeLabel(file: DmFile) {
  const extension = /\.([a-z0-9]{1,8})$/i.exec(file.name)?.[1]
  return file.kind === 'file' && extension !== undefined ? extension.toUpperCase() : dmFileTypeLabel(file.kind)
}

/** What a file is when it cannot be shown: its mark, name, type and size, and a way to keep it. */
function FileCard({ file, onDownload }: { file: DmFile; onDownload: () => void }) {
  return (
    <Centered>
      <div className="flex w-full max-w-80 flex-col items-center gap-3 rounded-2xl bg-on-media/10 px-6 py-8 text-center">
        <FileMark path={file.name} size={40} />
        <div className="flex max-w-full min-w-0 flex-col gap-1">
          <p className="m-0 truncate text-[15px] font-medium" title={file.name}>{file.name}</p>
          <p className="m-0 flex justify-center gap-2 text-meta text-on-media/60">
            <span>{typeLabel(file)}</span>
            <span>{describeBytes(file.size)}</span>
          </p>
        </div>
        {file.src === undefined ? (
          <p className="m-0 text-[13px] text-on-media/70">This file is no longer available.</p>
        ) : (
          <button
            type="button"
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-button border-0 bg-on-media/10 px-3.5 py-1.5 text-[13px] text-on-media [font:inherit] hover:bg-on-media/15"
            onClick={onDownload}
          >
            <Icon icon={Download04Icon} size={14} />
            Download
          </button>
        )}
      </div>
    </Centered>
  )
}
