import { forwardRef } from 'react'
import { StyleSheet, TextInput as RNTextInput, type TextInputProps } from 'react-native'

import { fonts, fontScale } from '@/theme'

/** What the system draws an input at when its style states no size. */
const SYSTEM_SIZE = 17

/**
 * The one TextInput the app renders, so typed text is drawn at the same `fontScale` as
 * the Text around it; mono keeps its size. Everything else is the native input, ref included.
 */
export const TextInput = forwardRef<RNTextInput, TextInputProps>(function TextInput({ style, ...props }, ref) {
  const flat = StyleSheet.flatten(style)
  const scaled = flat?.fontFamily === fonts.mono ? style : [style, { fontSize: (flat?.fontSize ?? SYSTEM_SIZE) * fontScale }]
  return <RNTextInput ref={ref} style={scaled} {...props} />
})

export type TextInput = RNTextInput
