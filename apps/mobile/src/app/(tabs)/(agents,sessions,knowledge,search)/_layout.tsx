import { Stack } from 'expo-router'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { colors, fonts } from '@/theme'

/** Each tab's own first screen; everything else in this folder is shared by the four stacks. */
const ROOTS: Record<string, string> = {
  '(agents)': 'index',
  '(sessions)': 'sessions',
  '(knowledge)': 'knowledge',
  '(search)': 'search',
}

/**
 * One stack per tab, so a chat, a room from the house menu or a new Session opens
 * inside the tab it was reached from; the tab bar stays under all but a room, which hides
 * it (see the tabs layout). Tapping the
 * current tab again pops its stack back to the root list (the native tab bar does it).
 *
 * The provider is nested on purpose: inside a tab its bottom inset is the tab bar plus
 * the home indicator, so every footer that pads by `insets.bottom` rests on the bar
 * and the keyboard math above it stays the same.
 */
export default function TabStack({ segment }: { segment: string }) {
  return (
    <SafeAreaProvider>
      <Stack
        initialRouteName={ROOTS[segment]}
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
          // The left edge belongs to the house menu. Only a screen one level inside a
          // room turns the back swipe on; the rooms themselves replace each other.
          gestureEnabled: false,
          // A screen two or more steps under the top stops re-rendering on every
          // streamed event; it catches up when the screen above it closes.
          freezeOnBlur: true,
          headerBackButtonDisplayMode: 'minimal',
          headerStyle: { backgroundColor: colors.background },
          headerShadowVisible: false,
          headerTintColor: colors.text,
          headerTitleStyle: { fontFamily: fonts.sansMedium },
        }}
      >
        <Stack.Screen name="new-chat" options={{ gestureEnabled: true }} />
        <Stack.Screen name="chat/[id]" options={{ gestureEnabled: true }} />
        <Stack.Screen name="subagent/[callId]" options={{ gestureEnabled: true }} />
        {/* A DM's Files, one step behind the chat; back lands on the chat. */}
        <Stack.Screen name="files/[chatId]" options={{ gestureEnabled: true }} />
        {/* A DM's agent overview and its read-only lists, behind the chat. */}
        <Stack.Screen name="agent/[chatId]/index" options={{ gestureEnabled: true }} />
        <Stack.Screen name="agent/[chatId]/[list]" options={{ gestureEnabled: true }} />
      </Stack>
    </SafeAreaProvider>
  )
}
