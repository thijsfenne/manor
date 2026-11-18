import { useEffect, useState } from 'react'

import { LIQUID_GLASS_AVAILABLE } from '@/components/GlassSurface'

/**
 * Glass that a transcript row creates in the first moments after its chat opens stays
 * clear for good, while the same glass made half a second later renders. Use the
 * answer as the `key` of the glass control, which re-creates it once at that point.
 * Pass `false` for a control that has no glass; nothing is scheduled where the
 * native material is missing either.
 */
export function useGlassSettle(glass = true) {
  const [settled, setSettled] = useState(0)
  useEffect(() => {
    if (!glass || !LIQUID_GLASS_AVAILABLE) return undefined
    const timer = setTimeout(() => setSettled(1), 500)
    return () => clearTimeout(timer)
  }, [glass])
  return settled
}
