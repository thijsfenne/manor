import type { DriverName, Effort } from '@manor/contracts'
import { EFFORTS, MODELS, PROVIDERS, effortsFor } from './runtimes'

/** The providers a subagent can run on, in the catalog's order. The mock is a test double. */
export const SUBAGENT_DRIVERS = ['claude', 'codex', 'grok', 'cursor'] as const satisfies readonly DriverName[]

export const providerLabel = (driver: DriverName): string =>
  PROVIDERS.find((option) => option.value === driver)?.label ?? driver

export const effortLabel = (effort: Effort): string =>
  EFFORTS.find((option) => option.value === effort)?.label ?? effort

/** Keeps a picked list in catalog order, so the saved policy reads the same for the same picks. */
export const inOrder = <T extends string>(all: readonly T[], picked: ReadonlySet<T>): T[] =>
  all.filter((value) => picked.has(value))

export const ALL_MODELS: string[] = SUBAGENT_DRIVERS.flatMap((driver) => MODELS[driver].map((option) => option.value))
export const ALL_EFFORTS: Effort[] = EFFORTS.map((option) => option.value)

/**
 * The selected models a level list leaves narrower than the list says, or with
 * nothing at all. Most models run every level, so only the exceptions are worth a
 * line: twenty rows repeating the list above would bury the two that matter.
 */
export function narrowerModels(models: readonly string[], efforts: readonly Effort[]) {
  return SUBAGENT_DRIVERS.flatMap((driver) => MODELS[driver]
    .filter((option) => models.includes(option.value))
    .map((option) => ({
      label: option.label,
      efforts: effortsFor(driver, option.value).map((level) => level.value).filter((level) => efforts.includes(level)),
    }))
    .filter((entry) => entry.efforts.length < efforts.length))
}
