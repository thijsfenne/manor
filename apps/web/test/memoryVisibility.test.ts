import { describe, expect, it } from 'vitest'
import type { ToolStep, TurnRow } from '../src/state'
import { finishedSilent } from '../src/state'
import { isMemoryWrite, settledLabel } from '../src/turnLabels'

const step = (patch: Partial<ToolStep>): ToolStep =>
  ({ kind: 'tool', key: 'k', tool: 'Bash', status: 'done', ...patch }) as ToolStep

describe('isMemoryWrite', () => {
  it('recognises a shell append into the daily log', () => {
    expect(isMemoryWrite(step({ command: "cat >> ~/Notes/memory/daily/2026-08-08.md <<'EOF'" }))).toBe(true)
  })

  it('recognises a relay file written with the file-write tool', () => {
    expect(
      isMemoryWrite(
        step({
          tool: 'Write',
          edits: [{ path: '/Users/sam/notes/memory/daily/cloud/2026-08-08-manor.md', after: '# Daily log' }],
        }),
      ),
    ).toBe(true)
  })

  it('recognises a target path even when the command says nothing', () => {
    expect(isMemoryWrite(step({ tool: 'Write', targets: ['memory/daily/cloud/2026-08-08-manor.md'] }))).toBe(true)
  })

  it('leaves ordinary work alone', () => {
    expect(isMemoryWrite(step({ command: 'pnpm -r typecheck' }))).toBe(false)
    expect(isMemoryWrite(step({ tool: 'Write', edits: [{ path: 'apps/server/src/composer.ts', after: 'x' }] }))).toBe(
      false,
    )
  })

  // The path appears in a read too, and "Saved to memory" on a read would be a lie.
  it('does not claim a read of the daily log is a write', () => {
    const read = step({ tool: 'Read', targets: ['memory/daily/2026-08-08.md'] })
    expect(isMemoryWrite(read)).toBe(false)
    expect(settledLabel(read)).not.toBe('Saved to memory')
  })

  it('does not claim a read-only search of memory is a write', () => {
    const search = step({
      tool: 'Search',
      command: 'rg -n "Example App" ~/Notes/memory/daily/2026-08-27.md 2>/dev/null',
      targets: ['memory/daily/2026-08-27.md'],
    })
    expect(isMemoryWrite(search)).toBe(false)
    expect(settledLabel(search)).toBe('Searched 2026-08-27.md')
  })
})

describe('settledLabel', () => {
  it('names a memory write for what it means, not for the tool it used', () => {
    expect(settledLabel(step({ command: 'cat >> ~/Notes/memory/daily/2026-08-08.md' }))).toBe('Saved to memory')
  })
})

describe('finishedSilent', () => {
  const turn = (patch: Partial<TurnRow>): TurnRow =>
    ({ kind: 'turn', key: 't', turnId: 't', agentId: 'smith', activities: [], segments: [], answer: [], ...patch }) as TurnRow

  it('flags a finished turn that worked and then said nothing', () => {
    expect(finishedSilent(turn({ segments: [{ kind: 'work', key: 'w', steps: [] }] }))).toBe(true)
  })

  it('says nothing about a turn that is still running', () => {
    expect(finishedSilent(turn({ live: { turnId: 't', agentId: 'smith', state: 'running', startedAt: 1, messages: [] } }))).toBe(
      false,
    )
  })

  // The sweep's note is the server's account of the same silence; a guess must not
  // sit next to it saying something different.
  it('defers to a note the server already wrote', () => {
    expect(
      finishedSilent(turn({ note: { id: 'e', ts: 1, type: 'system_note', kind: 'error', text: 'connection lost' } })),
    ).toBe(false)
  })

  it('leaves a turn that answered alone', () => {
    expect(finishedSilent(turn({ answer: [{ kind: 'reply', key: 'r', text: 'done', images: [], quoteSources: [] }] }))).toBe(false)
  })
})
