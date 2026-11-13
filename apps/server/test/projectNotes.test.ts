import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ThreadEvent, WorkHandoff } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import { legacyNoteSources, notesContext, noteText, reconcileNotes, sourceNote } from '../src/projectNotes.js'
import { landedNoteCommit, currentSessionCommits } from '../src/workCompletion.js'

const now = Date.UTC(2026, 9, 17)
const handoff = (id: string, fields: Partial<WorkHandoff> = {}): WorkHandoff => ({
  id, sourceChatId: 'thread', sourceTurnId: 'proposal', workChatId: `chat-${id}`,
  projectId: 'project', projectName: 'Manor', title: 'Export button',
  leadAgentId: '__single__', leadAgentName: 'Single', supportingAgentIds: [], supportingAgentNames: [],
  state: 'active', result: null, resultAt: null, version: 1, createdAt: now - 5 * 86_400_000,
  acceptedAt: now - 5 * 86_400_000, ...fields,
})
const row = (id: string, text = 'Export button: uncommitted, awaiting Confirm') => sourceNote(`- [ ] ${text}`, id, now - 4 * 86_400_000)

describe('Notes evidence', () => {
  it('uses handoff ids across identical titles and never completes a source-less row', () => {
    const result = reconcileNotes([
      row('open'), row('pdf', 'Export button: PDF: Working'),
      '- [ ] Export button: Working', row('done'),
    ], [
      { handoff: handoff('open'), settled: false },
      { handoff: handoff('pdf', { title: 'Export button: PDF' }), settled: false },
      { handoff: handoff('done', { goalConfirmedAt: now }), settled: false },
    ], { now, landed: new Map() }).map(noteText)
    expect(result.slice(0, 3).every((line) => line.startsWith('- [ ]'))).toBe(true)
    expect(result[3]).toContain('- [x] Export button:')
    expect(result[3]).toContain('Confirmed 2026-10-17')
    expect(result[3]).not.toMatch(/uncommitted|awaiting Confirm/)
  })

  it('keeps a Confirmed row open while its merge is blocked, and checks it once Git shows it', () => {
    const completion = (status: 'blocked' | 'complete') => ({
      status, operation: 'merge' as const, requestEventId: 'confirm', repos: [],
    })
    const reconcile = (status: 'blocked' | 'complete') => noteText(reconcileNotes([row('merge')], [
      { handoff: handoff('merge', { goalConfirmedAt: now, goalCompletion: completion(status) }), settled: false },
    ], { now, landed: new Map() })[0]!)
    expect(reconcile('blocked')).toMatch(/^- \[ \] /)
    expect(reconcile('blocked')).not.toContain('Confirmed')
    expect(reconcile('complete')).toMatch(/^- \[x\] .*\[Confirmed 2026-10-17\]/)
  })

  it('requires settlement and Git evidence together, and ignores old evidence after reopening', () => {
    const sessions = ['unsettled', 'unlanded', 'landed', 'reopened'].map((id) => ({
      handoff: handoff(id, id === 'reopened' ? { goalConfirmedAt: now, unsettledAt: now } : {}),
      settled: id !== 'unsettled',
    }))
    const landed = new Map(['unsettled', 'landed', 'reopened'].map((id) => [id, ['1234567890abcdef']]))
    const result = reconcileNotes(sessions.map(({ handoff }) => row(handoff.id)), sessions, { now, landed }).map(noteText)
    expect(result.map((line) => line.startsWith('- [x]'))).toEqual([false, false, true, false])
    expect(result[2]).toContain('[Landed 1234567890ab]')
  })

  it.each(['Investigation complete. No code change.', 'No code change. The investigation is complete.'])('completes an explicit no-code report immediately, with declaration %s', (reportResult) => {
    const sessions = [false, true].map((changed, index) => ({ handoff: handoff(String(index), {
      goalReachedAt: now, goalReport: { result: reportResult },
      goalChangedFiles: changed ? ['app.ts'] : [],
    }), settled: false }))
    const result = reconcileNotes([row('0'), row('1')], sessions, { now, landed: new Map() })
    expect(noteText(result[0]!)).toContain('[No code change, reported 2026-10-17]')
    expect(result[1]).toMatch(/^- \[ \]/)
    expect(reconcileNotes(result, sessions, { now: now + 1, landed: new Map() })).toEqual(result)
  })

  it('puts unchanged three-day rows first in context and resets the clock on human edits', () => {
    const old = row('old', 'Old task')
    const recent = sourceNote('- [ ] Recent task', 'recent', now - 2 * 86_400_000)
    const context = notesContext(`# Notes\n${old}\n${recent}`, now)
    expect(context.startsWith('stale? Old task\n')).toBe(true)
    expect(context).not.toContain('stale? Recent task')
    expect(context).not.toContain('<!--')
    const [edited] = reconcileNotes([old.replace('Old task', 'Changed task')], [], { now, landed: new Map() })
    expect(notesContext(edited!, now)).not.toContain('stale?')
  })

  it('recovers legacy identity only from a unique successful tool call around the exact write', () => {
    const use: ThreadEvent = { type: 'tool_use', id: 'use', ts: 10, agentId: '__single__', turnId: 'turn', toolCallId: 'call', tool: 'mcp__manor__set_session_status' }
    const end: ThreadEvent = { type: 'tool_result', id: 'end', ts: 20, agentId: '__single__', turnId: 'turn', toolCallId: 'call', outcome: 'success' }
    const write: ThreadEvent = { type: 'system_note', id: 'write', ts: 15, kind: 'info', text: 'Saved',
      projectFileWrite: { file: 'notes.md', action: 'add', by: 'Export button', line: '[ ] Exact row' } }
    const session = { handoff: handoff('source'), events: [use, end] }
    expect(legacyNoteSources([write], [session]).get('- [ ] Exact row')?.handoffId).toBe('source')
    expect(legacyNoteSources([write], [session, { ...session, handoff: handoff('other') }]).get('- [ ] Exact row')).toEqual({ updatedAt: 15 })
    expect(legacyNoteSources([write], [{ ...session, events: [use, { ...end, outcome: 'error' }] }]).get('- [ ] Exact row')?.handoffId).toBeUndefined()
  })

  it('keeps a reverted commit open even though it is an ancestor of main', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'manor-note-git-'))
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
    try {
      git('init', '-q', '-b', 'main')
      git('config', 'user.name', 'Test')
      git('config', 'user.email', 'test@example.test')
      await writeFile(path.join(root, 'app.txt'), 'before\n')
      await writeFile(path.join(root, 'other.txt'), 'before\n')
      await writeFile(path.join(root, 'README.md'), 'Before\n')
      git('add', '.')
      git('commit', '-qm', 'Baseline')
      const initial = git('rev-parse', 'HEAD')
      expect(await landedNoteCommit(root, initial)).toBe(initial)
      git('checkout', '-qb', 'session')
      await writeFile(path.join(root, 'app.txt'), 'after\n')
      await writeFile(path.join(root, 'other.txt'), 'after\n')
      await writeFile(path.join(root, 'README.md'), 'Feature documented\n')
      git('commit', '-qam', 'Task')
      const beforeAmend = git('rev-parse', 'HEAD')
      git('commit', '--amend', '-qm', 'Task amended')
      const commit = git('rev-parse', 'HEAD')
      const own = await currentSessionCommits(root, 'session')
      expect(own.has(beforeAmend)).toBe(false)
      expect(own.has(commit)).toBe(true)
      git('checkout', '-q', 'main')
      git('merge', '--ff-only', 'session')
      expect(await landedNoteCommit(root, commit)).toBe(commit)
      git('rm', '-q', 'README.md')
      git('commit', '-qm', 'Move documentation out of the repository')
      expect(await landedNoteCommit(root, commit)).toBe(commit)
      git('revert', '--no-edit', 'HEAD')
      git('restore', `--source=${commit}^`, '--', 'app.txt')
      git('commit', '-qam', 'Restore one required file')
      expect(await landedNoteCommit(root, commit)).toBeUndefined()
      git('revert', '--no-edit', 'HEAD')
      expect(await landedNoteCommit(root, commit)).toBe(commit)
      await writeFile(path.join(root, 'app.txt'), 'before\n// Unrelated comment\n')
      git('commit', '-qam', 'Remove the feature but keep an unrelated edit')
      expect(await landedNoteCommit(root, commit)).toBeUndefined()
      git('revert', '--no-edit', 'HEAD')
      git('revert', '--no-edit', commit)
      expect(await landedNoteCommit(root, commit)).toBeUndefined()
      const result = reconcileNotes([row('reverted')], [{ handoff: handoff('reverted'), settled: true }], { now, landed: new Map() })
      expect(result[0]).toMatch(/^- \[ \]/)
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
