import type { ReactNode } from 'react'
import { Modal } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { useTurnsWithPhone } from '@/lib/viewerOrientation'

/**
 * The full-screen modal a viewer draws in. It turns with the phone while open. A modal is
 * its own native root, and the screen under it stays as it was, so it brings its own
 * gesture root and its own safe area: read insets with `useSafeAreaInsets` inside it.
 */
export function ViewerModal({ transparent = false, onClose, children }: { transparent?: boolean; onClose: () => void; children: ReactNode }) {
  useTurnsWithPhone()
  return (
    <Modal
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
      supportedOrientations={['portrait', 'landscape-left', 'landscape-right']}
      transparent={transparent}
      visible
    >
      <GestureHandlerRootView style={{ flex: 1 }}>
        {/* A fragment, because this package still types its children with React 18. */}
        <SafeAreaProvider><>{children}</></SafeAreaProvider>
      </GestureHandlerRootView>
    </Modal>
  )
}
