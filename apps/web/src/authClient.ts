import { ManorAuthClient } from '@manor/client-runtime/auth'

/** Auth travels through the same host as chats. Test servers can explicitly disable it. */
export const authClient = import.meta.env.VITE_MANOR_AUTH === 'off'
  ? null
  : new ManorAuthClient(import.meta.env.VITE_MANOR_HTTP ?? (import.meta.env.VITE_MANOR_WS?.replace(/^ws/, 'http').replace(/\/ws$/, '') || window.location.origin), window.localStorage)
