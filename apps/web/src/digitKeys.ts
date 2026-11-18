/**
 * Keys a count's digits by place, counted from the right where a count changes, and by
 * value. A digit keeps its key while it holds, so going from 128 to 131 keeps the 1 and
 * remounts the 3 and the 1 after it, and 99 to 100 remounts all three.
 */
export function digitKeys(value: number): string[] {
  const text = String(value)
  return [...text].map((digit, index) => `${text.length - 1 - index}:${digit}`)
}
