import { useLayoutEffect, useRef, useState } from 'react'

/**
 * A function that keeps one identity for the component's lifetime and always calls the
 * latest `fn`. For handlers handed to memoized rows, observers and effects that must
 * not resubscribe when the closure changes. The latest `fn` lands in a layout effect,
 * so events and later effects of the same commit already call it; never call the
 * result during render.
 */
export function useStableCallback<Args extends unknown[], Result>(fn: (...args: Args) => Result): (...args: Args) => Result {
  const latest = useRef(fn)
  useLayoutEffect(() => {
    latest.current = fn
  })
  const [stable] = useState(() => (...args: Args) => latest.current(...args))
  return stable
}
