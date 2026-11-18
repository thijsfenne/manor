import type { AgentConfig } from '@manor/contracts'

/**
 * What the providers actually offer, as the form should present it. Every value in
 * this file was read off the installed CLIs (last refreshed for Codex on 2026-09-29)
 * rather than remembered:
 * the model ids from `claude --help`, `codex debug models` on the bundled CLI,
 * and Cursor's `agent --list-models`; the effort levels from the respective CLI flags, the tool
 * names by asking `claude --tools <name>`
 * which of them resolved. A name that does not resolve is silently dropped by the
 * CLI, which is the worst failure this form could ship, so nothing unverified is
 * offered as a choice here.
 */

export interface Option<T extends string> {
  value: T
  label: string
}

export const PROVIDERS: Option<AgentConfig['driver']>[] = [
  { value: 'claude', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'grok', label: 'Grok Build' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'mock', label: 'Mock (no provider)' },
]

export { MODELS, EFFORTS, CATALOG_DRIVERS, defaultModel, landingModel, everyModelOff, modelLabel, effortsFor, clampsEffort } from '@manor/contracts'
