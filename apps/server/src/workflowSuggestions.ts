import { readFile } from 'node:fs/promises'
import type { WorkflowSuggestion, WorkflowSuggestionStatus } from '@manor/contracts'

const STATUSES = new Set<WorkflowSuggestionStatus>([
  'watching',
  'ready',
  'proposed',
  'building',
  'shipped',
  'dismissed',
  'existing-skill',
])

/** Splits a controlled markdown table row without treating escaped pipes as columns. */
export function markdownCells(line: string): string[] {
  const cells: string[] = []
  let cell = ''
  let escaped = false
  for (const character of line) {
    if (escaped) {
      cell += character
      escaped = false
      continue
    }
    if (character === '\\') {
      cell += character
      escaped = true
      continue
    }
    if (character === '|') {
      cells.push(cell.trim())
      cell = ''
      continue
    }
    cell += character
  }
  cells.push(cell.trim())
  return cells.slice(1, line.trimEnd().endsWith('|') ? -1 : undefined)
}

const candidateName = (value: string): { id: string; name: string } | null => {
  const match = value.match(/`([^`]+)`/)
  const id = (match?.[1] ?? value.replace(/\s*\([^)]*\)\s*$/, '')).trim()
  if (id.length === 0 || id.length > 200) return null
  const words = id.replace(/[-_]+/g, ' ')
  return { id, name: words.charAt(0).toUpperCase() + words.slice(1) }
}

const candidateStatus = (value: string): WorkflowSuggestionStatus | null => {
  const status = value.trim().split(/\s+/, 1)[0]?.toLowerCase()
  return status !== undefined && STATUSES.has(status as WorkflowSuggestionStatus)
    ? status as WorkflowSuggestionStatus
    : null
}

/** Parses only the six-column Candidates ledger. Explanatory tables are ignored. */
export function parseWorkflowSuggestions(markdown: string): WorkflowSuggestion[] {
  const rows = markdown.split('\n')
  const header = rows.findIndex((line) => line.trim().startsWith('| Candidate |'))
  if (header === -1) return []

  const suggestions: WorkflowSuggestion[] = []
  for (const line of rows.slice(header + 2)) {
    if (line.trim() === '') continue
    if (!line.trimStart().startsWith('|')) break
    const cells = markdownCells(line)
    if (cells.length !== 6) continue
    const [candidate, description, occurrences, corrections, existingCoverage, statusDetail] = cells
    if (
      candidate === undefined ||
      description === undefined ||
      occurrences === undefined ||
      corrections === undefined ||
      existingCoverage === undefined ||
      statusDetail === undefined
    ) continue
    const named = candidateName(candidate)
    const status = candidateStatus(statusDetail)
    if (named === null || status === null) continue
    suggestions.push({
      ...named,
      description,
      occurrences,
      corrections,
      existingCoverage,
      status,
      statusDetail,
    })
  }
  return suggestions
}

/** `null` means this host has no memory ledger. Malformed rows fail soft individually. */
export async function readWorkflowSuggestions(filePath: string): Promise<WorkflowSuggestion[] | null> {
  try {
    return parseWorkflowSuggestions(await readFile(filePath, 'utf8'))
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
