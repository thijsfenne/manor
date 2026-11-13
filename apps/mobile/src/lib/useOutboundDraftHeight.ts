import { useWindowDimensions } from 'react-native'
import { useKeyboardState } from 'react-native-keyboard-controller'
import { outboundLayout } from '@/theme'

export function useOutboundDraftHeight() {
  const { height } = useWindowDimensions()
  const keyboardHeight = useKeyboardState((state) => state.height)
  return Math.max(0, height - keyboardHeight) * outboundLayout.dockFraction
}
