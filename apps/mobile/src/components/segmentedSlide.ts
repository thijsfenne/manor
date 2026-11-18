export interface SegmentSlot {
  x: number
  width: number
}

const STEP_MS = 150
const MAX_MS = 360

/** A slide takes one step's time per segment crossed, so a long jump keeps the same speed. */
export function slideDuration(from: number, to: number): number {
  return Math.min(MAX_MS, STEP_MS * Math.max(1, Math.abs(to - from)))
}

/** The segment a press selects. A press on the selected segment or a disabled one changes nothing. */
export function pressedValue<Value extends string>(
  pressed: { value: Value; disabled?: boolean },
  selected: Value,
  controlDisabled: boolean,
): Value | undefined {
  return controlDisabled || pressed.disabled === true || pressed.value === selected ? undefined : pressed.value
}
