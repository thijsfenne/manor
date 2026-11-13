import { useFocusEffect } from 'expo-router'
import { useCallback, useState } from 'react'

/** True while another screen stands on top of this one in the stack. */
export function useScreenCovered(): boolean {
  const [covered, setCovered] = useState(false)
  useFocusEffect(useCallback(() => {
    setCovered(false)
    return () => setCovered(true)
  }, []))
  return covered
}
