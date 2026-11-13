import type { AgentConfig, Driver } from '@manor/contracts'

/** One way to run a side job: a runtime, the model it should use there, and the driver that reaches it. */
export interface SideAttempt {
  driver: Driver
  runtime: AgentConfig['driver']
  model: string
}

/**
 * The attempts a side job (a chat title, a summary, a commit message, the daily log)
 * should make right now, read fresh every time the job walks them.
 *
 * Each job names the providers it prefers, with a small model picked for it. Those it
 * keeps, in its own order, as long as the provider can answer. Every other provider
 * that can answer follows as a stand-in, so an install that only signed in to Grok or
 * Cursor still gets titles and a daily log instead of a job that fails twice and
 * gives up. A provider that is missing or signed out is not tried at all.
 */
export function liveAttempts(
  preferred: readonly SideAttempt[],
  usable: () => readonly AgentConfig['driver'][],
  standIn: (provider: AgentConfig['driver']) => SideAttempt | undefined,
): Iterable<SideAttempt> {
  return {
    [Symbol.iterator]: () => {
      const able = usable()
      const own = preferred.filter((attempt) => able.includes(attempt.runtime))
      const others = able
        .filter((provider) => !preferred.some((attempt) => attempt.runtime === provider))
        .flatMap((provider) => standIn(provider) ?? [])
      return [...own, ...others].values()
    },
  }
}
