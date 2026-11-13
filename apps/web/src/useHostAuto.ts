import { useSyncExternalStore } from 'react'
import { readHostAuto, subscribeHostAuto } from '@manor/client-runtime/runtime-choices'

/** Whether this host has Auto mode, redrawn when a reconnect brings a different answer. */
export const useHostAuto = (): boolean => useSyncExternalStore(subscribeHostAuto, readHostAuto, readHostAuto)
