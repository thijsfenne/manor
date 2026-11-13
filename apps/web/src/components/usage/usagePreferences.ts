import { USAGE_WINDOW_DAYS, type UsageWindowDays } from '@manor/contracts'

export type UsageTab = 'limits' | 'cost'

export interface UsagePreferences {
  tab: UsageTab
  windowDays: UsageWindowDays
}

const KEY = 'manor:usage-page:v1'

/**
 * Limits is what most people open the page for (how much subscription quota is left,
 * and when it resets), so it is the first-visit default; the last picked tab and
 * window stick after that.
 */
export const DEFAULT_USAGE_PREFERENCES: UsagePreferences = { tab: 'limits', windowDays: 30 }

export function readUsagePreferences(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): UsagePreferences {
  try {
    const parsed: unknown = JSON.parse(storage?.getItem(KEY) ?? 'null')
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_USAGE_PREFERENCES
    const { tab, windowDays } = parsed as Record<string, unknown>
    return {
      tab: tab === 'cost' || tab === 'limits' ? tab : DEFAULT_USAGE_PREFERENCES.tab,
      windowDays: USAGE_WINDOW_DAYS.find((days) => days === windowDays) ?? DEFAULT_USAGE_PREFERENCES.windowDays,
    }
  } catch {
    return DEFAULT_USAGE_PREFERENCES
  }
}

export function saveUsagePreferences(
  preferences: UsagePreferences,
  storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage,
): void {
  try {
    storage?.setItem(KEY, JSON.stringify(preferences))
  } catch {
    // A private window without storage keeps the choice for this visit only.
  }
}

/**
 * The one live copy of the preferences. Usage can be mounted twice at once (the stage
 * view stays behind Settings' Usage & limits page), and two copies with their own
 * period would each ask for their own report and overwrite each other's.
 */
const listeners = new Set<() => void>()
let held: UsagePreferences | null = null

export const usagePreferencesStore = {
  get: (): UsagePreferences => (held ??= readUsagePreferences()),
  set(next: UsagePreferences): void {
    held = next
    saveUsagePreferences(next)
    for (const listener of listeners) listener()
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
}
