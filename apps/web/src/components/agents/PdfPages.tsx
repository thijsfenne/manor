import { useEffect, useRef, useState, type ReactNode } from 'react'
import { getDocumentProxy } from 'unpdf'

type Pdf = Awaited<ReturnType<typeof getDocumentProxy>>
interface Sheet { width: number; height: number }

/** A bound per open file, so a huge document cannot mount thousands of sheets. */
const MAX_PAGES = 300
/** Pages draw this far before they scroll into view and let go of their pixels beyond it. */
const NEAR = '1200px 0px'

/**
 * A PDF as a vertical column of pages on canvases, for the file viewer's stage. Loaded
 * lazily so pdf.js stays out of the main bundle. The page's CSP allows no eval, no blob
 * worker and no wasm, so pdf.js runs its bundled worker on this thread with wasm off.
 * A fetch or parse that fails calls `onFail`, and the viewer shows the file's card.
 */
export default function PdfPages({ src, loading, onFail }: { src: string; loading: ReactNode; onFail: (failed: boolean) => void }) {
  const [doc, setDoc] = useState<{ pdf: Pdf; sheet: Sheet } | null>(null)
  const [root, setRoot] = useState<HTMLDivElement | null>(null)

  useEffect(() => {
    let live = true
    let pdf: Pdf | undefined
    const controller = new AbortController()
    const open = async () => {
      const response = await fetch(src, { signal: controller.signal })
      if (!response.ok) throw new Error(`The file answered ${response.status}.`)
      // pdf.js may transfer the buffer it is handed, so it gets a copy nothing else holds.
      const bytes = new Uint8Array(await response.arrayBuffer()).slice()
      pdf = await getDocumentProxy(bytes, { useWasm: false })
      const first = (await pdf.getPage(1)).getViewport({ scale: 1 })
      if (live) setDoc({ pdf, sheet: { width: first.width, height: first.height } })
      else void pdf.loadingTask.destroy()
    }
    open().catch(() => {
      if (live) onFail(true)
    })
    return () => {
      live = false
      controller.abort()
      void pdf?.loadingTask.destroy()
    }
  }, [src, onFail])

  if (doc === null) return loading
  const total = doc.pdf.numPages
  const shown = Math.min(total, MAX_PAGES)
  return (
    <div ref={setRoot} className="absolute inset-0 overflow-y-auto overscroll-contain px-16 py-4">
      <div className="mx-auto flex max-w-[860px] flex-col gap-3">
        {root === null ? null : Array.from({ length: shown }, (_, at) => (
          <PdfPage key={at} pdf={doc.pdf} number={at + 1} sheet={doc.sheet} root={root} />
        ))}
        {total > shown ? (
          <p className="m-0 py-2 text-center text-[13px] text-on-media/70">
            Showing the first {shown} of {total} pages. Download the file to read the rest.
          </p>
        ) : null}
      </div>
    </div>
  )
}

/**
 * One page: a white sheet at the page's own proportions (the first page's until its own
 * is known), drawn at the device pixel ratio while it is near the window and cleared
 * once it scrolls far away, so a long document holds only a few pages of pixels.
 */
function PdfPage({ pdf, number, sheet, root }: { pdf: Pdf; number: number; sheet: Sheet; root: HTMLElement }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [near, setNear] = useState(false)
  const [own, setOwn] = useState<Sheet>()
  const [state, setState] = useState<'blank' | 'drawn' | 'failed'>('blank')

  useEffect(() => {
    const box = boxRef.current
    if (box === null) return
    const observer = new IntersectionObserver(([entry]) => setNear(entry?.isIntersecting === true), { root, rootMargin: NEAR })
    observer.observe(box)
    return () => observer.disconnect()
  }, [root])

  useEffect(() => {
    const box = boxRef.current
    const canvas = canvasRef.current
    if (!near || box === null || canvas === null) return
    let live = true
    let cancel: (() => void) | undefined
    let release: (() => void) | undefined
    const draw = async () => {
      const page = await pdf.getPage(number)
      if (!live) {
        page.cleanup()
        return
      }
      release = () => page.cleanup()
      const base = page.getViewport({ scale: 1 })
      setOwn({ width: base.width, height: base.height })
      const viewport = page.getViewport({ scale: (box.clientWidth / base.width) * window.devicePixelRatio })
      canvas.width = Math.floor(viewport.width)
      canvas.height = Math.floor(viewport.height)
      const task = page.render({ canvas, viewport })
      cancel = () => task.cancel()
      await task.promise
      if (live) setState('drawn')
    }
    draw().catch(() => {
      // A render cancelled on the way out rejects too; only a live failure is one.
      if (live) setState('failed')
    })
    return () => {
      live = false
      cancel?.()
      release?.()
      canvas.width = 0
      canvas.height = 0
      setState('blank')
    }
  }, [near, pdf, number])

  const size = own ?? sheet
  return (
    <div
      ref={boxRef}
      className="relative w-full overflow-hidden rounded-sm bg-page"
      style={{ aspectRatio: `${size.width} / ${size.height}` }}
      role="img"
      aria-label={`Page ${number}`}
    >
      <canvas ref={canvasRef} className={`block h-full w-full motion-safe:transition-opacity duration-150 ${state === 'drawn' ? 'opacity-100' : 'opacity-0'}`} />
      {state === 'failed' ? (
        <p className="absolute inset-0 m-0 grid place-items-center text-[13px] text-on-page/60">This page could not be drawn.</p>
      ) : null}
    </div>
  )
}
