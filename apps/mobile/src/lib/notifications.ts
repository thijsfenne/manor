import Constants from 'expo-constants'
import * as Notifications from 'expo-notifications'
import { Platform } from 'react-native'

// Manor already shows the live turn while it is in front. Keep the system banner
// for the background and notification centre, the same refusal desktop applies.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: false,
    shouldSetBadge: false,
    shouldShowBanner: false,
    shouldShowList: false,
  }),
})

export async function registerForPushNotifications(): Promise<string | null> {
  if (Platform.OS === 'web') return null
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'Manor',
        importance: Notifications.AndroidImportance.DEFAULT,
      })
    }

    const current = await Notifications.getPermissionsAsync()
    const permission = current.status === 'granted'
      ? current
      : await Notifications.requestPermissionsAsync()
    if (permission.status !== 'granted') return null

    const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId
    if (typeof projectId !== 'string' || projectId === '') {
      console.warn('manor mobile cannot register for push: the Expo project id is missing')
      return null
    }
    return (await Notifications.getExpoPushTokenAsync({ projectId })).data
  } catch (error) {
    console.warn('manor mobile could not obtain a push token', error)
    return null
  }
}

/** Native provider tokens can rotate while an install stays put. */
export function onPushTokenChanged(refresh: () => void): () => void {
  const listener = Notifications.addPushTokenListener(refresh)
  return () => listener.remove()
}

/** Stop this install at APNs/FCM and report whether that logout fallback is safe. */
export async function unregisterForPushNotifications(): Promise<boolean> {
  try {
    await Notifications.unregisterForNotificationsAsync()
    return true
  } catch (error) {
    console.warn('manor mobile could not unregister from push notifications', error)
    return false
  }
}

export function chatIdFromNotificationResponse(
  response: Notifications.NotificationResponse | null | undefined,
): string | null {
  const chatId = response?.notification.request.content.data?.chatId
  return typeof chatId === 'string' && chatId !== '' ? chatId : null
}

export { Notifications }
