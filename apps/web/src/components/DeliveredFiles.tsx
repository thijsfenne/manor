import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import {
  Cancel01Icon,
  CursorAddSelection01Icon,
  Download04Icon,
  Globe02Icon,
  MinusSignIcon,
  PlusSignIcon,
  SquareArrowUpRightIcon,
  ZoomInAreaIcon,
} from '@hugeicons/core-free-icons'
import type { DeliveredFile } from '@manor/contracts'
import { describeBytes } from '@manor/client-runtime/attachments'
import { requestPageSelection } from '../browserPageSelection'
import { desktopFiles } from '../desktopBrowser'
import { BROWSER_EXPANDED_KEY, expandPanel } from '../useFilesPanel'
import { useLinkChatId, useOpenWebsite, usePicksPageContext } from './ExternalLink'
import { FileMark } from './fileMark'
import { Icon } from './Icon'
import { Dialog } from './ui/Dialog'
import { IconButton } from './ui/IconButton'

/** An HTML file the chat draws live, from the server's sandboxed `?view=1` page. */
const previewsInChat = (file: DeliveredFile) => file.mime === 'text/html' && file.src !== undefined

/**
 * Files a persona handed over, under the answer of the turn that made them. An HTML
 * page is drawn into the thread itself at the full column width, in a DM too; every
 * other file is a card with Open and Save, which a DM keeps within the reply bubble's
 * 78%. The Mac opens HTML and SVG in the chat's own Browser panel, other files as a
 * copy in the app macOS picks, and saves through its own dialog; a browser tab opens or
 * downloads the link, where the server itself says when a file is gone.
 */
export function DeliveredFiles({ files, bubble = false }: { files: readonly DeliveredFile[]; bubble?: boolean }) {
  if (files.length === 0) return null
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {files.map((file) => previewsInChat(file)
        ? <DeliveredPage key={file.id} file={file} />
        : <DeliveredFileRow key={file.id} file={file} bubble={bubble} />)}
    </div>
  )
}

const withParam = (src: string, param: string) => `${src}${src.includes('?') ? '&' : '?'}${param}`

function DeliveredFileRow({ file, bubble }: { file: DeliveredFile; bubble: boolean }) {
  const [busy, setBusy] = useState<'open' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const bridge = desktopFiles()
  const openWebsite = useOpenWebsite()
  const src = file.src

  const run = async (action: 'open' | 'save') => {
    if (src === undefined || bridge === undefined || busy !== null) return
    if (action === 'open' && file.mime === 'image/svg+xml' && openWebsite?.(withParam(src, 'view=1')) === true) return
    setBusy(action)
    setError(null)
    try {
      const result = await bridge[action](src, file.name)
      if (!result.ok) setError(result.error)
    } catch {
      setError('Manor could not reach the desktop shell for this file.')
    } finally {
      setBusy(null)
    }
  }

  const button = 'inline-flex flex-none cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-1.5 py-0.5 text-[12px] text-muted no-underline [font:inherit] hover:bg-picked hover:text-text disabled:cursor-default disabled:opacity-50'
  const saveHref = src === undefined ? undefined : withParam(src, 'download=1')
  // An SVG opens as the viewed page, so a browser tab shows it rather than its source.
  const openHref = src === undefined ? undefined : file.mime === 'image/svg+xml' ? withParam(src, 'view=1') : src
  return (
    <div className={`min-w-0 ${bubble ? 'max-w-[78%]' : ''}`}>
      <div className="min-w-0 overflow-hidden rounded-xl border border-line bg-composer-tray">
        <div className="flex min-w-0 items-center gap-2 px-2.5 py-1.5 text-[12px]">
          <FileMark path={file.name} size={16} />
          <span className="min-w-0 flex-1 truncate text-text" title={file.name}>{file.name}</span>
          <span className="flex-none text-meta text-dim">{describeBytes(file.size)}</span>
          {bridge === undefined ? (
            <>
              <a className={button} href={openHref} target="_blank" rel="noreferrer" aria-disabled={src === undefined}>
                <Icon icon={SquareArrowUpRightIcon} size={13} />Open
              </a>
              <a className={button} href={saveHref} download={file.name} aria-disabled={src === undefined}>
                <Icon icon={Download04Icon} size={13} />Save
              </a>
            </>
          ) : (
            <>
              <button type="button" className={button} disabled={src === undefined || busy !== null} onClick={() => void run('open')}>
                <Icon icon={SquareArrowUpRightIcon} size={13} />{busy === 'open' ? 'Opening…' : 'Open'}
              </button>
              <button type="button" className={button} disabled={src === undefined || busy !== null} onClick={() => void run('save')}>
                <Icon icon={Download04Icon} size={13} />{busy === 'save' ? 'Saving…' : 'Save'}
              </button>
            </>
          )}
        </div>
      </div>
      {error === null ? null : <p role="alert" className="mt-1 mb-0 px-2.5 text-meta text-warn">{error}</p>}
    </div>
  )
}

/** The widths a mockup is laid out at before it is scaled to the column. */
const DESKTOP_WIDTH = 1280
const PHONE_WIDTH = 390
/** A bound against a runaway page only; any real page is drawn at its full height. */
const MAX_DRAWN_HEIGHT = 20_000
/** Held until the page reports its own height, so the row does not start at nothing. */
const PLACEHOLDER_HEIGHT = 240
/** How far outside the window a page stays live; further away it pauses at its size. */
const LIVE_MARGIN = '1200px 0px'
/**
 * After this many growths in a row, each filling the frame just set, the frame holds
 * still for `GROWTH_PROBE_MS`: a page that keeps growing anyway is real content, one that
 * stops was growing with its frame (100vh plus a margin) and grows no further.
 */
const GROWTH_LIMIT = 6
const GROWTH_PROBE_MS = 400
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const

type Theme = 'light' | 'dark'
interface PageSize { height: number; width: number; viewport: number }

/** The theme the stage shows, which a manual choice can set apart from the OS. */
export function useStageTheme(): Theme {
  const read = (): Theme => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
  const [theme, setTheme] = useState(read)
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(read()))
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [])
  return theme
}

/** The window of the page inside a `?view=1` frame: the only sender whose messages count. */
export function wrappedPage(frame: HTMLIFrameElement | null): Window | null {
  try {
    return frame?.contentWindow?.[0] ?? null
  } catch {
    return null
  }
}

/** The page's own report from the server's size script; anything else it posts is ignored. */
function readPageSize(data: unknown): PageSize | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const { type, height, width, viewport } = data as Record<string, unknown>
  if (type !== 'manor:size') return undefined
  const valid = (value: unknown, max: number): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= max
  if (!valid(height, 50_000) || !valid(width, 20_000) || !valid(viewport, 20_000)) return undefined
  return { height: Math.ceil(height), width: Math.ceil(width), viewport: Math.ceil(viewport) }
}

/**
 * A delivered HTML page drawn into the thread. A visual answer lays out at the column's
 * own width on the chat background and is as tall as its content; a mockup (`viewport`
 * desktop or phone) lays out at that screen width, scaled to fit, as a framed screen.
 * A page that insists on a wider layout than the column falls back to the mockup way.
 * Zoom, Select and Open in browser sit in its corner on hover, focus and touch.
 */
function DeliveredPage({ file }: { file: DeliveredFile }) {
  const theme = useStageTheme()
  const openWebsite = useOpenWebsite()
  const chatId = useLinkChatId()
  const desktop = desktopFiles() !== undefined
  const picks = usePicksPageContext()
  const [zoomed, setZoomed] = useState(false)
  const src = file.src!
  const mockup = file.viewport !== undefined
  const pageWidth = file.viewport === 'phone' ? PHONE_WIDTH : file.viewport === 'desktop' ? DESKTOP_WIDTH : undefined
  const browserUrl = withParam(src, `view=1&theme=${theme}`)
  // A visual answer's wrapper stays clear so the page sits on the chat's own background.
  const frameUrl = mockup ? browserUrl : withParam(browserUrl, 'embed=1')
  // Select picks inside the chat's own Browser, which only the Mac has.
  const canSelect = desktop && picks && openWebsite !== null && chatId !== undefined

  const openInBrowser = (select: boolean) => {
    setZoomed(false)
    if (openWebsite?.(browserUrl) === true) {
      if (chatId === undefined) return
      // Picking stays beside the chat, where the picked context lands in the composer;
      // Open in browser gives the page the whole stage.
      if (select) requestPageSelection(chatId, browserUrl)
      else expandPanel(BROWSER_EXPANDED_KEY, chatId)
      return
    }
    window.open(browserUrl, '_blank', 'noopener,noreferrer')
  }

  return (
    <section aria-label={file.name} className="group/page relative min-w-0">
      <FittedFrame url={frameUrl} title={`Preview of ${file.name}`} theme={theme} pageWidth={pageWidth} framed={mockup} />
      <div
        role="group"
        aria-label={`${file.name} controls`}
        className="pointer-events-none absolute top-2 right-2 flex items-center gap-1 rounded-panel border border-line bg-surface/90 p-1 opacity-0 shadow-pill backdrop-blur-md motion-safe:transition-opacity duration-150 group-hover/page:pointer-events-auto group-hover/page:opacity-100 group-focus-within/page:pointer-events-auto group-focus-within/page:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100"
      >
        <IconButton icon={ZoomInAreaIcon} label="Zoom" onClick={() => setZoomed(true)} />
        {canSelect ? <IconButton icon={CursorAddSelection01Icon} label="Select page context" onClick={() => openInBrowser(true)} /> : null}
        <IconButton icon={Globe02Icon} label="Open in browser" onClick={() => openInBrowser(false)} />
      </div>
      {zoomed ? (
        <ZoomedPage
          name={file.name}
          url={browserUrl}
          pageWidth={pageWidth}
          theme={theme}
          canSelect={canSelect}
          onSelect={() => openInBrowser(true)}
          onOpen={() => openInBrowser(false)}
          onClose={() => setZoomed(false)}
        />
      ) : null}
    </section>
  )
}

/**
 * The live frame, sized from what the page reports through the server's injected size
 * script (`postMessage` to this window; the sandbox and CSP stay closed). Only messages
 * from this frame's own page count, and every number is clamped, because the page is
 * untrusted. Far off screen the frame unmounts and keeps its last size.
 */
function FittedFrame({ url, title, theme, pageWidth, framed }: {
  url: string
  title: string
  theme: Theme
  pageWidth: number | undefined
  framed: boolean
}) {
  const reduceMotion = useReducedMotion()
  const boxRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [available, setAvailable] = useState(0)
  const [near, setNear] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [size, setSize] = useState<PageSize>()
  // Sticky: a page with a min-width would otherwise flip between both layouts forever.
  const [fixedWidth, setFixedWidth] = useState<number>()
  const layoutHeight = useRef(0)
  const shown = useRef<PageSize>()
  const growth = useRef(0)
  const probe = useRef<{ trigger: number; timer: ReturnType<typeof setTimeout> }>()
  const frozen = useRef(false)

  useLayoutEffect(() => {
    const box = boxRef.current
    if (box === null) return
    const measure = () => setAvailable(box.clientWidth)
    measure()
    const resize = new ResizeObserver(measure)
    resize.observe(box)
    const intersect = new IntersectionObserver(([entry]) => setNear(entry?.isIntersecting === true), { rootMargin: LIVE_MARGIN })
    intersect.observe(box)
    return () => {
      resize.disconnect()
      intersect.disconnect()
    }
  }, [])

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== wrappedPage(frameRef.current)) return
      const next = readPageSize(event.data)
      if (next === undefined) return
      if (pageWidth === undefined && next.width > next.viewport + 1) setFixedWidth((current) => Math.max(current ?? 0, next.width))
      const current = shown.current
      const apply = (value: PageSize) => {
        shown.current = value
        setSize(value)
      }
      if (current === undefined || next.height <= current.height) {
        clearTimeout(probe.current?.timer)
        probe.current = undefined
        growth.current = 0
        apply(next)
        return
      }
      if (frozen.current) return apply({ ...next, height: current.height })
      if (probe.current !== undefined) {
        if (next.height <= probe.current.trigger) return
        clearTimeout(probe.current.timer)
        probe.current = undefined
        growth.current = 0
        return apply(next)
      }
      growth.current = Math.abs(current.height - layoutHeight.current) <= 1 ? growth.current + 1 : 0
      if (growth.current <= GROWTH_LIMIT) return apply(next)
      probe.current = {
        trigger: next.height,
        // The last step is still shown: harmless for a loop, and real content keeps its end.
        timer: setTimeout(() => {
          probe.current = undefined
          frozen.current = true
          apply(next)
        }, GROWTH_PROBE_MS),
      }
    }
    window.addEventListener('message', receive)
    return () => {
      window.removeEventListener('message', receive)
      clearTimeout(probe.current?.timer)
      probe.current = undefined
    }
  }, [pageWidth])

  // A new address (a theme switch) is a new page; it loads and reports afresh.
  useEffect(() => {
    setLoaded(false)
    clearTimeout(probe.current?.timer)
    probe.current = undefined
    frozen.current = false
    growth.current = 0
  }, [url])

  const layoutWidth = pageWidth ?? fixedWidth ?? available
  const scale = available === 0 || layoutWidth === 0 ? 1 : Math.min(1, available / layoutWidth)
  const drawn = size === undefined ? PLACEHOLDER_HEIGHT : Math.min(MAX_DRAWN_HEIGHT, Math.max(1, size.height * scale))
  const frameHeight = drawn / scale
  const shownWidth = layoutWidth * scale
  useEffect(() => { layoutHeight.current = frameHeight }, [frameHeight])

  return (
    <motion.div
      ref={boxRef}
      className="relative min-w-0 overflow-hidden"
      initial={false}
      animate={{ height: drawn }}
      transition={reduceMotion ? { duration: 0 } : { duration: 0.32, ease: [0.32, 0.72, 0, 1] }}
    >
      {available === 0 ? null : (
        <div
          className={`mx-auto h-full overflow-hidden ${framed ? 'rounded-xl border border-line' : ''}`}
          style={{ width: shownWidth }}
        >
          {near ? (
            <iframe
              ref={frameRef}
              src={url}
              title={title}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              onLoad={() => setLoaded(true)}
              className={`block origin-top-left border-0 bg-transparent transition-opacity duration-300 ${loaded ? 'opacity-100' : 'opacity-0'}`}
              // A frame whose colour scheme differs from its page paints an opaque plate,
              // so the empty start document stays light and the loaded page gets the stage's.
              style={{ width: layoutWidth, height: frameHeight, transform: `scale(${scale})`, colorScheme: loaded ? theme : 'light' }}
            />
          ) : null}
        </div>
      )}
    </motion.div>
  )
}

/**
 * The page over the whole window with 50–200% zoom; Select and Open in browser hand it
 * to Browser. A mockup keeps its screen width, so a phone design stays a phone layout.
 */
function ZoomedPage({ name, url, pageWidth, theme, canSelect, onSelect, onOpen, onClose }: {
  name: string
  url: string
  pageWidth: number | undefined
  theme: Theme
  canSelect: boolean
  onSelect: () => void
  onOpen: () => void
  onClose: () => void
}) {
  const [step, setStep] = useState(ZOOM_STEPS.indexOf(1))
  const [loaded, setLoaded] = useState(false)
  const zoom = ZOOM_STEPS[step]!
  return (
    <Dialog label={`${name}, zoomed`} trapFocus onClose={onClose} inset="wide" scrimClassName="grid place-items-center" className="flex h-full max-h-[calc(100dvh-8rem)] max-w-[1400px] flex-col overflow-hidden shadow-popover">
      <div className="flex min-w-0 flex-none items-center gap-1 border-b border-line py-1 pr-1 pl-3">
        <span className="min-w-0 flex-1 truncate text-[13px] text-text">{name}</span>
        <IconButton icon={MinusSignIcon} label="Zoom out" disabled={step === 0} onClick={() => setStep(step - 1)} />
        <button
          type="button"
          aria-label="Reset zoom"
          className="h-8 min-w-12 cursor-pointer rounded-button border-0 bg-transparent px-1.5 text-[12px] text-muted tabular-nums [font:inherit] hover:bg-icon-fill hover:text-text"
          onClick={() => setStep(ZOOM_STEPS.indexOf(1))}
        >
          {Math.round(zoom * 100)}%
        </button>
        <IconButton icon={PlusSignIcon} label="Zoom in" disabled={step === ZOOM_STEPS.length - 1} onClick={() => setStep(step + 1)} />
        <span className="mx-1 h-4 w-px bg-line" aria-hidden />
        {canSelect ? <IconButton icon={CursorAddSelection01Icon} label="Select page context" onClick={onSelect} /> : null}
        <IconButton icon={Globe02Icon} label="Open in browser" onClick={onOpen} />
        <IconButton icon={Cancel01Icon} label="Close" onClick={onClose} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto overscroll-contain p-6 [container-type:size]">
        <div className="h-[100cqh] w-[100cqw]" style={{ zoom }}>
          <iframe
            src={url}
            title={`Zoomed preview of ${name}`}
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            onLoad={() => setLoaded(true)}
            className="mx-auto block h-full w-full border-0 bg-transparent"
            style={{ colorScheme: loaded ? theme : 'light', ...(pageWidth === undefined ? {} : { width: pageWidth }) }}
          />
        </div>
      </div>
    </Dialog>
  )
}
