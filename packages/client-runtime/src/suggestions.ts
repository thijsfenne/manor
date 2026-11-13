import type { WorkflowSuggestion } from '@manor/contracts'

/*
 * The suggestion ledger as both clients read it: the bar, the count read out
 * of the evidence prose, and the queue order. Mac and phone sort and count the same.
 */

/** The ledger's own bar: a workflow earns a proposal after it has recurred three times. */
export const OCCURRENCE_BAR = 3

export const ACTIVE = new Set<WorkflowSuggestion['status']>(['ready', 'proposed', 'building'])
export const WATCHING = new Set<WorkflowSuggestion['status']>(['watching'])

/**
 * How many times this workflow has actually been seen.
 *
 * The ledger states it in prose rather than a column, so the count is read back out
 * of the evidence cell the same way a person reads it: the number that opens the
 * sentence ("4 across 3 projects: …", "5+: …"), otherwise a spelled-out count of
 * occurrences ("0 organic occurrences yet"), otherwise the dated sightings listed.
 * `undefined` means the cell never said, which the tally shows as unknown rather
 * than as zero.
 */
export function occurrenceCount(occurrences: string): number | undefined {
  const opening = occurrences.match(/^\s*(\d+)\s*\+?\s*(?::|across|in\b|time)/i)
  if (opening?.[1] !== undefined) return Number(opening[1])

  const spelled = occurrences.match(/(\d+)\s+(?:\w+\s+)?occurrences?/i)
  if (spelled?.[1] !== undefined) return Number(spelled[1])

  const dated = occurrences.match(/\b\d{1,2}-\d{2}\b/g)
  return dated === null ? undefined : dated.length
}

/** The day a status was reached, when the ledger's status cell carries one. */
export const statusStamp = (statusDetail: string): Date | undefined => {
  const stamp = statusDetail.match(/\b\d{4}-\d{2}-\d{2}\b/)
  if (stamp === null) return undefined
  const date = new Date(`${stamp[0]}T00:00:00`)
  return Number.isNaN(date.getTime()) ? undefined : date
}

/**
 * Loudest first. Inside a group the candidate seen most often sits on top
 * and the thinnest evidence sinks, so the column reads as a queue rather than as the
 * order a markdown table happened to be written in. History has no count left to
 * sort on, so it runs newest first.
 */
export const byWeight = (left: WorkflowSuggestion, right: WorkflowSuggestion): number => {
  const counts = (occurrenceCount(right.occurrences) ?? -1) - (occurrenceCount(left.occurrences) ?? -1)
  if (counts !== 0) return counts
  const dates = (statusStamp(right.statusDetail)?.getTime() ?? 0) - (statusStamp(left.statusDetail)?.getTime() ?? 0)
  return dates !== 0 ? dates : left.name.localeCompare(right.name)
}
