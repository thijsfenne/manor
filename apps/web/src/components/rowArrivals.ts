import { createContext, type MutableRefObject } from 'react'

/**
 * Which rows a transcript already held once its history was in. A card asks at mount
 * whether it is new: one that arrives while the chat is open may announce itself, one
 * that was there on open, on reconnect or on scrolling back stays still.
 */
export interface RowArrivals {
  ready: boolean
  known: ReadonlySet<string>
}

export const RowArrivalsContext = createContext<MutableRefObject<RowArrivals> | null>(null)
