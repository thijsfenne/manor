import {
  Figtree_400Regular,
  Figtree_400Regular_Italic,
  Figtree_500Medium,
  Figtree_500Medium_Italic,
} from '@expo-google-fonts/figtree'
import { useFonts } from 'expo-font'
import { DarkTheme, DefaultTheme, router, Stack, ThemeProvider, useNavigationContainerRef } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useEffect, useRef } from 'react'
import { useColorScheme } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { AuthProvider } from '@/providers/AuthProvider'
import { WorkspaceProvider } from '@/providers/WorkspaceProvider'
import { chatIdFromNotificationResponse, Notifications } from '@/lib/notifications'
import { notificationOpen } from '@/lib/notificationRoute'
import { colors, fonts } from '@/theme'

export default function RootLayout() {
  const scheme = useColorScheme()
  // The four cuts of the UI face, from the app bundle rather than the network. Nothing
  // renders until they are registered: an unknown family falls back to the system font
  // silently, which would show as one frame of the wrong typeface on every cold start.
  const [fontsLoaded] = useFonts({
    Figtree_400Regular,
    Figtree_500Medium,
    Figtree_400Regular_Italic,
    Figtree_500Medium_Italic,
  })

  if (!fontsLoaded) return null

  return (
    // The inbox rows swipe, and a swipe needs the gesture root above the navigator.
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/* The chat composer sticks to the keyboard through the keyboard controller,
          which tracks the keyboard natively from this provider down. */}
      <KeyboardProvider>
      <SafeAreaProvider>
        <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
          <AuthProvider>
            <WorkspaceProvider>
              <NotificationNavigation />
              <Stack
                screenOptions={{
                  contentStyle: { backgroundColor: colors.background },
                  // The left edge belongs to the house menu, not to a browser's history.
                  // Only a screen that sits one level inside a room turns the back swipe
                  // back on, and it lands on that room; the rooms themselves replace each
                  // other, so there is no visited-rooms trail to swipe through.
                  gestureEnabled: false,
                  // A screen two or more steps under the top stops re-rendering on every
                  // streamed event; it catches up when the screen above it closes.
                  freezeOnBlur: true,
                  headerBackButtonDisplayMode: 'minimal',
                  headerStyle: { backgroundColor: colors.background },
                  headerShadowVisible: false,
                  headerTintColor: colors.text,
                  // A native header title is not our Text, so it names the Medium cut itself.
                  headerTitleStyle: { fontFamily: fonts.sansMedium },
                }}
              >
                <Stack.Screen name="index" options={{ headerShown: false }} />
                <Stack.Screen
                  name="new-chat"
                  options={{
                    gestureEnabled: true,
                    headerShown: false,
                  }}
                />
                <Stack.Screen name="chat/[id]" options={{ gestureEnabled: true, headerShown: false }} />
                <Stack.Screen name="subagent/[callId]" options={{ gestureEnabled: true, headerShown: false }} />
                {/* A project's Sessions, one step behind its thread; back lands on the thread. */}
                <Stack.Screen name="sessions/[threadId]" options={{ gestureEnabled: true, headerShown: false }} />
                <Stack.Screen name="direct" options={{ headerShown: false }} />
                <Stack.Screen name="routines" options={{ headerShown: false }} />
                <Stack.Screen name="plugins" options={{ headerShown: false }} />
                <Stack.Screen name="knowledge" options={{ headerShown: false }} />
                <Stack.Screen name="artifacts" options={{ headerShown: false }} />
                <Stack.Screen name="usage" options={{ headerShown: false }} />
              </Stack>
              <StatusBar style="auto" />
            </WorkspaceProvider>
          </AuthProvider>
        </ThemeProvider>
      </SafeAreaProvider>
      </KeyboardProvider>
    </GestureHandlerRootView>
  )
}

function NotificationNavigation() {
  const response = Notifications.useLastNotificationResponse()
  const navigation = useNavigationContainerRef()
  const handled = useRef<string | null>(null)

  useEffect(() => {
    const chatId = chatIdFromNotificationResponse(response)
    const responseId = response?.notification.request.identifier ?? null
    if (chatId === null || responseId === null || handled.current === responseId) return
    handled.current = responseId
    void Notifications.clearLastNotificationResponseAsync()
    const open = notificationOpen(navigation.isReady() ? navigation.getRootState() : undefined, chatId)
    if (open === 'stay') return
    if (open === 'reset') router.dismissAll()
    router.push({ pathname: '/chat/[id]', params: { id: chatId } })
  }, [navigation, response])

  return null
}
