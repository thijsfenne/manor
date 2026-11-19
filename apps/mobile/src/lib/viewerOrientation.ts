import * as ScreenOrientation from 'expo-screen-orientation'
import { useEffect, useRef, type RefObject } from 'react'
import type { FlatList } from 'react-native'

/** The app stands upright; called once at the root, and again when the last viewer closes. */
export function lockPortrait() {
  ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP).catch(() => {})
}

// A viewer can open over another (a picture in a markdown file), so the app turns back
// upright only once none is left.
let openViewers = 0

/** A full-screen viewer turns with the phone while it is mounted; everything else stays portrait. */
export function useTurnsWithPhone() {
  useEffect(() => {
    openViewers += 1
    if (openViewers === 1) ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.DEFAULT).catch(() => {})
    return () => {
      openViewers -= 1
      if (openViewers === 0) lockPortrait()
    }
  }, [])
}

/** A rotation changes a pager's page width; this scrolls it back to the page it showed. */
export function useKeepPage<T>(pager: RefObject<FlatList<T> | null>, width: number, index: number) {
  const pagedWidth = useRef(width)
  useEffect(() => {
    if (pagedWidth.current === width) return
    pagedWidth.current = width
    pager.current?.scrollToIndex({ index, animated: false })
  }, [pager, width, index])
}
