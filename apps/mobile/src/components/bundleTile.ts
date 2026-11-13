import { createContext } from 'react'
import { StyleSheet } from 'react-native'
import { colors, radius, spacing, squircle } from '@/theme'

/** True inside an open thread bundle, where a Session line draws as one of its tiles instead of a bordered card. */
export const InBundle = createContext(false)

/**
 * In a project thread: the answer notes the user may still replace, by event id, and what
 * opens that choice. Its line, alone or in a bundle, offers "Other answer".
 */
export const AnswerChange = createContext<{ ids: ReadonlySet<string>; onChange: (noteId: string) => void } | null>(null)

export const OTHER_ANSWER = 'Other answer'

/** An open thread bundle's item: a filled tile without a border of its own (the user's Paper states, 2026-10-18). */
export const bundleTile = StyleSheet.create({
  tile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderRadius: radius.sm,
    ...squircle,
    backgroundColor: colors.sidebarFill,
    paddingHorizontal: spacing.md,
    paddingVertical: 9,
  },
})
