import { useLayoutEffect, useRef } from 'react'

/**
 * `value` as of the last commit: during the render that changes it, the value it had
 * on screen until now. The mark moves after the commit, never during the render, so
 * a render React runs twice before committing (state set while rendering) sees the
 * same answer both times.
 *
 * Deliberately outside the React Compiler's file list: reading a ref during render is
 * the whole point here, and the compiler refuses a component that does it. A compiled
 * caller gets a plain value back.
 */
export function useLastCommitted<T>(value: T): T {
  const committed = useRef(value)
  useLayoutEffect(() => {
    committed.current = value
  })
  return committed.current
}
