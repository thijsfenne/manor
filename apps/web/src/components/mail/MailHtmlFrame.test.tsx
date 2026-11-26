// @vitest-environment jsdom
import { act, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailMessage } from '@manor/contracts'
import { MailHtmlFrame } from './MailHtmlFrame'
import { MailReader } from './MailReader'

/**
 * jsdom never loads a srcdoc, so the tests that reach inside the frame fire its load
 * themselves and write into the blank document it holds. Height, picture failures and
 * the real sandbox are left to a browser.
 */
let host: HTMLDivElement
let root: Root
let open: ReturnType<typeof vi.fn>

const render = (element: ReactElement) => act(() => root.render(element))
const found = () => host.querySelector<HTMLIFrameElement>('iframe[title="Mail content"]')
const frame = () => {
  const element = found()
  if (element === null) throw new Error('no mail frame on the page')
  return element
}

const loaded = (body: string) => {
  const element = frame()
  const doc = element.contentDocument
  if (doc === null) throw new Error('jsdom gave the frame no document')
  doc.body.innerHTML = body
  act(() => { element.dispatchEvent(new Event('load')) })
  return doc
}

/** False when a listener cancelled the event, as `dispatchEvent` answers. */
const click = (target: Element) => target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
const keyDown = (target: Element, init: KeyboardEventInit) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }))

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  document.documentElement.dataset.theme = 'dark'
  open = vi.fn()
  vi.stubGlobal('open', open)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

describe('MailHtmlFrame', () => {
  it('draws the prepared mail in a frame sandboxed without scripts', () => {
    const onFail = vi.fn()
    render(<MailHtmlFrame html="<p onclick='x()'>Hello there</p><script>alert(1)</script>" later={false} paper={false} onFail={onFail} />)
    const element = frame()
    expect(element.getAttribute('sandbox')).toBe('allow-same-origin')
    const srcDoc = element.getAttribute('srcdoc') ?? ''
    expect(srcDoc).toContain('Hello there')
    expect(srcDoc).toContain(`img-src ${window.location.origin}/media/remote data:`)
    expect(srcDoc).not.toContain('<script')
    expect(srcDoc).not.toContain('onclick')
    expect(element.className).not.toContain('rounded-panel')
    expect(onFail).not.toHaveBeenCalled()
  })

  it('draws a mail as paper when the reader says so, without rounded corners', () => {
    render(<MailHtmlFrame html="<p>Hi</p>" later={false} paper onFail={() => {}} />)
    expect(frame().className).not.toContain('rounded-panel')
    expect(frame().getAttribute('srcdoc')).toContain('color-scheme:light')
  })

  it('asks for the plain text once when nothing visible is left', () => {
    const onFail = vi.fn()
    render(<MailHtmlFrame html="<p> </p><img src='cid:logo'>" later={false} paper={false} onFail={onFail} />)
    render(<MailHtmlFrame html="<p> </p><img src='cid:logo'>" later={false} paper={false} onFail={() => onFail()} />)
    expect(found()).toBeNull()
    expect(onFail).toHaveBeenCalledTimes(1)
  })

  it('asks for the plain text when the loaded frame shows nothing', () => {
    const onFail = vi.fn()
    render(<MailHtmlFrame html="<p>Hi</p>" later={false} paper={false} onFail={onFail} />)
    loaded('<style>p{margin:0}</style>')
    expect(onFail).toHaveBeenCalledTimes(1)
  })

  it('redraws a themed mail when the app theme switches', async () => {
    render(<MailHtmlFrame html="<p>Hi</p>" later={false} paper={false} onFail={() => {}} />)
    expect(frame().getAttribute('srcdoc')).toContain('color-scheme:dark')
    // The frame hears of the switch through an observer, which reports a moment later.
    await act(async () => {
      document.documentElement.dataset.theme = 'light'
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(frame().getAttribute('srcdoc')).toContain('color-scheme:light')
  })

  it('opens web and mail links from the page and swallows every other click', () => {
    render(<MailHtmlFrame html="<p>Hi</p>" later={false} paper={false} onFail={() => {}} />)
    const doc = loaded('<a id="web" href="https://example.com/a"><b>web</b></a><a id="dead">dead</a><a id="script" href="javascript:void 0">s</a>')

    const inner = doc.querySelector('b')
    if (inner === null) throw new Error('missing link text')
    expect(click(inner)).toBe(false)
    expect(open).toHaveBeenCalledWith('https://example.com/a', '_blank', 'noopener,noreferrer')

    open.mockClear()
    const script = doc.getElementById('script')
    if (script === null) throw new Error('missing link')
    expect(click(script)).toBe(false)
    expect(open).not.toHaveBeenCalled()
  })

  it('forwards keys typed in the frame to the page window', () => {
    render(<MailHtmlFrame html="<p>Hi</p>" later={false} paper={false} onFail={() => {}} />)
    const doc = loaded('<p>Hi</p>')
    const seen: KeyboardEvent[] = []
    const onKey = (event: KeyboardEvent) => {
      seen.push(event)
      if (event.key === 'j') event.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    try {
      expect(keyDown(doc.body, { key: 'j', code: 'KeyJ', shiftKey: true })).toBe(false)
      expect(keyDown(doc.body, { key: 'x', code: 'KeyX' })).toBe(true)
    } finally {
      window.removeEventListener('keydown', onKey)
    }
    expect(seen.map((event) => [event.key, event.code, event.shiftKey])).toEqual([['j', 'KeyJ', true], ['x', 'KeyX', false]])
  })

  it('lets go of the frame document on unmount', () => {
    render(<MailHtmlFrame html="<p>Hi</p>" later={false} paper={false} onFail={() => {}} />)
    const doc = loaded('<a href="https://example.com/a">web</a>')
    const link = doc.querySelector('a')
    if (link === null) throw new Error('missing link')
    render(<div />)
    click(link)
    expect(open).not.toHaveBeenCalled()
  })
})

describe('MailReader', () => {
  const from = { name: 'Sender', address: 'sender@example.com' }
  const message = (id: string, html: string): MailMessage =>
    ({ id, from, to: [], cc: [], at: 1, text: html, html, truncated: false, attachments: [], mine: false })
  const reader = (...messages: MailMessage[]) => render(
    <MailReader card={{ threadId: 't', subject: 'Hi', from, at: 1, unread: false, messageCount: messages.length }}
      thread={{ threadId: 't', subject: 'Hi', messages, reply: { to: from.address, cc: '', subject: 'Re: Hi' } }}
      error={undefined} listed={1} tab="reply" query="" triage={null} unlabelled={0} projects={[]} split={false}
      onReply={() => {}} onAdd={() => {}} onArchive={() => {}} onLink={() => {}} />)
  const pane = () => host.querySelector('.overflow-y-auto')

  it('puts a thread with one coloured mail on paper and draws every frame light', () => {
    reader(message('1', "<p style='color: navy'>First</p>"), message('2', '<p>Second</p>'))
    expect(pane()?.classList.contains('mail-paper')).toBe(true)
    act(() => { host.querySelector<HTMLButtonElement>('article button[aria-expanded="false"]')?.click() })
    const frames = [...host.querySelectorAll('iframe[title="Mail content"]')]
    expect(frames).toHaveLength(2)
    for (const element of frames) expect(element.getAttribute('srcdoc')).toContain('color-scheme:light')
  })

  it('leaves a thread without colours in the app theme', () => {
    reader(message('1', '<p>First</p>'), message('2', '<p>Second</p>'))
    expect(pane()?.classList.contains('mail-paper')).toBe(false)
    expect(frame().getAttribute('srcdoc')).toContain('color-scheme:dark')
  })
})
