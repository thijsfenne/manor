import { createContext } from 'react'

/** An open thread bundle's item: a filled tile without a border of its own (Paper states, 2026-10-18). */
export const BUNDLE_TILE = 'flex w-full min-w-0 gap-2.5 rounded-lg bg-surface-2 px-3 py-2.25 text-left text-[13px] leading-4'
/** A tile that opens something steps further from the card on hover, in either theme. */
export const BUNDLE_TILE_HOVER = 'hover:bg-user-bg'

/** True inside an open thread bundle, where a Session line draws as one of its tiles instead of a bordered card. */
export const InBundle = createContext(false)

/**
 * In a project thread: the answer notes the user may still replace, by event id, and what
 * opens that choice. Its line, alone or in a bundle, offers "Other answer".
 */
export const AnswerChange = createContext<{ ids: ReadonlySet<string>; onChange: (noteId: string) => void } | null>(null)

/** The words of that action, the same on the line and the tile. */
export const OTHER_ANSWER = 'Other answer'
