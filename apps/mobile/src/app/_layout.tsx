// Per-cut modules, so the other fourteen cuts of the family stay out of the bundle.
import { Geist_400Regular } from '@expo-google-fonts/geist/400Regular'
import { Geist_400Regular_Italic } from '@expo-google-fonts/geist/400Regular_Italic'
import { Geist_500Medium } from '@expo-google-fonts/geist/500Medium'
import { Geist_500Medium_Italic } from '@expo-google-fonts/geist/500Medium_Italic'
import { useFonts } from 'expo-font'
import { DarkTheme, DefaultTheme, router, Stack, ThemeProvider, useNavigationContainerRef } from 'expo-router'
import { StatusBar } from 'expo-status-bar'
import { useEffect, useRef } from 'react'
import { useColorScheme } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { KeyboardProvider } from 'react-native-keyboard-controller'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { ConnectionProvider } from '@/providers/ConnectionProvider'
import { WorkspaceProvider } from '@/providers/WorkspaceProvider'
import { WindowInsetsProvider } from '@/lib/windowInsets'
import { lockPortrait } from '@/lib/viewerOrientation'
import { chatIdFromNotificationResponse, Notifications } from '@/lib/notifications'
import { notificationOpen } from '@/lib/notificationRoute'
import { colors } from '@/theme'

export default function RootLayout() {
  const scheme = useColorScheme()
  // The app declares every orientation so a full-screen viewer may turn with the phone
  // (see `useTurnsWithPhone`); everything else is held upright from here.
  useEffect(lockPortrait, [])
  // The four cuts of the UI face, from the app bundle rather than the network. Nothing
  // renders until they are registered: an unknown family falls back to the system font
  // silently, which would show as one frame of the wrong typeface on every cold start.
  const [fontsLoaded] = useFonts({
    Geist_400Regular,
    Geist_500Medium,
    Geist_400Regular_Italic,
    Geist_500Medium_Italic,
  })

  if (!fontsLoaded) return null

  return (
    // The inbox rows swipe, and a swipe needs the gesture root above the navigator.
    <GestureHandlerRootView style={{ flex: 1 }}>
      {/* The chat composer sticks to the keyboard through the keyboard controller,
          which tracks the keyboard natively from this provider down. */}
      <KeyboardProvider>
      <SafeAreaProvider>
      <WindowInsetsProvider>
        <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
          <ConnectionProvider>
            <WorkspaceProvider>
              <NotificationNavigation />
              {/* The four tabs and every screen reached from them live one level down,
                  each in its tab's own stack (see `(tabs)/_layout.tsx`). */}
              <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.background } }}>
                <Stack.Screen name="(tabs)" />
              </Stack>
              <StatusBar style="auto" />
            </WorkspaceProvider>
          </ConnectionProvider>
        </ThemeProvider>
      </WindowInsetsProvider>
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
