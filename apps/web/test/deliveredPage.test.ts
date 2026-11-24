import { afterEach, describe, expect, it, vi } from 'vitest'
import { fitScale, pageLinkOpener } from '../src/components/DeliveredFiles'

describe('a delivered page in the chat', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('shrinks a wide page only down to 60 percent', () => {
    expect(fitScale(700, 600)).toBe(1)
    expect(fitScale(700, 1000)).toBe(0.7)
    expect(fitScale(700, 1600)).toBe(0.6)
    expect(fitScale(0, 1600)).toBe(1)
  })

  it('opens a link the frame posts once, and nothing from another sender or scheme', () => {
    const page = {}
    const frame = { contentWindow: [page] } as unknown as HTMLIFrameElement
    vi.stubGlobal('document', { activeElement: frame })
    vi.stubGlobal('navigator', { userActivation: { isActive: true } })
    const open = vi.fn()
    const receive = pageLinkOpener(() => frame, { current: -Infinity }, open)
    const post = (url: string, at: number, source: object = page) =>
      receive({ source, data: { type: 'manor:open', url }, timeStamp: at } as unknown as MessageEvent)

    post('https://example.com/x', 5_000, {})
    post('javascript:alert(1)', 5_000)
    post('file:///etc/hosts', 5_000)
    expect(open).not.toHaveBeenCalled()

    post('https://example.com/x', 5_000)
    // A page posting again straight after one click opens nothing more.
    post('https://example.com/y', 5_200)
    expect(open.mock.calls).toEqual([['https://example.com/x']])

    // Without the user in the frame, a page posting on its own opens nothing.
    vi.stubGlobal('navigator', { userActivation: { isActive: false } })
    post('https://example.com/z', 9_000)
    vi.stubGlobal('navigator', { userActivation: { isActive: true } })
    vi.stubGlobal('document', { activeElement: null })
    post('https://example.com/z', 9_000)
    expect(open).toHaveBeenCalledTimes(1)
  })
})
