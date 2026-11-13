import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ThreadEvent } from '@manor/contracts'
import { describeCommand } from '../src/drivers/commands.js'
import { redactToolActivity } from '../src/drivers/toolActivity.js'
import { PROOF_WAIVER_ID, checkFrom, checkRunTimes, codeChangeTimes, goalEvidenceBlock, isUiFile, runsCheck, unmeasuredChanges, waiverTimes } from '../src/goalEvidence.js'

const card = { file: '/repo/apps/web/src/components/Card.tsx', changedAt: 1_000 }
const store = { file: '/repo/apps/server/src/store.ts', changedAt: 1_000 }
const none = { screenshotsTakenAt: [], checksAt: [], waivedAt: [] }

describe('goalEvidenceBlock', () => {
  it('passes a Session that changed no code', () => {
    expect(goalEvidenceBlock({ changes: [], ...none })).toBeUndefined()
  })

  it('holds a UI change until a screenshot newer than it is passed', () => {
    expect(goalEvidenceBlock({ changes: [card], ...none })).toContain('Card.tsx changed after the newest screenshot you passed (none)')
    // A check run does not show what a component looks like.
    expect(goalEvidenceBlock({ changes: [card], ...none, checksAt: [2_000] })).toContain('Card.tsx')
    expect(goalEvidenceBlock({ changes: [card], ...none, screenshotsTakenAt: [900] })).toContain('Card.tsx changed after the newest screenshot')
    expect(goalEvidenceBlock({ changes: [card], ...none, screenshotsTakenAt: [900, 1_000] })).toBeUndefined()
  })

  it('holds other code until a check or a screenshot ran after its last change', () => {
    expect(goalEvidenceBlock({ changes: [store], ...none, checksAt: [900] })).toContain('store.ts changed after the last successful test')
    expect(goalEvidenceBlock({ changes: [store], ...none, checksAt: [1_200] })).toBeUndefined()
    expect(goalEvidenceBlock({ changes: [store], ...none, screenshotsTakenAt: [1_200] })).toBeUndefined()
    // A later edit to another file needs its own proof.
    expect(goalEvidenceBlock({ changes: [store, { file: '/repo/apps/server/src/main.ts', changedAt: 1_500 }], ...none, checksAt: [1_200] }))
      .toContain('main.ts changed')
  })

  it('lets a yes from the user to the waiver question after the last change stand in for the proof', () => {
    expect(goalEvidenceBlock({ changes: [card, store], ...none, waivedAt: [500] })).toContain(PROOF_WAIVER_ID)
    expect(goalEvidenceBlock({ changes: [card, store], ...none, waivedAt: [1_100] })).toBeUndefined()
    const answer = (answers: Record<string, string | string[]>, ts: number) =>
      ({ type: 'user_input_response', agentId: 'a', turnId: 't', requestId: 'r', answers, id: `evt_${ts}`, ts }) as ThreadEvent
    expect(waiverTimes([
      answer({ [PROOF_WAIVER_ID]: 'Yes, report without it' }, 1),
      answer({ [PROOF_WAIVER_ID]: 'No, take the screenshot first' }, 2),
      answer({ labels: 'Yes' }, 3),
      answer({ [PROOF_WAIVER_ID]: ['Ja'] }, 4),
      // Manor answering from a preference never waives proof for the user.
      { ...answer({ [PROOF_WAIVER_ID]: 'Yes' }, 5), fromPreference: { file: 'preferences.md', quote: 'Corners are always round' } } as ThreadEvent,
    ])).toEqual([1, 4])
  })

  it('asks a check, not a picture, for a deleted file', () => {
    const gone = { ...card, deleted: true as const }
    expect(goalEvidenceBlock({ changes: [gone], ...none })).toContain('last successful test')
    expect(goalEvidenceBlock({ changes: [gone], ...none, checksAt: [1_100] })).toBeUndefined()
  })

  it('counts an unmeasured turn as changed at its last tool call before goal_reached', () => {
    const call = (turnId: string, tool: string, ts: number) =>
      ({ type: 'tool_use', agentId: 'a', turnId, toolCallId: `${turnId}${ts}`, tool, id: `evt_${ts}`, ts }) as ThreadEvent
    const events = [
      call('t1', 'Edit', 10), call('t1', 'Bash', 20),
      { type: 'turn_result', agentId: 'a', turnId: 't1', fileChangesFailed: true, id: 'evt_30', ts: 30 },
      call('t2', 'Edit', 40), call('t2', 'mcp__manor__goal_reached', 50),
    ] as ThreadEvent[]
    expect(unmeasuredChanges(events)).toEqual([{ file: 'files Manor could not measure', changedAt: 20 }])
    expect(unmeasuredChanges(events, 't2')).toEqual([
      { file: 'files Manor could not measure', changedAt: 20 }, { file: 'files Manor could not measure', changedAt: 40 },
    ])
  })
})

describe('evidence inputs', () => {
  it('treats rendered files as UI and tests as code', () => {
    expect(['a/Card.tsx', 'styles.css', 'index.html', 'icon.svg', 'logo.png', 'src/components/customIcons.ts', 'packages/blobatar/src/shading.ts',
      'packages/blobatar/src/styles/shapes.ts', 'apps/mobile/src/theme.ts', 'apps/desktop/src/browserCursorRenderer.ts']
      .every(isUiFile)).toBe(true)
    expect(['a/Card.test.tsx', 'test/view.tsx', 'a/store.ts', 'notes.md', 'src/lib/format.ts'].some(isUiFile)).toBe(false)
  })

  it('counts only successful check commands', () => {
    const shell = (command: string) => ({ type: 'tool_use', agentId: 'a', turnId: 't', toolCallId: 'c', tool: 'Shell', command, id: 'evt_0', ts: 1 }) as const
    for (const command of [
      'cd /repo/apps/server && pnpm exec vitest run test/goalEvidence.test.ts',
      'pnpm --filter @manor/web typecheck',
      'node .cursor/skills/verify-manor/control-manor.mjs screenshot --path a.png',
      'pnpm exec tsx scripts/session-rounds.ts',
    ]) expect(runsCheck(shell(command))).toBe(true)
    for (const command of ['git diff', 'grep -n checkbox styles.css', 'sed -n 1,20p a.ts']) expect(runsCheck(shell(command))).toBe(false)
    expect(runsCheck(shell('cd /repo/apps/server && pnpm exec vitest run 2>&1 | tail -40'))).toBe(true)
    expect(runsCheck(shell('CI=1 pnpm --filter @manor/web typecheck'))).toBe(true)
    // Words that only name a check, and a check whose failure is swallowed, prove nothing.
    // Codex wraps every command in a login shell; scripts and builds of other stacks count too.
    for (const command of [
      "/bin/zsh -lc 'npm run build'", 'cargo build', 'go vet ./...', 'python3 scripts/verify.py', 'bash scripts/verify.sh',
      './scripts/verify.sh', 'npx vue-tsc --noEmit', 'time pnpm test', '(cd apps/web && pnpm exec tsc --noEmit -p .)',
      'pnpm --filter @manor/server exec node --test test/a.test.mjs', "node --input-type=module <<'JS'\nimport './a.js'\nJS",
    ]) expect(runsCheck(shell(command)), command).toBe(true)
    // Words that only name a check, a check whose failure is swallowed, and a rewrite after the check prove nothing.
    for (const command of [
      'echo "pnpm test"', 'rg vitest package.json', 'pnpm exec rg test package.json', 'rg -n "before; pnpm test" package.json',
      'pnpm test || true', 'pnpm test || :', "pnpm test && perl -pi -e 's/a/b/' src/a.ts", 'pnpm test; cp /tmp/a.bak src/a.ts',
      'pnpm install', 'npm run dev', "python3 - <<'EOF'\nopen('a.ts', 'w')\nEOF", 'node -e "require(1)"',
      'pnpm test && rm src/a.ts', 'pnpm test && git rm -q src/a.ts', 'pnpm test && git -C /repo checkout -- src/a.ts',
    ]) expect(runsCheck(shell(command)), command).toBe(false)
    expect(runsCheck(shell('npx -y vitest run'))).toBe(true)
    for (const command of ['node --version', 'python3 -V', 'node --help', 'pnpm exec tsc --version 2>&1', 'npx vitest -h > /tmp/h.txt', 'pnpm exec vitest run --help', 'pnpm test --help']) {
      expect(runsCheck(shell(command)), command).toBe(false)
    }
    expect(runsCheck(shell('pnpm test && cd /tmp/spike && rm scratch.log > out.txt'))).toBe(true)
    expect(runsCheck(shell('pnpm test && git stash list && git -C /repo stash show -p'))).toBe(true)
    // Scratch output, a later read and a scratch cleanup leave the check standing; a `||` that hides its failure does not.
    expect(runsCheck(shell('pnpm test > /tmp/out.txt 2>&1; git status --short; pkill -f vite; rm -rf /tmp/spike'))).toBe(true)
    expect(runsCheck(shell('pnpm test | tail -5 || echo failed'))).toBe(false)
    const events = [
      { type: 'tool_use', agentId: 'a', turnId: 't', toolCallId: 'ok', tool: 'Shell', command: 'pnpm test', id: 'evt_1', ts: 10 },
      { type: 'tool_result', agentId: 'a', turnId: 't', toolCallId: 'ok', outcome: 'success', id: 'evt_2', ts: 20 },
      { type: 'tool_use', agentId: 'a', turnId: 't', toolCallId: 'red', tool: 'Shell', command: 'pnpm test', id: 'evt_3', ts: 30 },
      { type: 'tool_result', agentId: 'a', turnId: 't', toolCallId: 'red', outcome: 'error', id: 'evt_4', ts: 40 },
      { type: 'tool_use', agentId: 'a', turnId: 't', toolCallId: 'both', tool: 'Shell', command: "sed -i '' s/a/b/ a.ts && pnpm test", id: 'evt_5', ts: 50 },
      { type: 'tool_result', agentId: 'a', turnId: 't', toolCallId: 'both', outcome: 'success', id: 'evt_6', ts: 60 },
    ] as ThreadEvent[]
    // A check proves the code from when it started; one after an edit in the same command, from its end.
    expect(checkRunTimes(events)).toEqual([10, 60])
    // An edit's heredoc is file content: words in it are not commands.
    const edit = { type: 'tool_use', agentId: 'a', turnId: 't', toolCallId: 'x', tool: 'Shell', id: 'evt_5', ts: 50 } as const
    expect(runsCheck({ ...edit, command: "python3 - <<'EOF'\ns = 'pnpm test'\nEOF" })).toBe(false)
    // A shell edit Manor read off the command came before its check, so the check proves it from the end.
    expect(checkRunTimes([
      { ...edit, toolCallId: 'w', command: "cat > a.mjs <<'EOF'\nexport const a = 1\nEOF\nnode scripts/verify.mjs", edits: [{ path: 'a.mjs' }] },
      { type: 'tool_result', agentId: 'a', turnId: 't', toolCallId: 'w', outcome: 'success', id: 'evt_6', ts: 70 },
    ] as ThreadEvent[])).toEqual([70])
    // So did a rebase that rewrote the checkout before its check.
    expect(checkFrom({ ...edit, command: 'git rebase main 2>&1 | tail -3; pnpm test' })).toBe('end')
    expect(runsCheck({ ...edit, command: "python3 - <<'EOF'\nprint(1)\nEOF\npnpm exec vitest run" })).toBe(true)
    expect(runsCheck({ ...edit, command: "cat > a.ts <<'END-X'\npnpm test\nEND-X" })).toBe(false)
    // A file-sized heredoc edit keeps its trailing check once Manor records the command.
    const long = `python3 - <<'EOF'\n${'s = 1\n'.repeat(600)}EOF\npnpm exec vitest run`
    const recorded = redactToolActivity(describeCommand(long), (value) => value).command!
    expect(runsCheck({ ...edit, command: recorded })).toBe(true)
    expect(recorded.length).toBeLessThanOrEqual(2_000)
  })

  it('reads change times from the files themselves, a deletion from its earliest bound, and skips prose', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'manor-goal-evidence-'))
    const code = path.join(root, 'a.ts')
    const prose = path.join(root, 'notes.md')
    const folder = path.join(root, 'ui')
    writeFileSync(code, 'x\n')
    writeFileSync(prose, 'x\n')
    mkdirSync(folder)
    utimesSync(code, 5, 5)
    utimesSync(folder, 7, 7)
    const gone = path.join(folder, 'Gone.tsx')
    expect(await codeChangeTimes([code, code, prose, gone, 'relative.ts'])).toEqual([
      { file: code, changedAt: 5_000 },
      { file: gone, changedAt: 7_000, deleted: true },
    ])
    // A note written beside it later moves the folder's time, not the turn that reported it gone.
    utimesSync(folder, 9, 9)
    const reported = { type: 'turn_result', agentId: 'a', turnId: 't', id: 'evt_1', ts: 6_000,
      fileChanges: [{ path: gone, status: 'deleted', added: 0, removed: 1, edits: [] }] } as ThreadEvent
    expect(await codeChangeTimes([gone], [reported])).toEqual([{ file: gone, changedAt: 6_000, deleted: true }])
    // The call that removed it is closer still.
    const removed = { type: 'tool_use', agentId: 'a', turnId: 't', toolCallId: 'rm', tool: 'Shell', command: `git rm -q ${gone}`, id: 'evt_0', ts: 5_500 } as ThreadEvent
    expect(await codeChangeTimes([gone], [removed, reported])).toEqual([{ file: gone, changedAt: 5_500, deleted: true }])
    // Looking at the deletion afterwards does not move it.
    const looked = { ...removed, toolCallId: 'diff', command: `git diff -- ${gone}`, id: 'evt_2', ts: 8_000 } as ThreadEvent
    expect(await codeChangeTimes([gone], [removed, reported, looked])).toEqual([{ file: gone, changedAt: 5_500, deleted: true }])
    // Codex reports a native deletion on the result, by its absolute origin, from when the call started.
    const patch = { type: 'tool_use', agentId: 'a', turnId: 't', toolCallId: 'patch', tool: 'apply_patch', id: 'evt_3', ts: 5_200 } as ThreadEvent
    const patched = { type: 'tool_result', agentId: 'a', turnId: 't', toolCallId: 'patch', outcome: 'success', id: 'evt_4', ts: 5_300,
      edits: [{ path: 'ui/Gone.tsx', originPath: gone, kind: 'delete' }] } as ThreadEvent
    expect(await codeChangeTimes([gone], [patch, patched, reported])).toEqual([{ file: gone, changedAt: 5_200, deleted: true }])
    // An ordinary earlier edit, or removing a scratch file of the same name, does not date the deletion.
    const edited = { ...patched, edits: [{ path: gone, before: 'a', after: 'b' }] } as ThreadEvent
    const scratch = { ...removed, toolCallId: 'tmp', command: 'rm /tmp/spike/ui/Gone.tsx', ts: 5_100 } as ThreadEvent
    expect(await codeChangeTimes([gone], [patch, edited, scratch, reported])).toEqual([{ file: gone, changedAt: 6_000, deleted: true }])
    // A relative removal counts where its `cd` left the shell, not wherever a file of that name sits.
    const elsewhere = { ...removed, toolCallId: 'cd', command: 'cd /tmp/spike && rm ui/Gone.tsx', ts: 5_100 } as ThreadEvent
    const here = { ...removed, toolCallId: 'cd2', command: `cd ${root} && rm -f ui/Gone.tsx`, ts: 5_150 } as ThreadEvent
    expect(await codeChangeTimes([gone], [elsewhere, reported])).toEqual([{ file: gone, changedAt: 6_000, deleted: true }])
    expect(await codeChangeTimes([gone], [elsewhere, here, reported])).toEqual([{ file: gone, changedAt: 5_150, deleted: true }])
  })
})
