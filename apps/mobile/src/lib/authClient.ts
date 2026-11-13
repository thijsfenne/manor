import 'react-native-url-polyfill/auto'
import { ManorAuthClient } from '@manor/client-runtime/auth'
import { deleteItemAsync, getItemAsync, setItemAsync } from 'expo-secure-store'
import { authEnabled, httpOrigin } from './config'

export const authClient = authEnabled ? new ManorAuthClient(httpOrigin, {
  getItem: getItemAsync,
  setItem: setItemAsync,
  removeItem: deleteItemAsync,
}) : null
