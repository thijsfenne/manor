import { describe, expect, it } from 'vitest'
import type { ToolStep } from '../src/state'
import { currentLabel, isEditTool, settledLabel, wakeLines, workSummary } from '../src/turnLabels'

const step = (tool: string): ToolStep =>
  ({ kind: 'tool', key: 'k', tool, status: 'done' }) as ToolStep

describe('edit tool names', () => {
  it('still calls Write an edit', () => {
    expect(isEditTool('Write')).toBe(true)
    expect(settledLabel(step('Write'))).toBe('Edited')
  })

  it('does not call TodoWrite an edit, because Write is only a substring', () => {
    expect(isEditTool('TodoWrite')).toBe(false)
    expect(settledLabel(step('TodoWrite'))).toBe('Used TodoWrite')
  })

  it('names a saved task by what and when instead of the MCP call, never as scheduled', () => {
    const save = { ...step('mcp__routines__routine_save'), subject: '“Tea”, 2026-09-28 10:00' }
    expect(currentLabel({ ...save, status: 'running' })).toBe('Saving task “Tea”, 2026-09-28 10:00')
    expect(settledLabel(save)).toBe('Saved task “Tea”, 2026-09-28 10:00')
    expect(settledLabel(step('mcp__routines__routine_save'))).toBe('Saved task')
    // A paused task given a new moment without `enabled` stays paused, so the row cannot claim it is scheduled.
    const paused = { ...step('mcp__routines__routine_save'), subject: '2026-09-29 08:00' }
    expect(settledLabel(paused)).toBe('Saved task 2026-09-29 08:00')
  })

  it('shows a task brief instead of Using task', () => {
    const task = { ...step('Task'), subject: 'Find reportBackNudge', status: 'running' as const }
    expect(currentLabel(task)).toBe('Find reportBackNudge')
    expect(settledLabel({ ...task, status: 'done' })).toBe('Find reportBackNudge')
    expect(settledLabel(step('Task'))).toBe('Used Task')
  })
})

describe('activity bundle summaries', () => {
  it('keeps a single call specific', () => {
    expect(workSummary([{ ...step('Read'), targets: ['Turn.tsx'] }]).label).toBe('Read Turn.tsx')
  })

  it('keeps one failed call calm on the closed line', () => {
    expect(workSummary([{ ...step('Read'), targets: ['README.md'], status: 'error' }])).toEqual({
      label: 'Tool had an issue',
      kind: 'read',
    })
  })

  it('names each kind once in the Codex order', () => {
    expect(workSummary([step('Read'), step('Search'), step('Bash')], true).label).toBe(
      'Edited files, read files, searched, ran a command',
    )
  })
})

describe('shell and Manor tool rows', () => {
  const shell = (detail: string, extra: Partial<ToolStep> = {}): ToolStep => ({ ...step('Shell'), detail, command: detail, ...extra })

  it('labels a described command by its description, live and settled', () => {
    const described = shell('cd /repo && pnpm exec vitest run a.test.ts', { subject: 'run the a tests' })
    expect(currentLabel({ ...described, status: 'running' })).toBe('Run the a tests')
    expect(settledLabel(described)).toBe('Run the a tests')
  })

  it('drops cd, environment and sleep prefixes and names a heredoc a script', () => {
    expect(settledLabel(shell('cd /Users/me/repo && rg -n foo apps'))).toBe('Searched the files')
    expect(settledLabel(shell("DB=~/x.db; sqlite3 -readonly $DB 'select 1'"))).toBe('Used the database')
    expect(settledLabel(shell('sleep 5; grep -c bad /tmp/log.txt'))).toBe('Searched the files')
    expect(settledLabel(shell("python3 - <<'PY' from pathlib import Path"))).toBe('Ran a script')
  })

  it('says in plain words what a command does, chains included', () => {
    expect(settledLabel(shell('cd /repo && pnpm exec vitest run test/a.test.ts 2>&1 | tail -30'))).toBe('Ran tests')
    expect(currentLabel({ ...shell('pnpm exec tsc --noEmit'), status: 'running' })).toBe('Typechecking')
    expect(settledLabel(shell('git status --short'))).toBe('Checked for changes')
    expect(settledLabel(shell('pnpm exec eslint test/foo.ts'))).toBe('Ran lint')
    expect(settledLabel(shell('pnpm --filter web test'))).toBe('Ran tests')
    expect(settledLabel(shell('git -C apps/web diff --stat'))).toBe('Reviewed the changes')
    expect(settledLabel(shell('pnpm test | tail -20 && git status'))).toBe('Ran tests and checked for changes')
    expect(settledLabel(shell('cat test.log | grep fail'))).toBe('Read a file')
    expect(settledLabel(shell('pnpm test\npnpm build'))).toBe('Ran tests and built the app')
    expect(settledLabel(shell('pnpm exec tsc --version'))).toBe('Checked the tsc version')
    expect(settledLabel(shell('curl -s http://127.0.0.1:43180/health'))).toBe('Fetched from 127.0.0.1:43180')
  })

  it('falls back to the cleaned command when any step is unknown or clipped', () => {
    expect(settledLabel(shell('mystery-tool --fast'))).toBe('Ran mystery-tool --fast')
    expect(settledLabel(shell('pnpm test && mystery-tool'))).toBe('Ran pnpm test && mystery-tool')
    expect(settledLabel(shell('git status && sqlite3 x.db "select…'))).toBe('Ran git status && sqlite3 x.db "select…')
  })

  it('summarises a search and keeps rows wider than the old clip', () => {
    const search = (subject: string): ToolStep => ({ ...step('Grep'), subject })
    expect(settledLabel(search('“commandFamily|commandObject|describedShell” in turnLabels.ts'))).toBe('Searched for 3 terms in turnLabels.ts')
    expect(settledLabel(search('“plainCommand”'))).toBe('Searched for “plainCommand”')
    expect(settledLabel(search('“foo\\|bar”'))).toBe('Searched for a pattern')
    expect(settledLabel(search('“^export (const|function) \\w+”'))).toBe('Searched for a pattern')
    const long = `sqlite3 -readonly db "${'x'.repeat(120)}"`
    expect(settledLabel(shell(long, { subject: long })).length).toBeGreaterThan(100)
  })

  it('names Manor tools by what they mean', () => {
    expect(settledLabel(step('mcp__manor__goal_reached'))).toBe('Reported done')
    expect(currentLabel({ ...step('mcp__manor__task_result'), status: 'running' })).toBe('Checking on a helper')
    expect(settledLabel({ ...step('mcp__manor__deliver_file'), detail: '/tmp/out/report.html' })).toBe('Delivered report.html')
    expect(settledLabel(step('mcp__unknown__thing'))).toBe('Used MCP unknown.thing')
  })
})

describe('wakeLines', () => {
  const wakeLine = (items: Parameters<typeof wakeLines>[0]) => wakeLines(items).join('\n')
  const loop = 'for i in $(seq 1 40); do out=$(node .cursor/skills/verify-manor-mobile/control-manor-mobile.mjs launch 2>&1); if echo "$out" | grep -q "is held by a verify run"; then sleep 30; else echo "$out" | tail'

  it('names a task by the description its launch gave', () => {
    expect(wakeLine([{ title: 'Retry the phone launch until the port is free', state: 'done' }]))
      .toBe('Background task finished: retry the phone launch until the port is free')
    expect(wakeLine([{ title: 'PR checks', state: 'failed' }])).toBe('Background task failed: PR checks')
  })

  it('cuts a raw command down to its program and first argument', () => {
    expect(wakeLine([{ title: loop, state: 'done' }])).toBe('Background task finished: control-manor-mobile.mjs launch')
    expect(wakeLine([{ title: 'cd apps/web && pnpm exec vitest run', state: 'stopped' }])).toBe('Background task stopped: pnpm exec')
    expect(wakeLine([{ title: 'sleep 600', state: 'done' }])).toBe('Background task finished: sleep 600')
    expect(wakeLine([{ title: `/bin/zsh -lc '${loop}`, state: 'done' }])).toBe('Background task finished: control-manor-mobile.mjs launch')
    expect(wakeLine([{ title: 'node scripts/dev/serve.mjs start --verbose', state: 'done' }])).toBe('Background task finished: serve.mjs start')
  })

  it('keeps a description with an ampersand or a program name as prose', () => {
    expect(wakeLine([{ title: 'Build & test the app', state: 'done' }])).toBe('Background task finished: build & test the app')
    expect(wakeLine([{ title: 'node upgrade notes', state: 'done' }])).toBe('Background task finished: node upgrade notes')
  })

  it('keeps several tasks to at most two lines', () => {
    expect(wakeLine([{ title: loop, state: 'done' }, { title: 'Draft the figure', state: 'failed' }]))
      .toBe('Background task finished: control-manor-mobile.mjs launch\nBackground task failed: draft the figure')
    expect(wakeLine([{ title: 'a', state: 'done' }, { title: 'b', state: 'done' }, { title: loop, state: 'done' }])).toBe('3 background tasks finished')
    expect(wakeLine([{ title: 'a', state: 'done' }, { title: 'b', state: 'failed' }, { title: 'c', state: 'stopped' }])).toBe('3 background tasks ended, 1 failed')
  })
})
