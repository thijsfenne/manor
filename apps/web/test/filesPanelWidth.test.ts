import { createElement, type PointerEvent } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import {
  BROWSER_DEFAULT_WIDTH,
  BROWSER_MIN_WIDTH,
  clampPanelWidth,
  FILES_DEFAULT_WIDTH,
  FILES_MAX_WIDTH,
  FILES_MIN_WIDTH,
  useRightPanelSize,
} from '../src/useFilesPanel'
import { CHAT_STAGE_MIN_WIDTH as CHAT_MIN_WIDTH, rightPanelOverlays } from '../src/useRightPanel'

describe('files panel width', () => {
  it('keeps the default between its explicit bounds', () => {
    expect(FILES_MIN_WIDTH).toBe(360)
    expect(FILES_DEFAULT_WIDTH).toBe(570)
    expect(FILES_DEFAULT_WIDTH).toBeGreaterThanOrEqual(FILES_MIN_WIDTH)
    expect(FILES_DEFAULT_WIDTH).toBeLessThan(FILES_MAX_WIDTH)
  })

  it('keeps its floor but uses the available window as its practical ceiling', () => {
    expect(clampPanelWidth(120, 1920)).toBe(FILES_MIN_WIDTH)
    expect(clampPanelWidth(600, 1920)).toBe(600)
    expect(clampPanelWidth(2000, 1920)).toBe(1920 - CHAT_MIN_WIDTH)
  })

  it('leaves room for the chat on a narrower window', () => {
    expect(clampPanelWidth(900, 1000)).toBe(1000 - CHAT_MIN_WIDTH)
  })

  it('never drops below the minimum, however little room is left', () => {
    expect(clampPanelWidth(500, 400)).toBe(FILES_MIN_WIDTH)
  })
})

describe('browser panel width', () => {
  const browser = { minWidth: BROWSER_MIN_WIDTH, maxWidth: FILES_MAX_WIDTH }

  it('keeps the default between its own bounds, which are not the files panel’s', () => {
    // The track, not the page: 375 of page plus the 8px gutter the card floats in
    // and the 16px well the native view sits in.
    expect(BROWSER_MIN_WIDTH).toBe(399)
  })

  it('goes narrower than the files panel, down to a phone-width page', () => {
    expect(clampPanelWidth(200, 1920, browser)).toBe(BROWSER_MIN_WIDTH)
    expect(BROWSER_MIN_WIDTH - 24).toBe(375)
  })

  it('is bounded by the window rather than by a number, so a wide screen gives it room', () => {
    // Both content panels keep going until only the chat's own floor is left.
    expect(clampPanelWidth(3_000, 1_920, browser)).toBe(1_920 - CHAT_MIN_WIDTH)
    expect(clampPanelWidth(3_000, 1_920)).toBe(1_920 - CHAT_MIN_WIDTH)
  })

  it('still leaves the chat standing', () => {
    expect(clampPanelWidth(1_400, 1_000, browser)).toBe(1_000 - CHAT_MIN_WIDTH)
  })

  it('never drops below its minimum, however little room is left', () => {
    expect(clampPanelWidth(900, 400, browser)).toBe(BROWSER_MIN_WIDTH)
  })
})

describe('a panel on a window that changes size', () => {
  it('shrinks an oversized overlay from its visible edge without jumping or a dead zone', () => {
    let panel: ReturnType<typeof useRightPanelSize>
    const Probe = ({ viewport }: { viewport: number }) => {
      panel = useRightPanelSize('chat', 'files', viewport)
      return null
    }
    const tree = create(createElement(Probe, { viewport: 1_000 }))
    const target = {
      parentElement: { getBoundingClientRect: () => ({ width: 548 }) },
      setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn(),
    }
    const pointer = (clientX: number) => ({
      button: 0, pointerId: 1, clientX, currentTarget: target, preventDefault: vi.fn(),
    }) as unknown as PointerEvent<HTMLDivElement>
    vi.stubGlobal('document', { body: { style: { cursor: '', userSelect: '' } } })
    try {
      act(() => tree.update(createElement(Probe, { viewport: 900 })))
      expect(panel!.width).toBe(FILES_DEFAULT_WIDTH)
      act(() => panel!.resizeProps.onPointerDown(pointer(100)))
      expect(panel!.resizeProps['data-panel-resizing']).toBe(true)
      act(() => panel!.resizeProps.onPointerMove(pointer(116)))
      expect(panel!.width).toBe(556 - 16)
      act(() => panel!.resizeProps.onPointerMove(pointer(84)))
      expect(panel!.width).toBe(556)
      act(() => panel!.resizeProps.onPointerMove(pointer(164)))
      expect(panel!.width).toBe(556 - 64)
      act(() => panel!.resizeProps.onPointerUp(pointer(116)))
      expect(panel!.resizing).toBe(false)
      expect(panel!.resizeProps['data-panel-resizing']).toBeUndefined()
      expect(target.releasePointerCapture).toHaveBeenCalledWith(1)
    } finally {
      act(() => tree.unmount())
      vi.unstubAllGlobals()
    }
  })

  const RESERVED = 288 + 44

  /** The shared right-panel width as the hook reports it at a given window width. */
  const widthAt = (viewportWidth: number) => {
    let width = 0
    const Probe = () => {
      width = useRightPanelSize('chat', 'files', viewportWidth).width
      return null
    }
    let tree: ReturnType<typeof create> | undefined
    act(() => {
      tree = create(createElement(Probe))
    })
    act(() => tree?.unmount())
    return width
  }

  it('keeps its chosen width when the thread gets narrower', () => {
    expect(widthAt(1_512)).toBe(FILES_DEFAULT_WIDTH)
    expect(widthAt(1_100)).toBe(FILES_DEFAULT_WIDTH)
  })

  it('floats when docking that width would squeeze the chat', () => {
    expect(rightPanelOverlays(1_100, RESERVED, widthAt(1_100))).toBe(true)
    expect(rightPanelOverlays(1_512, RESERVED, widthAt(1_512))).toBe(false)
  })

  it('takes the room back when the window is widened again', () => {
    // Borrowed, not spent: a window narrowed for a minute may not overwrite a width
    // that was chosen deliberately.
    widthAt(1_100)
    expect(widthAt(1_512)).toBe(FILES_DEFAULT_WIDTH)
  })
})

describe('what a panel measures the chat against', () => {
  it('is the stage, not the window: the sidebar and the rail are already spent', () => {
    const browser = { minWidth: BROWSER_MIN_WIDTH, maxWidth: FILES_MAX_WIDTH }
    const reserved = 288 + 44

    // Against the bare viewport the panel would happily leave the chat 288px of
    // sidebar and 44px of rail wide, which is exactly no chat at all.
    expect(clampPanelWidth(1_500, 1_440, browser)).toBe(1_440 - CHAT_MIN_WIDTH)
    expect(clampPanelWidth(1_500, 1_440 - reserved, browser)).toBe(1_440 - reserved - CHAT_MIN_WIDTH)
  })
})

describe('the right panel width across chats', () => {
  it('is kept per chat and per panel, and a chat that never sized one opens at its default', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('window', {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
        removeItem: (key: string) => void store.delete(key),
      },
    })
    let panel: ReturnType<typeof useRightPanelSize>
    const Probe = ({ chatId, id }: { chatId: string; id: 'files' | 'browser' }) => {
      panel = useRightPanelSize(chatId, id, 1_920)
      return null
    }
    let tree: ReturnType<typeof create> | undefined
    const show = (chatId: string, id: 'files' | 'browser') => act(() => {
      if (tree === undefined) tree = create(createElement(Probe, { chatId, id }))
      else tree.update(createElement(Probe, { chatId, id }))
    })
    try {
      show('chat-a', 'files')
      act(() => panel!.resizeProps.onKeyDown({ key: 'ArrowLeft', preventDefault: vi.fn() } as never))
      expect(panel!.width).toBe(FILES_DEFAULT_WIDTH + 16)

      show('chat-a', 'browser')
      expect(panel!.width).toBe(BROWSER_DEFAULT_WIDTH)
      show('chat-b', 'files')
      expect(panel!.width).toBe(FILES_DEFAULT_WIDTH)
      show('chat-a', 'files')
      expect(panel!.width).toBe(FILES_DEFAULT_WIDTH + 16)
    } finally {
      act(() => tree?.unmount())
      vi.unstubAllGlobals()
    }
  })
})
