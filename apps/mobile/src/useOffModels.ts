import { useSyncExternalStore } from 'react'
import { readOffModels, subscribeOffModels } from '@manor/client-runtime/runtime-choices'

/** The models turned off in Settings on the Mac, redrawn when the house settings change. */
export const useOffModels = (): readonly string[] => useSyncExternalStore(subscribeOffModels, readOffModels, readOffModels)
