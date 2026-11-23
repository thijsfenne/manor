/**
 * The simulator screen's wire, as the screen helper speaks it on its input socket:
 * one tag byte, then a JSON body. Touch points are fractions of the screen (0..1),
 * keys are USB HID usages, so neither depends on the device's pixel size.
 */
export const INPUT_TAG = { touch: 0x03, button: 0x04, key: 0x06, orientation: 0x07 } as const
/** The helper's push of the screen's size and orientation. */
export const SCREEN_CONFIG_TAG = 0x82

export type Orientation = 'portrait' | 'landscape_left' | 'portrait_upside_down' | 'landscape_right'
const ORIENTATIONS: readonly Orientation[] = ['portrait', 'landscape_left', 'portrait_upside_down', 'landscape_right']

/** A quarter turn from where the device stands now; before the helper says, it stands upright. */
export function nextOrientation(current: string | undefined): Orientation {
  const index = Math.max(0, ORIENTATIONS.indexOf(current as Orientation))
  return ORIENTATIONS[(index + 1) % ORIENTATIONS.length] ?? 'portrait'
}

export function encodeInput(tag: number, body: object): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(body))
  const frame = new Uint8Array(json.length + 1)
  frame[0] = tag
  frame.set(json, 1)
  return frame
}

/** The screen config in a helper message, or undefined for anything else. */
export function decodeScreenConfig(data: ArrayBuffer): { width: number; height: number; orientation: string } | undefined {
  const bytes = new Uint8Array(data)
  if (bytes[0] !== SCREEN_CONFIG_TAG) return undefined
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes.subarray(1)))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const { width, height, orientation } = parsed as Record<string, unknown>
    return typeof width === 'number' && typeof height === 'number' && typeof orientation === 'string'
      ? { width, height, orientation }
      : undefined
  } catch {
    return undefined
  }
}

/**
 * How far the picture turns on screen. The helper streams the device's framebuffer in
 * its own upright shape, so a phone turned sideways still arrives as a tall frame and
 * the picture is turned to match. A frame that already arrives wide needs no turn.
 */
export function screenTurn(orientation: string | undefined, frame: { width: number; height: number }): 0 | 90 | -90 | 180 {
  if (orientation === 'portrait_upside_down') return 180
  if (frame.width > frame.height) return 0
  return orientation === 'landscape_left' ? 90 : orientation === 'landscape_right' ? -90 : 0
}

/**
 * Where a pointer lands on the device, as fractions of its framebuffer. `box` is the
 * screen as drawn, turn included; the point is read there, then turned back into the
 * frame's own axes. Off the screen gives null, unless `clamp` holds a drag that started
 * on it to the edge, so the finger lifts where the device can feel it.
 */
export function screenPoint(
  box: { left: number; top: number; width: number; height: number },
  turn: 0 | 90 | -90 | 180,
  clientX: number,
  clientY: number,
  clamp = false,
): { x: number; y: number } | null {
  if (box.width <= 0 || box.height <= 0) return null
  let x = (clientX - box.left) / box.width
  let y = (clientY - box.top) / box.height
  if (clamp) {
    x = Math.min(1, Math.max(0, x))
    y = Math.min(1, Math.max(0, y))
  } else if (x < 0 || x > 1 || y < 0 || y > 1) return null
  if (turn === 90) return { x: y, y: 1 - x }
  if (turn === -90) return { x: 1 - y, y: x }
  if (turn === 180) return { x: 1 - x, y: 1 - y }
  return { x, y }
}

/** The largest size of the drawn screen that fits `room`, the frame's sides swapped when it turns sideways. */
export function fittedScreen(
  room: { width: number; height: number },
  frame: { width: number; height: number },
  turn: 0 | 90 | -90 | 180,
): { width: number; height: number } {
  const sideways = turn === 90 || turn === -90
  const width = sideways ? frame.height : frame.width
  const height = sideways ? frame.width : frame.height
  const scale = Math.max(0, Math.min(room.width / width, room.height / height))
  return { width: width * scale, height: height * scale }
}

const NAMED_KEYS: Record<string, number> = {
  Enter: 0x28, NumpadEnter: 0x28, Escape: 0x29, Backspace: 0x2a, Space: 0x2c,
  Minus: 0x2d, Equal: 0x2e, BracketLeft: 0x2f, BracketRight: 0x30, Backslash: 0x31,
  Semicolon: 0x33, Quote: 0x34, Backquote: 0x35, Comma: 0x36, Period: 0x37, Slash: 0x38,
  Delete: 0x4c, ArrowRight: 0x4f, ArrowLeft: 0x50, ArrowDown: 0x51, ArrowUp: 0x52,
  ControlLeft: 0xe0, ShiftLeft: 0xe1, AltLeft: 0xe2, MetaLeft: 0xe3,
  ControlRight: 0xe4, ShiftRight: 0xe5, AltRight: 0xe6, MetaRight: 0xe7,
}

/**
 * The HID usage for a physical key (`KeyboardEvent.code`), so the device's own keyboard
 * layout decides the character, as a hardware keyboard would. Undefined for keys it has
 * no use for, which then stay with the page; Tab is one, so focus can leave the screen.
 */
export function hidUsage(code: string): number | undefined {
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return 0x04 + letter[1]!.charCodeAt(0) - 65
  const digit = /^Digit([0-9])$/.exec(code)
  if (digit) return digit[1] === '0' ? 0x27 : 0x1e + Number(digit[1]) - 1
  return NAMED_KEYS[code]
}
