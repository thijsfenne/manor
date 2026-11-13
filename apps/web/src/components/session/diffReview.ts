import { createContext, useContext } from 'react'

/**
 * Opens one turn's changes in the diff pane beside the chat. Provided per chat where
 * that pane exists; a changed-files card outside one offers no Review.
 */
export const DiffReviewContext = createContext<((turnId: string) => void) | undefined>(undefined)

export const useDiffReview = () => useContext(DiffReviewContext)
