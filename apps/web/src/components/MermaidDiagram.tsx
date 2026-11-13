import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { ImageLightbox } from './ui/ZoomableImage'

type Pele = typeof import('pele/lazy')

/**
 * The renderer arrives on the first diagram anyone writes, never with the app: a
 * chat without one pays nothing. Each diagram type is its own chunk on top of that,
 * so a flowchart loads only the flowchart parser and layout.
 */
let loading: Promise<Pele | null> | undefined
/** Set once the renderer is here, so a diagram that remounts draws before paint. */
let loaded: Pele | undefined

function loadPele(): Promise<Pele | null> {
  loading ??= import('pele/lazy').then(
    (pele) => {
      loaded = pele
      return pele
    },
    () => {
      // A failed chunk load is not remembered: the next diagram that mounts tries again.
      loading = undefined
      return null
    },
  )
  return loading
}

type Plan = { state: 'waiting' } | { state: 'ready'; pele: Pele } | { state: 'failed' }

const WAITING: Plan = { state: 'waiting' }
const FAILED: Plan = { state: 'failed' }

/**
 * What a source can become with what has loaded so far. Parsing is the check that
 * keeps a broken diagram as the code block it was written as, rather than drawing
 * an error where the agent's text should be.
 */
function planNow(pele: Pele | undefined, source: string): Plan {
  if (pele === undefined) return WAITING
  const type = typeOf(pele, source)
  if (type === null) return FAILED
  if (!pele.registered(type)) return WAITING
  try {
    pele.parse(source)
    return { state: 'ready', pele }
  } catch {
    return FAILED
  }
}

/** Detection reads front matter too, and broken front matter throws rather than saying no. */
function typeOf(pele: Pele, source: string) {
  try {
    return pele.detectType(source)
  } catch {
    return null
  }
}

/** Loads the renderer and the source's diagram type, then plans with them in hand. */
export async function planDiagram(source: string): Promise<Plan> {
  const pele = await loadPele()
  if (pele === null) return FAILED
  const type = typeOf(pele, source)
  if (type === null) return FAILED
  const ready = await pele.load(type).catch(() => false)
  return ready ? planNow(pele, source) : FAILED
}

/**
 * A ```mermaid block drawn as its diagram. Until the renderer has loaded, and for
 * good if the source does not parse or draw, it stays the code block it arrived as:
 * the same text the reader saw while it streamed, never a spinner or an error.
 */
export function MermaidBlock({ source, fallback }: { source: string; fallback: ReactNode }) {
  const [plan, setPlan] = useState(() => planNow(loaded, source))
  const [enlarged, setEnlarged] = useState<SVGSVGElement | null>(null)
  const box = useRef<HTMLSpanElement>(null)
  const fail = useCallback(() => setPlan(FAILED), [])

  useEffect(() => {
    if (plan.state !== 'waiting') return
    let live = true
    void planDiagram(source).then((next) => {
      if (live) setPlan(next)
    })
    return () => {
      live = false
    }
  }, [plan, source])

  useLayoutEffect(() => {
    const element = box.current
    if (plan.state !== 'ready' || element === null) return
    const mounted = plan.pele.mount(element, source, mountOptions(fail))
    return () => mounted.destroy()
  }, [plan, source, fail])

  if (plan.state !== 'ready') return <>{fallback}</>
  return (
    <>
      <button
        type="button"
        aria-label="Enlarge diagram"
        className="manor-diagram my-2 block w-full cursor-zoom-in rounded-lg border border-line bg-surface px-3 py-3 [font:inherit] first:mt-0 last:mb-0 hover:opacity-90 motion-safe:transition-opacity"
        onClick={() => {
          const svg = box.current?.querySelector('svg')
          if (svg) setEnlarged(svg.cloneNode(true) as SVGSVGElement)
        }}
      >
        <span ref={box} className="flex w-full justify-center" />
      </button>
      {enlarged !== null ? (
        <ImageLightbox
          src=""
          alt="Diagram"
          className=""
          content={<EnlargedDiagram svg={enlarged} />}
          onClose={() => setEnlarged(null)}
        />
      ) : null}
    </>
  )
}

const mountOptions = (onError: () => void) => ({
  links: false,
  images: false,
  zoom: false,
  // Keep the author's direction; a wide diagram scales down to the column instead of turning vertical.
  autoDirection: false,
  sanitize: sanitizeDiagramSvg,
  onError,
})

/** How far the viewer may blow a small diagram up: past this a two-box chart reads as a poster. */
const MAX_SCALE = 2.5
/** The scrim's 24px breathing room on each side, plus the card's own padding. */
const VIEWER_INSET = 96

/**
 * The drawn diagram at the size the window allows. It is a copy of the one in the
 * thread rather than a second render, so it keeps that layout and its fonts, and
 * it still reads the theme's colours because it lives in the same document.
 */
function EnlargedDiagram({ svg }: { svg: SVGSVGElement }) {
  const box = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = box.current
    if (element === null) return
    const { width, height } = svg.viewBox.baseVal
    if (width > 0 && height > 0) {
      const scale = Math.min(MAX_SCALE, (window.innerWidth - VIEWER_INSET) / width, (window.innerHeight - VIEWER_INSET) / height)
      svg.style.width = `${Math.floor(width * scale)}px`
      svg.style.height = `${Math.floor(height * scale)}px`
      svg.style.maxWidth = 'none'
    }
    element.replaceChildren(svg)
  }, [svg])
  return <div ref={box} className="manor-diagram rounded-xl bg-surface p-6" />
}

const FORBIDDEN_TAGS = new Set(['script', 'foreignobject', 'iframe', 'object', 'embed', 'a', 'image', 'img', 'audio', 'video'])

/** A `classDef` may ask for any weight; this app has two, so each lands on the nearer of 400 and 500. */
function allowedWeight(weight: string) {
  const value = weight.toLowerCase()
  if (value === 'bold' || value === 'bolder') return '500'
  if (value === 'normal' || value === 'lighter') return '400'
  const number = Number(value)
  return Number.isFinite(number) ? (number > 450 ? '500' : '400') : ''
}

/**
 * Pele already escapes every label and draws no links or images with these options.
 * This is the second lock, because the page allows inline script: whatever reaches
 * the document is SVG shapes and text, with no handler, no script, and no reference
 * that leaves the diagram itself. Colours a diagram's author set stay theirs.
 */
export function sanitizeDiagramSvg(svg: string): Node {
  const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml')
  const root = parsed.documentElement
  if (root.nodeName.toLowerCase() !== 'svg' || parsed.querySelector('parsererror') !== null) {
    return document.createDocumentFragment()
  }
  for (const element of [root, ...root.querySelectorAll('*')]) {
    if (FORBIDDEN_TAGS.has(element.localName.toLowerCase())) {
      element.remove()
      continue
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      const value = attribute.value.trim()
      const reference = name === 'href' || name === 'xlink:href' || name === 'src'
      if (name.startsWith('on') || (reference && !value.startsWith('#'))) element.removeAttribute(attribute.name)
    }
    if (element instanceof SVGElement && element.style.fontWeight !== '') element.style.fontWeight = allowedWeight(element.style.fontWeight)
  }
  return document.importNode(root, true)
}
