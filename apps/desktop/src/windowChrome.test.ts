import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { bindPageFullscreen, isZoomShortcut, nextZoomLevel, trafficLightPositionForZoom, TRAFFIC_LIGHT_X } from './windowChrome'

describe('trafficLightPositionForZoom', () => {
  it('leaves X at 18 and keeps the lights on the zoomed top bar\'s centre line', () => {
    expect(trafficLightPositionForZoom(1)).toEqual({ x: TRAFFIC_LIGHT_X, y: 12 })
    expect(trafficLightPositionForZoom(0.8)).toEqual({ x: TRAFFIC_LIGHT_X, y: 8 })
    expect(trafficLightPositionForZoom(0.5)).toEqual({ x: TRAFFIC_LIGHT_X, y: 3 })
    expect(trafficLightPositionForZoom(1.2)).toEqual({ x: TRAFFIC_LIGHT_X, y: 16 })
  })

  it('treats a missing zoom as 1 rather than parking the lights at 0,0', () => {
    expect(trafficLightPositionForZoom(Number.NaN)).toEqual({ x: TRAFFIC_LIGHT_X, y: 12 })
    expect(trafficLightPositionForZoom(0)).toEqual({ x: TRAFFIC_LIGHT_X, y: 12 })
  })
})

describe('isZoomShortcut', () => {
  it('matches Cmd+/−/0 and ignores anything else', () => {
    expect(isZoomShortcut({ type: 'keyDown', key: '-', meta: true, control: false })).toBe(true)
    expect(isZoomShortcut({ type: 'keyDown', key: '=', meta: true, control: false })).toBe(true)
    expect(isZoomShortcut({ type: 'keyDown', key: '0', meta: false, control: true })).toBe(true)
    expect(isZoomShortcut({ type: 'keyDown', key: '-', meta: false, control: false })).toBe(false)
    expect(isZoomShortcut({ type: 'keyUp', key: '-', meta: true, control: false })).toBe(false)
  })
})

describe('nextZoomLevel', () => {
  it('steps by Chromium\'s half-level and resets on 0', () => {
    expect(nextZoomLevel(0, '-')).toBe(-0.5)
    expect(nextZoomLevel(-0.5, '-')).toBe(-1)
    expect(nextZoomLevel(-0.5, '=')).toBe(0)
    expect(nextZoomLevel(-1, '0')).toBe(0)
  })

  it('stops at the chrome clamp rather than shrinking the page to nothing', () => {
    expect(nextZoomLevel(-3, '-')).toBe(-3)
    expect(nextZoomLevel(3, '=')).toBe(3)
  })
})

describe('bindPageFullscreen', () => {
  // Electron on macOS: a change is an animation that reports the old state until
  // it lands, a change asked for mid-animation queues, one matching the current
  // state is ignored, and a landed exit ends any page fullscreen. Shell and guest
  // each report page changes, so every one arrives twice.
  const electronWindow = (fullscreen: boolean) => {
    const window = Object.assign(new EventEmitter(), {
      fullscreen,
      page: false,
      animating: null as boolean | null,
      queued: [] as boolean[],
      isFullScreen: () => window.fullscreen,
      setFullScreen: (next: boolean) => {
        if (window.animating !== null) {
          if ((window.queued.at(-1) ?? !next) !== next) window.queued.push(next)
          return
        }
        if (next !== window.fullscreen) window.animating = next
      },
      pageChange: (enter: boolean) => {
        window.page = enter
        const event = enter ? 'enter-html-full-screen' : 'leave-html-full-screen'
        window.emit(event)
        window.emit(event)
      },
      land: () => {
        while (window.animating !== null) {
          window.fullscreen = window.animating
          window.animating = null
          if (!window.fullscreen && window.page) window.pageChange(false)
          window.emit(window.fullscreen ? 'enter-full-screen' : 'leave-full-screen')
          while (window.animating === null && window.queued.length > 0) window.setFullScreen(window.queued.shift()!)
        }
      },
    })
    bindPageFullscreen(window)
    return window
  }

  it('fills the screen from a normal window and gives the window back on exit', () => {
    const window = electronWindow(false)
    window.pageChange(true)
    window.land()
    expect(window.fullscreen).toBe(true)
    window.pageChange(false)
    window.land()
    expect(window.fullscreen).toBe(false)
  })

  it('ends windowed when the video comes back during the exit animation', () => {
    const window = electronWindow(false)
    window.pageChange(true)
    window.land()
    window.pageChange(false)
    window.pageChange(true)
    window.land()
    // Electron ended the returning video when the exit landed; nothing may reopen Manor.
    expect(window).toMatchObject({ fullscreen: false, page: false, animating: null })
  })

  it('keeps the video fullscreen when it leaves and returns during the enter animation', () => {
    const window = electronWindow(false)
    window.pageChange(true)
    window.pageChange(false)
    window.pageChange(true)
    window.land()
    expect(window).toMatchObject({ fullscreen: true, page: true })
    window.pageChange(false)
    window.land()
    expect(window.fullscreen).toBe(false)
  })

  it('leaves an already fullscreen Manor fullscreen after the video exits', () => {
    const window = electronWindow(true)
    window.pageChange(true)
    window.land()
    window.pageChange(false)
    window.land()
    expect(window.fullscreen).toBe(true)
  })
})
