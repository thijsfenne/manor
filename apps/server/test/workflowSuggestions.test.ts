import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ServerMessage } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { parseWorkflowSuggestions, readWorkflowSuggestions } from '../src/workflowSuggestions.js'
import { createMockDriver } from '../src/drivers/mockDriver.js'
import { ManorService } from '../src/service.js'
import { createMemoryStore } from '../src/stores/memoryStore.js'
import { roster, scratchFor } from './helpers.js'

const LEDGER = `# Skill candidates

## Candidates

| Candidate | What it would encode | Occurrences (date + context) | Corrections seen | Existing skill? | Status |
|---|---|---|---|---|---|
| \`interview-prep-note\` | A vault template for interview prep. | 5 across companies. | Prefer a template. | Partial coverage. | ready |

| \`routine-hang-watchdog\` (automation) | Catch a hanging routine. | 1 real incident. | Alert on staleness. | Partial. | watching |
| \`offer-review\` | Review an offer. | 4 across projects. | Cross-foot totals. | No. | shipped 2026-07-06 |

Seeded from the archive.
`

describe('Memory folder suggestions', () => {
  it('parses the controlled ledger across blank lines and keeps status detail', () => {
    expect(parseWorkflowSuggestions(LEDGER)).toEqual([
      {
        id: 'interview-prep-note',
        name: 'Interview prep note',
        description: 'A vault template for interview prep.',
        occurrences: '5 across companies.',
        corrections: 'Prefer a template.',
        existingCoverage: 'Partial coverage.',
        status: 'ready',
        statusDetail: 'ready',
      },
      expect.objectContaining({
        id: 'routine-hang-watchdog',
        name: 'Routine hang watchdog',
        status: 'watching',
      }),
      expect.objectContaining({
        id: 'offer-review',
        status: 'shipped',
        statusDetail: 'shipped 2026-07-06',
      }),
    ])
  })

  it('distinguishes a missing checkout from an available empty ledger', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-notes-suggestions-'))
    const file = path.join(root, 'skill-candidates.md')
    writeFileSync(file, '# Skill candidates\n')

    expect(await readWorkflowSuggestions(file)).toEqual([])
    expect(await readWorkflowSuggestions(path.join(root, 'missing.md'))).toBeNull()
  })

  it('serves the ledger on demand and stays unavailable without a local memory folder', async () => {
    const replies: ServerMessage[] = []
    const base = {
      store: createMemoryStore({ agents: roster }),
      agents: () => roster,
      setAgents: () => undefined,
      mcpServers: () => [],
      setMcpServers: () => undefined,
      resolveDriver: () => createMockDriver({ deltaDelayMs: 0 }),
      ensureScratchDir: scratchFor,
      broadcast: () => undefined,
    }
    const available = new ManorService({
      ...base,
      workflowSuggestions: () => Promise.resolve(parseWorkflowSuggestions(LEDGER)),
    })
    await available.handle({ type: 'list_workflow_suggestions' }, (message) => replies.push(message))
    expect(replies.at(-1)).toMatchObject({
      type: 'workflow_suggestions',
      available: true,
      suggestions: [{ id: 'interview-prep-note' }, { id: 'routine-hang-watchdog' }, { id: 'offer-review' }],
    })

    const unavailable = new ManorService(base)
    await unavailable.handle({ type: 'list_workflow_suggestions' }, (message) => replies.push(message))
    expect(replies.at(-1)).toEqual({ type: 'workflow_suggestions', available: false, suggestions: [] })
  })
})
