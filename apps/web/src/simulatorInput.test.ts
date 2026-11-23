import { describe, expect, it } from 'vitest'
import { decodeScreenConfig, encodeInput, fittedScreen, hidUsage, INPUT_TAG, nextOrientation, screenPoint, screenTurn } from './simulatorInput'

describe('simulator input', () => {
  it('maps a click on the drawn screen to fractions of the frame, turned back into its own axes', () => {
    const box = { left: 100, top: 0, width: 200, height: 100 }
    expect(screenPoint(box, 0, 150, 25)).toEqual({ x: 0.25, y: 0.25 })
    expect(screenPoint(box, 0, 50, 25)).toBeNull()
    expect(screenPoint(box, 0, 50, 25, true)).toEqual({ x: 0, y: 0.25 })
    // Turned a quarter left: the drawn top-left corner is the frame's bottom-left.
    expect(screenPoint(box, 90, 100, 0)).toEqual({ x: 0, y: 1 })
    expect(screenPoint(box, -90, 100, 0)).toEqual({ x: 1, y: 0 })
    expect(screenPoint(box, 180, 100, 0)).toEqual({ x: 1, y: 1 })
  })

  it('turns a tall frame for a sideways device and fits it to the room', () => {
    const tall = { width: 100, height: 200 }
    expect(screenTurn('portrait', tall)).toBe(0)
    expect(screenTurn('landscape_left', tall)).toBe(90)
    expect(screenTurn('landscape_right', tall)).toBe(-90)
    expect(screenTurn('landscape_left', { width: 200, height: 100 })).toBe(0)
    expect(screenTurn('portrait_upside_down', tall)).toBe(180)
    expect(fittedScreen({ width: 300, height: 300 }, tall, 0)).toEqual({ width: 150, height: 300 })
    expect(fittedScreen({ width: 300, height: 300 }, tall, 90)).toEqual({ width: 300, height: 150 })
  })

  it('sends physical keys as HID usages and leaves the rest to the page', () => {
    expect(hidUsage('KeyA')).toBe(0x04)
    expect(hidUsage('KeyZ')).toBe(0x1d)
    expect(hidUsage('Digit1')).toBe(0x1e)
    expect(hidUsage('Digit0')).toBe(0x27)
    expect(hidUsage('Enter')).toBe(0x28)
    expect(hidUsage('F5')).toBeUndefined()
    // Tab stays with the page, so keyboard focus can leave the screen.
    expect(hidUsage('Tab')).toBeUndefined()
  })

  it('frames a message as one tag byte and a JSON body, and reads the screen config back', () => {
    const frame = encodeInput(INPUT_TAG.touch, { type: 'begin', x: 0.5, y: 0.25 })
    expect(frame[0]).toBe(0x03)
    expect(JSON.parse(new TextDecoder().decode(frame.subarray(1)))).toEqual({ type: 'begin', x: 0.5, y: 0.25 })
    const config = encodeInput(0x82, { width: 1206, height: 2622, orientation: 'portrait' })
    expect(decodeScreenConfig(config.slice().buffer)).toEqual({ width: 1206, height: 2622, orientation: 'portrait' })
    expect(decodeScreenConfig(frame.slice().buffer)).toBeUndefined()
  })

  it('turns a quarter at a time', () => {
    expect(nextOrientation('portrait')).toBe('landscape_left')
    expect(nextOrientation('landscape_right')).toBe('portrait')
    expect(nextOrientation(undefined)).toBe('landscape_left')
  })
})
