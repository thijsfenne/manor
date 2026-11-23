import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { materialisedImageStem } from './scratch.js'
import { serverFile } from './serverRoot.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import { PDF_MIME, type DeliveredFile, type EventDocument, type EventImage, type GoalEvidence, type ServerMessage, type ThreadEvent, type WorkHandoff } from '@manor/contracts'

export const CHAT_MEDIA_PREFIX = '/media/'

/**
 * The unsigned path of one stored file: its chat, its event and its slot there. A slot is
 * a picture's index, `d` plus a document's index, `t` plus a text file's, `f0` for a
 * delivered file, `e` for a result's screenshot or `i` plus a tool call's target index
 * for a picture that call read or wrote, so no two kinds share a link.
 */
export const mediaPath = (chatId: string, eventId: string, slot: string) =>
  `${encodeURIComponent(chatId)}/${encodeURIComponent(eventId)}/${slot}`

/**
 * Delivered files a browser shows itself rather than saving. Everything else, HTML
 * and SVG included, downloads; `?download=1` downloads these too.
 */
const INLINE_FILE_MIMES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'text/plain', 'text/csv'])

/**
 * Pages the chat preview and the Mac's in-app Browser ask for with `?view=1`. Both keep
 * an opaque origin, so a persona's file never acts as Manor. SVG stays script-free.
 */
const VIEW_FILE_MIMES = new Set(['text/html', 'image/svg+xml'])

/** Every delivered file, SVG included, unless it is an HTML page asked for with `?view=1`. */
const FILE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox"

/**
 * A delivered HTML page viewed with `?view=1`. The response is a fixed wrapper with no
 * scripts of its own; the persona's page runs inside it as a `srcdoc` frame, which
 * inherits this policy. Its inline scripts run, so a mockup's toggles work, but only in
 * a sandbox without `allow-same-origin` (no Manor cookies, storage or DOM), with nothing
 * to load or send, no forms or popups, and `frame-src 'none'`, which refuses every
 * navigation of the inner frame: a link or `location` cannot carry it to the network or
 * to Manor's own server. WebRTC is the one known gap: Chromium ignores CSP `webrtc`, so
 * a page that means to can still send STUN or TURN traffic (accepted 2026-10-08).
 * The wrapper itself cannot be navigated by the inner page, and
 * it has no script that could, so this holds in the chat, a browser tab and the Mac's
 * Browser panel alike. The theme prelude and size reporter `injectManorPrelude` adds to the
 * persona's document need nothing beyond this policy: the font travels as a `data:` URL
 * and the reporter only posts a message to the parent.
 */
const HTML_VIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  'sandbox allow-scripts',
].join('; ')

/** A tool target the trace may show as a thumbnail; the bytes still have to say PNG, JPEG or WebP. */
const RASTER_PATH = /\.(png|jpe?g|webp)$/i
/** A screenshot is far below this; anything larger is not worth reading for a thumbnail. */
const MAX_TOOL_IMAGE_BYTES = 25 * 1024 * 1024

/**
 * The stems of the pictures users attached in one chat. `materialiseImages` writes each
 * to the thread's `attachments` folder under that stem, which is the path the agent reads.
 */
function userImageStems(events: readonly ThreadEvent[]): Set<string> {
  const stems = new Set<string>()
  for (const event of events) addUserImages(stems, event)
  return stems
}

function addUserImages(stems: Set<string>, event: ThreadEvent) {
  if (event.type !== 'user_message') return
  for (const index of (event.images ?? []).keys()) stems.add(materialisedImageStem(event.id, index))
}

/**
 * Whether a tool target is a picture the user attached to a message in this chat: a file
 * in an `attachments` folder whose name is the stem of one of that chat's user pictures.
 * The user sees it in their own bubble, so the trace shows no thumbnail for it. Without
 * the chat's stems (`undefined`), every file in an `attachments` folder counts as one.
 */
export function isUserAttachment(target: string, stems: ReadonlySet<string> | undefined): boolean {
  if (path.basename(path.dirname(target)) !== 'attachments') return false
  if (stems === undefined) return true
  const name = path.basename(target)
  return stems.has(name.slice(0, name.lastIndexOf('.')))
}

const isToolImage = (target: string) => path.isAbsolute(target) && RASTER_PATH.test(target)

const DATA_URL = /^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/
/** Enough for any header Manor's own resizers write; a miss falls back to the whole picture. */
const HEADER_CHARS = 256 * 1024
const MAX_SIZES = 4_096

export interface ChatMedia {
  /** Every event a client receives passes here, so no image bytes ride a snapshot or frame. */
  forClient(message: ServerMessage): ServerMessage
  /** Serves a link from `forClient`; false when the request is not a media request. */
  handle(request: IncomingMessage, response: ServerResponse): boolean
}

/**
 * Stored images leave the transcript as signed links. The key lives for one server
 * process: a restart re-snapshots every open chat, which hands out fresh links, so
 * nothing about a link has to survive on disk. Stored events never change their
 * pictures, which is what lets a browser cache a link for good.
 */
export function createChatMedia(options: {
  loadEvents(chatId: string): Promise<readonly ThreadEvent[]>
  loadDocument(chatId: string, documentId: string): Promise<Uint8Array | undefined>
  key?: Buffer
}): ChatMedia {
  const key = options.key ?? randomBytes(32)
  const sizes = new Map<string, { width: number; height: number } | null>()
  // Per chat, the stems of its user pictures, known once a whole thread went out and kept
  // current by every user message after it. A chat without an entry links no picture from
  // an `attachments` folder; serving checks again from the transcript.
  const userImages = new Map<string, Set<string>>()

  const sign = (path: string) => createHmac('sha256', key).update(path).digest('base64url').slice(0, 32)
  const signed = (path: string) => `${CHAT_MEDIA_PREFIX}${path}/${sign(path)}`

  const sizeOf = (id: string, dataUrl: string) => {
    if (sizes.has(id)) return sizes.get(id) ?? undefined
    const size = imageSize(dataUrl)
    if (sizes.size >= MAX_SIZES) sizes.delete(sizes.keys().next().value!)
    sizes.set(id, size ?? null)
    return size
  }

  const linkImage = (chatId: string, eventId: string, index: number, image: EventImage): EventImage => {
    if (image.dataUrl === undefined) return image
    const path = mediaPath(chatId, eventId, String(index))
    const size = sizeOf(path, image.dataUrl)
    return {
      name: image.name,
      src: signed(path),
      ...(size === undefined ? {} : size),
      ...(image.annotation === undefined ? {} : { annotation: image.annotation }),
    }
  }

  const linkDocument = (chatId: string, eventId: string, index: number, document: EventDocument): EventDocument =>
    ({ ...document, src: signed(mediaPath(chatId, eventId, `d${index}`)) })

  // One delivered file per event, so its slot is always `f0`.
  const linkFile = (chatId: string, eventId: string, file: DeliveredFile): DeliveredFile =>
    ({ ...file, src: signed(mediaPath(chatId, eventId, 'f0')) })

  // A snapshot with `after` holds only the end of a chat, so it can add to the stems but
  // never start them.
  const noteUserImages = (chatId: string, events: readonly ThreadEvent[], whole: boolean) => {
    const stems = userImages.get(chatId)
    if (whole) userImages.set(chatId, userImageStems(events))
    else if (stems !== undefined) for (const event of events) addUserImages(stems, event)
  }

  const linkToolImages = (chatId: string, event: Extract<ThreadEvent, { type: 'tool_use' }>): ThreadEvent => {
    const stems = userImages.get(chatId)
    const images = (event.targets ?? []).flatMap((target, index) =>
      isToolImage(target) && !isUserAttachment(target, stems) ? [{ target, src: signed(mediaPath(chatId, event.id, `i${index}`)) }] : [])
    return images.length === 0 ? event : { ...event, images }
  }

  const linkEvent = (chatId: string, event: ThreadEvent): ThreadEvent => {
    if (event.type === 'file_delivery') return { ...event, file: linkFile(chatId, event.id, event.file) }
    if (event.type === 'tool_use') return linkToolImages(chatId, event)
    if (event.type !== 'user_message' && event.type !== 'agent_message') return event
    const documents = event.type === 'user_message' && event.documents !== undefined
      ? event.documents.map((document, index) => linkDocument(chatId, event.id, index, document))
      : undefined
    if (event.images === undefined && documents === undefined) return event
    return {
      ...event,
      ...(event.images === undefined ? {} : { images: event.images.map((image, index) => linkImage(chatId, event.id, index, image)) }),
      ...(documents === undefined ? {} : { documents }),
    }
  }

  // `e` marks a result's screenshot, stored as a document of the Session it came from.
  const linkEvidence = (chatId: string, evidence: GoalEvidence): GoalEvidence =>
    ({ ...evidence, src: signed(mediaPath(chatId, evidence.id, 'e')) })

  const linkHandoff = (handoff: WorkHandoff): WorkHandoff => {
    const evidence = handoff.goalReport?.evidence
    if (evidence === undefined || handoff.workChatId === null || handoff.goalReport === undefined) return handoff
    const chatId = handoff.workChatId
    return { ...handoff, goalReport: { ...handoff.goalReport, evidence: evidence.map((item) => linkEvidence(chatId, item)) } }
  }

  return {
    forClient(message) {
      if (message.type === 'snapshot') {
        noteUserImages(message.chatId, [...message.events, ...(message.replaced ?? [])], message.after === undefined)
        return { ...message, events: message.events.map((event) => linkEvent(message.chatId, event)) }
      }
      if (message.type === 'event') {
        noteUserImages(message.chatId, [message.event], false)
        return { ...message, event: linkEvent(message.chatId, message.event) }
      }
      // A DM's file list names each file by its unsigned path; see `listDmFiles`.
      if (message.type === 'dm_files') {
        return { ...message, files: message.files.map((file) => (file.src === undefined ? file : { ...file, src: signed(file.src) })) }
      }
      if (message.type === 'directory' && message.workHandoffs.some((handoff) => handoff.goalReport?.evidence !== undefined)) {
        return { ...message, workHandoffs: message.workHandoffs.map(linkHandoff) }
      }
      return message
    },
    handle(request, response) {
      if (request.url?.startsWith(CHAT_MEDIA_PREFIX) !== true) return false
      void serve(request, response).catch(() => {
        if (!response.headersSent) response.writeHead(500, { 'cache-control': 'no-store' })
        response.end()
      })
      return true
    },
  }

  async function serve(request: IncomingMessage, response: ServerResponse) {
    const missing = () => {
      response.writeHead(404, { 'cache-control': 'no-store' })
      response.end()
    }
    const url = new URL(request.url ?? '/', 'http://manor')
    const parts = url.pathname.slice(CHAT_MEDIA_PREFIX.length).split('/')
    const head = request.method === 'HEAD'
    if ((request.method !== 'GET' && !head) || parts.length !== 4) return missing()
    const [chatPart, eventPart, indexPart, signature] = parts as [string, string, string, string]
    const path = `${chatPart}/${eventPart}/${indexPart}`
    const expected = Buffer.from(sign(path))
    const provided = Buffer.from(signature)
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return missing()

    const chatId = decodeURIComponent(chatPart)
    const eventId = decodeURIComponent(eventPart)
    // A result's screenshot is a document of its own, so it needs no transcript read.
    if (indexPart === 'e') {
      const bytes = head ? undefined : await options.loadDocument(chatId, eventId)
      const mime = bytes === undefined ? undefined : rasterMime(bytes)
      if (bytes === undefined || mime === undefined) return missing()
      response.writeHead(200, {
        'content-type': mime,
        'content-length': String(bytes.byteLength),
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      })
      response.end(bytes)
      return
    }
    const events = await options.loadEvents(chatId)
    const event = events.find((candidate) => candidate.id === eventId)
    if (indexPart.startsWith('i')) {
      // Only a picture this tool call named, still on disk and still a picture, and never the user's own.
      const target = event?.type === 'tool_use' ? event.targets?.[Number(indexPart.slice(1))] : undefined
      if (target === undefined || !isToolImage(target) || isUserAttachment(target, userImageStems(events))) return missing()
      const info = await stat(target).catch(() => undefined)
      if (info?.isFile() !== true || info.size > MAX_TOOL_IMAGE_BYTES) return missing()
      const bytes = await readFile(target).catch(() => undefined)
      const mime = bytes === undefined ? undefined : rasterMime(bytes)
      if (bytes === undefined || mime === undefined) return missing()
      response.writeHead(200, {
        'content-type': mime,
        'content-length': String(bytes.byteLength),
        // The file can change on disk after the turn, so it is not cached for good.
        'cache-control': 'private, max-age=3600',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      })
      response.end(head ? undefined : bytes)
      return
    }
    if (indexPart === 'f0') {
      const file = event?.type === 'file_delivery' ? event.file : undefined
      const bytes = file === undefined ? undefined : await options.loadDocument(chatId, file.id)
      if (file === undefined || bytes === undefined) {
        // Opened straight in a browser tab, so the body says what happened.
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        response.end(head ? undefined : 'This file is no longer available in Manor.\n')
        return
      }
      const viewed = url.searchParams.get('download') !== '1' && url.searchParams.get('view') === '1' && VIEW_FILE_MIMES.has(file.mime)
      const inline = viewed || (url.searchParams.get('download') !== '1' && INLINE_FILE_MIMES.has(file.mime))
      const page = viewed && file.mime === 'text/html'
      // `theme` is the chat's colour mode (anything but `light` is dark); `embed=1` marks the
      // chat's own frame, which draws the page on the chat background.
      const theme: ViewTheme = url.searchParams.get('theme') === 'light' ? 'light' : 'dark'
      const embedded = url.searchParams.get('embed') === '1'
      const whole = page ? htmlViewPage(file.name, bytes, theme, embedded) : bytes
      // A video player asks for the part it plays or seeks to; anything else gets the whole file.
      const range = page ? undefined : byteRange(request.headers.range, whole.byteLength)
      const body = range === undefined ? whole : whole.subarray(range.start, range.end + 1)
      response.writeHead(range === undefined ? 200 : 206, {
        'content-type': page ? 'text/html; charset=utf-8' : file.mime,
        'content-length': String(body.byteLength),
        ...(page ? {} : { 'accept-ranges': 'bytes' }),
        ...(range === undefined ? {} : { 'content-range': `bytes ${range.start}-${range.end}/${whole.byteLength}` }),
        'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        // Whatever a persona wrote, it never runs as a page on Manor's origin.
        'content-security-policy': page ? HTML_VIEW_CSP : FILE_CSP,
      })
      response.end(head ? undefined : body)
      return
    }
    if (head) return missing()
    if (indexPart.startsWith('t')) {
      const file = event?.type === 'user_message' ? event.files?.[Number(indexPart.slice(1))] : undefined
      if (file === undefined) return missing()
      const body = Buffer.from(file.content)
      response.writeHead(200, {
        // Always plain text, whatever the file claims to be: it is read, never run.
        'content-type': 'text/plain; charset=utf-8',
        'content-length': String(body.byteLength),
        'content-disposition': `${url.searchParams.get('download') === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy': FILE_CSP,
      })
      response.end(body)
      return
    }
    if (indexPart.startsWith('d')) {
      const document = event?.type === 'user_message' ? event.documents?.[Number(indexPart.slice(1))] : undefined
      const bytes = document === undefined ? undefined : await options.loadDocument(chatId, document.id)
      if (document === undefined || bytes === undefined) return missing()
      const pdf = document.mime === PDF_MIME
      response.writeHead(200, {
        'content-type': document.mime,
        'content-length': String(bytes.byteLength),
        // A PDF opens in the viewer; a Word file has no viewer here and downloads.
        'content-disposition': `${pdf ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(document.name)}`,
        'cache-control': 'private, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
      })
      response.end(bytes)
      return
    }
    const images = event?.type === 'user_message' || event?.type === 'agent_message' ? event.images : undefined
    const match = DATA_URL.exec(images?.[Number(indexPart)]?.dataUrl ?? '')
    if (match === null) return missing()
    const bytes = Buffer.from(match[2]!, 'base64')
    response.writeHead(200, {
      'content-type': match[1]!,
      'content-length': String(bytes.byteLength),
      'cache-control': 'private, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      // An SVG opened on its own must not run as a page on Manor's origin.
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    })
    response.end(bytes)
  }
}

/** One satisfiable `bytes=start-end` or `bytes=start-` range; undefined for anything else, which gets the whole file. */
function byteRange(header: string | undefined, length: number): { start: number; end: number } | undefined {
  const match = /^bytes=(\d+)-(\d*)$/.exec(header ?? '')
  if (match === null) return undefined
  const start = Number(match[1])
  const end = match[2] === '' ? length - 1 : Math.min(Number(match[2]), length - 1)
  return start <= end ? { start, end } : undefined
}

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

export type ViewTheme = 'light' | 'dark'

/** Manor's design tokens per colour mode, exposed to a delivered page as `--manor-*` variables. */
const VIEW_THEMES = {
  dark: {
    bg: '#0f1011', surface: '#191a1b', raised: '#191a1b', text: '#f7f8f8', muted: '#8a8f98', dim: '#62666d',
    line: 'rgb(255 255 255 / 8%)', ok: '#10b981', warn: '#f2c94c', danger: '#eb5757', info: '#4a9eff',
    'chart-1': '#d97757', 'chart-2': '#4a9eff', 'chart-3': '#10b981', 'chart-4': '#a78bfa', 'chart-5': '#f2c94c',
  },
  light: {
    bg: '#ffffff', surface: '#eef0f3', raised: '#ffffff', text: '#16181b', muted: '#565b66', dim: '#616773',
    line: 'rgb(0 0 0 / 11%)', ok: '#056b4b', warn: '#8a5d00', danger: '#b02c24', info: '#1155cc',
    'chart-1': '#c4623f', 'chart-2': '#1155cc', 'chart-3': '#056b4b', 'chart-4': '#7c5cd6', 'chart-5': '#b58800',
  },
} as const satisfies Record<ViewTheme, Record<string, string>>

const BASE_CSS =
  ':root{--manor-radius:12px;--manor-radius-sm:8px;' +
  "--manor-font:'Geist Variable','SF Pro Rounded',ui-rounded,system-ui,-apple-system,sans-serif;" +
  '--manor-mono:ui-monospace,SFMono-Regular,Menlo,monospace}' +
  ':where(html){background:transparent;color:var(--manor-text);font:15px/1.5 var(--manor-font);-webkit-font-smoothing:antialiased;scrollbar-width:none}' +
  ':where(html)::-webkit-scrollbar,:where(body)::-webkit-scrollbar{display:none}' +
  ':where(body){margin:0}' +
  ':where(code,kbd,pre,samp){font-family:var(--manor-mono)}' +
  ':where(b,strong,th,h1,h2,h3,h4,h5,h6){font-weight:500}'

/**
 * Reports the page's size to the chat, which sizes its frame to it. Posts only when the
 * height, scroll width or viewport width changed; the viewport alone changes when a page
 * with a `min-width` keeps its size as the frame narrows, and the chat scales on that.
 * DOM changes and finished transitions or animations are checked once a frame too,
 * since a chart that only widens resizes neither observed box. Height is the root's box or the body's content extent, whichever
 * is taller: absolutely positioned content adds nothing to the box, and the root's own
 * scroll height never drops below the frame, so the frame could not shrink back.
 */
const SIZE_REPORTER =
  '(function(){if(window.top===window)return;var d=document.documentElement,h=-1,w=-1,v=-1,p=0,o=new ResizeObserver(s);' +
  'function s(){var y=document.body,a=Math.ceil(Math.max(d.getBoundingClientRect().height,y?y.getBoundingClientRect().top+window.scrollY+y.scrollHeight:0)),b=d.scrollWidth,c=d.clientWidth;' +
  'if(a===h&&b===w&&c===v)return;h=a;w=b;v=c;window.top.postMessage({type:"manor:size",height:a,width:b,viewport:c},"*")}' +
  'function q(){if(!p)p=requestAnimationFrame(function(){p=0;s()})}' +
  'o.observe(d);new MutationObserver(q).observe(d,{subtree:true,childList:true,attributes:true,characterData:true});' +
  'document.addEventListener("DOMContentLoaded",function(){o.observe(document.body);s()});' +
  'addEventListener("transitionend",q,true);addEventListener("animationend",q,true);' +
  'window.addEventListener("load",s)})()'

/**
 * Hands Escape and the left and right arrows to the app around the page: a viewer over
 * the page closes or steps on them, and a key pressed inside the sandboxed frame never
 * reaches it otherwise. A key the page handled itself, and an arrow in a field, stay the page's;
 * the report waits until every handler of the page has had the key.
 */
const KEY_REPORTER =
  '(function(){if(window.top===window)return;addEventListener("keydown",function(e){var k=e.key,t=e.target;' +
  'if(k!=="Escape"&&k!=="ArrowLeft"&&k!=="ArrowRight")return;' +
  'if(k!=="Escape"&&t&&t.closest&&t.closest("input,textarea,select,[contenteditable]"))return;' +
  'setTimeout(function(){if(!e.defaultPrevented)window.top.postMessage({type:"manor:key",key:k},"*")})})})()'

let geistFace: string | undefined

/** Geist as an embedded `@font-face`, read once; empty when the package file is missing. */
function geistFontFace(): string {
  if (geistFace !== undefined) return geistFace
  try {
    // A bundle carries the file itself; from source it comes out of the package.
    const bundled = serverFile('assets', 'geist-latin-wght-normal.woff2')
    const file = existsSync(bundled)
      ? bundled
      : createRequire(import.meta.url).resolve('@fontsource-variable/geist/files/geist-latin-wght-normal.woff2')
    geistFace =
      "@font-face{font-family:'Geist Variable';font-style:normal;font-display:block;font-weight:300 900;" +
      `src:url(data:font/woff2;base64,${readFileSync(file).toString('base64')}) format('woff2')}`
  } catch {
    geistFace = ''
  }
  return geistFace
}

function themeStyle(theme: ViewTheme): string {
  const tokens = Object.entries(VIEW_THEMES[theme]).map(([name, value]) => `--manor-${name}:${value}`).join(';')
  return `<style id="manor-theme">${geistFontFace()}:root{color-scheme:${theme};${tokens}}${BASE_CSS}</style><script>${SIZE_REPORTER};${KEY_REPORTER}</script>`
}

/**
 * Puts Manor's theme variables, base styles and its size and key reporters into a persona's HTML before
 * it becomes the wrapper's `srcdoc`. They go right after `<head>`, so the page's own rules
 * come later and win; a document without one gets the nearest equivalent.
 */
export function injectManorPrelude(html: string, theme: ViewTheme): string {
  const prelude = themeStyle(theme)
  // Searched with comments blanked out, so a `<head>` mentioned in one is not the head.
  const scan = html.replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) => ' '.repeat(comment.length))
  const after = (tag: RegExp, wrap: boolean) => {
    const match = tag.exec(scan)
    if (match === null) return undefined
    const at = match.index + match[0].length
    return html.slice(0, at) + (wrap ? `<head>${prelude}</head>` : prelude) + html.slice(at)
  }
  // A tag ends at the first `>` outside quoted attribute values.
  const tag = (name: string) => new RegExp(`<${name}(?=[\\s>/])(?:[^>"']|"[^"]*"|'[^']*')*>`, 'i')
  return after(tag('head'), false) ?? after(tag('html'), true) ?? after(/^\s*<!doctype[^>]*>/i, true) ?? `<head>${prelude}</head>${html}`
}

/**
 * The `?view=1` wrapper around a delivered HTML file: the page fills it as a sandboxed
 * `srcdoc` frame, so its document can run scripts but never becomes the navigable page.
 * `embedded` leaves the wrapper transparent for the chat to paint behind it; on its own
 * (a browser tab, the Browser panel) it gets the theme's stage colour instead.
 */
function htmlViewPage(name: string, bytes: Uint8Array, theme: ViewTheme, embedded: boolean): Buffer {
  const title = escapeHtml(name)
  const background = embedded ? 'transparent' : VIEW_THEMES[theme].bg
  return Buffer.from(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="color-scheme" content="${theme}"><meta name="manor-view" content="1">` +
    `<title>${title}</title><style>html,body{margin:0;height:100%;overflow:hidden;background:${background}}` +
    'iframe{display:block;width:100%;height:100%;border:0}</style></head><body>' +
    `<iframe sandbox="allow-scripts" title="${title}" srcdoc="${escapeHtml(injectManorPrelude(new TextDecoder().decode(bytes), theme))}"></iframe>` +
    '</body></html>',
  )
}

/**
 * The type a screenshot's own bytes declare; only the three a result card shows. One
 * check for both ends: `goal_reached` refuses what serving would not show.
 */
export function rasterMime(bytes: Uint8Array): string | undefined {
  const at = (offset: number, ...expected: number[]) => expected.every((value, index) => bytes[offset + index] === value)
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png'
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp'
  return undefined
}

/** Pixel size from the file header of a PNG, JPEG or WebP data URL; undefined otherwise. */
export function imageSize(dataUrl: string): { width: number; height: number } | undefined {
  const match = DATA_URL.exec(dataUrl)
  if (match === null || match[1] === 'image/svg+xml') return undefined
  const base64 = match[2]!
  const head = Buffer.from(base64.slice(0, HEADER_CHARS - (HEADER_CHARS % 4)), 'base64')
  const size = headerSize(head)
  if (size !== undefined || base64.length <= HEADER_CHARS) return size
  return headerSize(Buffer.from(base64, 'base64'))
}

/** Pixel size from a PNG, JPEG or WebP file's own header. */
export const rasterSize = (bytes: Uint8Array) => headerSize(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))

function headerSize(bytes: Buffer): { width: number; height: number } | undefined {
  const valid = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : undefined)
  // PNG: signature, then IHDR with big-endian width and height.
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && bytes.toString('ascii', 12, 16) === 'IHDR') {
    return valid(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
  }
  // WebP: RIFF container with one of three bitstream headers.
  if (bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('ascii', 12, 16)
    if (chunk === 'VP8X') return valid(1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3))
    if (chunk === 'VP8 ') return valid(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff)
    if (chunk === 'VP8L') {
      const bits = bytes.readUInt32LE(21)
      return valid((bits & 0x3fff) + 1, ((bits >> 14) & 0x3fff) + 1)
    }
    return undefined
  }
  // JPEG: walk the segments to the first start-of-frame marker.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 9 <= bytes.length) {
      if (bytes[offset] !== 0xff) return undefined
      const marker = bytes[offset + 1]!
      if (marker === 0xff) {
        offset += 1
        continue
      }
      const length = bytes.readUInt16BE(offset + 2)
      const startOfFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
      if (startOfFrame) return valid(bytes.readUInt16BE(offset + 7), bytes.readUInt16BE(offset + 5))
      offset += 2 + length
    }
  }
  return undefined
}
