import type { BubbleTint } from '@manor/client-runtime/avatar-bubble'
import { createContext, useContext } from 'react'

/**
 * The fill of the bubble a chip sits in. A DM bubble wears the face he is talking to,
 * so the chips inside it take that face's ink and wash instead of the theme's
 * translucent chip, which would sit on the fill at whatever contrast it happened to get.
 */
export const BubbleTintContext = createContext<BubbleTint | undefined>(undefined)

export const useBubbleTint = () => useContext(BubbleTintContext)
