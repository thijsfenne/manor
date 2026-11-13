import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { captureFolderStats, captureTurnTree, changedFolderFiles, diffTurnTrees, namesFile, unmeasuredPaths } from '../src/turnFileSnapshots.js'
import { shellMayWrite, writingParts } from '../src/drivers/commands.js'

const run = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(cwd: string, ...args: string[]) {
  return (await run('git', args, { cwd, encoding: 'utf8' })).stdout
}

it('compares actual worktree contents, including shell writes, without changing the index', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'manor-turn-files-'))
  roots.push(root)
  await git(root, 'init', '-q')
  await writeFile(path.join(root, 'before.txt'), 'original\n')
  await git(root, 'add', 'before.txt')
  await git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial')

  await writeFile(path.join(root, 'before.txt'), 'already dirty\n')
  await git(root, 'add', 'before.txt')
  const indexBefore = await git(root, 'diff', '--cached', '--binary')
  const start = await captureTurnTree(root)
  await writeFile(path.join(root, 'before.txt'), 'changed during turn\n')
  await writeFile(path.join(root, 'new.txt'), 'created during turn\n')
  await writeFile(path.join(root, '.env'), 'NOT_A_REAL_SECRET=test\n')
  const end = await captureTurnTree(root)
  const changes = await diffTurnTrees(root, start, end)

  expect(changes.map(({ path: filePath, status, added, removed }) => ({
    path: path.basename(filePath), status, added, removed,
  }))).toEqual([
    { path: 'before.txt', status: 'edited', added: 1, removed: 1 },
    { path: 'new.txt', status: 'created', added: 1, removed: 0 },
  ])
  expect(changes[0]?.edits[0]).toMatchObject({ before: 'already dirty', after: 'changed during turn' })
  expect(await git(root, 'diff', '--cached', '--binary')).toBe(indexBefore)
  expect(await git(root, 'status', '--short')).toContain('?? .env')
  expect(await readFile(path.join(root, 'before.txt'), 'utf8')).toBe('changed during turn\n')
})

it('starts from HEAD with the real index as stat cache, so a staged secret stays out', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'manor-turn-files-'))
  roots.push(root)
  await git(root, 'init', '-q')
  await writeFile(path.join(root, 'kept.txt'), 'kept\n')
  await git(root, 'add', 'kept.txt')
  await git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial')
  await writeFile(path.join(root, '.env'), 'NOT_A_REAL_SECRET=test\n')
  await git(root, 'add', '-f', '.env')

  const tree = await captureTurnTree(root)

  expect(await git(root, 'ls-tree', '--name-only', tree)).toBe('kept.txt\n')
  expect(await git(root, 'diff', '--cached', '--name-only')).toBe('.env\n')
})

it('rehashes an edit whose stat matches the real index when both share its clock', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'manor-turn-files-'))
  roots.push(root)
  await git(root, 'init', '-q')
  await git(root, 'config', 'core.trustctime', 'false')
  await git(root, 'config', 'core.checkStat', 'minimal')
  const file = path.join(root, 'racy.txt')
  const clock = new Date(Math.floor(Date.now() / 1000 - 3600) * 1000)
  await writeFile(file, 'aaaa\n')
  await utimes(file, clock, clock)
  await git(root, 'add', 'racy.txt')
  await git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial')
  await utimes(path.join(root, '.git/index'), clock, clock)
  // Same size and mtime as the index entry: only git's racy check against the
  // index file's own mtime catches it, so the copy must keep that mtime.
  await writeFile(file, 'bbbb\n')
  await utimes(file, clock, clock)

  expect(await git(root, 'show', `${await captureTurnTree(root)}:racy.txt`)).toBe('bbbb\n')
})

it.each(['--assume-unchanged', '--skip-worktree'])('captures an edit the real index hides with %s', async (flag) => {
  const root = await mkdtemp(path.join(tmpdir(), 'manor-turn-files-'))
  roots.push(root)
  await git(root, 'init', '-q')
  await writeFile(path.join(root, 'sample.txt'), 'before\n')
  await git(root, 'add', 'sample.txt')
  await git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial')
  await git(root, 'update-index', flag, 'sample.txt')
  await writeFile(path.join(root, 'sample.txt'), 'after\n')

  expect(await git(root, 'show', `${await captureTurnTree(root)}:sample.txt`)).toBe('after\n')
  expect(await git(root, 'ls-files', '-v')).toMatch(/^[hS] sample\.txt/)
})

it('returns an empty measured result when a turn leaves no net change', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'manor-turn-files-'))
  roots.push(root)
  await git(root, 'init', '-q')
  const start = await captureTurnTree(root)
  await writeFile(path.join(root, 'temporary.txt'), 'draft\n')
  await rm(path.join(root, 'temporary.txt'))
  const end = await captureTurnTree(root)
  expect(await diffTurnTrees(root, start, end)).toEqual([])
})

it('captures ignored working notes shown in Files without capturing hidden credentials', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'manor-turn-files-'))
  roots.push(root)
  await git(root, 'init', '-q')
  await writeFile(path.join(root, '.gitignore'), '.claude/\n')
  await git(root, 'add', '.gitignore')
  await git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial')
  const start = await captureTurnTree(root)
  await mkdir(path.join(root, '.claude/plans'), { recursive: true })
  await mkdir(path.join(root, '.claude/ideas'), { recursive: true })
  await writeFile(path.join(root, '.claude/plans/next.md'), 'Build it\n')
  await writeFile(path.join(root, '.claude/ideas/later.md'), 'Consider it\n')
  await writeFile(path.join(root, '.claude/plans/.env'), 'NOT_A_REAL_SECRET=test\n')
  const end = await captureTurnTree(root)
  expect((await diffTurnTrees(root, start, end)).map((change) => path.relative(root, change.path)))
    .toEqual(['.claude/ideas/later.md', '.claude/plans/next.md'])
})

it('reports a rename and a deletion from the resulting trees', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'manor-turn-files-'))
  roots.push(root)
  await git(root, 'init', '-q')
  await writeFile(path.join(root, 'old.txt'), 'rename me\n')
  await writeFile(path.join(root, 'gone.txt'), 'remove me\n')
  await git(root, 'add', '.')
  await git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial')
  const start = await captureTurnTree(root)
  await writeFile(path.join(root, 'new.txt'), 'rename me\n')
  await rm(path.join(root, 'old.txt'))
  await rm(path.join(root, 'gone.txt'))
  const end = await captureTurnTree(root)
  const changes = await diffTurnTrees(root, start, end)
  expect(changes.find((file) => file.path === path.join(root, 'new.txt'))?.oldPath).toBe(path.join(root, 'old.txt'))
  expect(changes.map((file) => [path.basename(file.path), file.status])).toEqual([
    ['gone.txt', 'deleted'],
    ['new.txt', 'edited'],
  ])
})

it('attributes a shared-checkout file only when the turn named it, also after a cd', () => {
  const root = '/repo'
  expect(namesFile(["sed -i '' 's/a/b/' apps/web/src/index.ts"], root, 'apps/web/src/index.ts')).toBe(true)
  expect(namesFile(['cd apps/web/src/components', "sed -i '' 's/a/b/' Button.tsx"], root,
    'apps/web/src/components/Button.tsx')).toBe(true)
  expect(namesFile(['cd /repo/apps/web && node fix.js src/index.ts'], root, 'apps/web/src/index.ts')).toBe(true)
  expect(namesFile(["python3 fix.py ./AGENTS.md"], root, 'AGENTS.md')).toBe(true)
  // Same tail, other folder: another chat's write, not this turn's.
  expect(namesFile(["sed -i '' 's/a/b/' apps/server/src/index.ts"], root, 'apps/web/src/index.ts')).toBe(false)
  expect(namesFile(["sed -i '' 's/a/b/' Button.tsx"], root, 'apps/web/src/components/Button.tsx')).toBe(false)
  expect(namesFile(["sed -i '' 's/a/b/' src/index.tsx"], root, 'src/index.ts')).toBe(false)
  expect(namesFile(["sed -i '' 's/a/b/' /repo/src/Foo.tsx"], root, 'src/Foo.ts')).toBe(false)
  expect(namesFile(['cp src/Foo.ts src/Foo.ts.bak'], root, 'src/Foo.ts')).toBe(true)
  expect(namesFile(['cp other.ts src/Foo.ts.bak'], root, 'src/Foo.ts')).toBe(false)
})

it('tells a shell command that may write from a directory change or a read', () => {
  expect(shellMayWrite('cd /notes && cat report.md')).toBe(false)
  expect(shellMayWrite('cd /notes && echo hi > report.md')).toBe(true)
  expect(shellMayWrite('pnpm exec vitest run')).toBe(true)
  // An unquoted heredoc runs its substitutions, so its body is not skipped as input.
  expect(shellMayWrite('cat <<EOF\n$(touch src/a.ts)\nEOF')).toBe(true)
  expect(shellMayWrite('echo "$(printf changed > a.ts)"')).toBe(true)
  expect(shellMayWrite('cat `touch a.ts`')).toBe(true)
  expect(shellMayWrite('cd "$(printf changed > a.ts; printf .)"')).toBe(true)
  expect(shellMayWrite('cd . > a.ts')).toBe(true)
  // The redirect lands where the `cd` started, and the next command runs where it ended.
  expect(writingParts('cd /r && cd src > a.ts && sed -i s/a/b/ b.ts')).toEqual(['cd /r && a.ts', 'cd /r/src && sed -i s/a/b/ b.ts', 'cd /r/src'])
})

it('walks a folder git cannot snapshot, and refuses to report an incomplete walk', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'manor-walk-'))
  try {
    await writeFile(path.join(root, 'a.ts'), 'one\n')
    await utimes(path.join(root, 'a.ts'), 1_000, 1_000)
    await mkdir(path.join(root, 'notes'))
    await mkdir(path.join(root, 'test', '.review'), { recursive: true })
    const before = await captureFolderStats(root)
    // Same length, modification time put back: only the change time gives it away.
    await writeFile(path.join(root, 'a.ts'), 'two\n')
    await utimes(path.join(root, 'a.ts'), 1_000, 1_000)
    expect((await stat(path.join(root, 'a.ts'))).mtimeMs).toBe(1_000_000)
    // A reviewer's probe is scratch, not a change.
    await writeFile(path.join(root, 'test', '.review', 'probe.test.ts'), 'probe\n')
    const after = await captureFolderStats(root)
    expect(changedFolderFiles(before ?? new Map(), after ?? new Map())).toEqual(['a.ts'])

    await chmod(path.join(root, 'notes'), 0o000)
    expect(await captureFolderStats(root)).toBeUndefined()
  } finally {
    await chmod(path.join(root, 'notes'), 0o700)
    await rm(root, { recursive: true, force: true })
  }
})

it('credits a shared-checkout file only through the parts of a command that may write', () => {
  expect(namesFile(writingParts('git diff -- src/Foo.ts'), '/repo', 'src/Foo.ts')).toBe(false)
  expect(namesFile(writingParts('cat src/Foo.ts | head -5 && sed -n 1,4p src/Foo.ts'), '/repo', 'src/Foo.ts')).toBe(false)
  expect(namesFile(writingParts("cd apps/web && sed -i '' 's/a/b/' src/Foo.ts"), '/repo', 'apps/web/src/Foo.ts')).toBe(true)
  expect(namesFile(writingParts('rg needle input.txt>src/Foo.ts'), '/repo', 'src/Foo.ts')).toBe(true)
  // A redirected read writes its output, not the file it read.
  expect(namesFile(writingParts('cat src/Foo.ts > report.txt'), '/repo', 'src/Foo.ts')).toBe(false)
  expect(namesFile(writingParts('cat src/Foo.ts > report.txt'), '/repo', 'report.txt')).toBe(true)
  expect(namesFile(writingParts('git diff --output=out.patch -- src/Foo.ts'), '/repo', 'out.patch')).toBe(true)
  expect(namesFile(writingParts('git diff --output=out.patch -- src/Foo.ts'), '/repo', 'src/Foo.ts')).toBe(false)
  expect(namesFile(writingParts('git diff --output out.patch -- src/Foo.ts'), '/repo', 'out.patch')).toBe(true)
  // Only the folder a write ran in counts.
  const hopped = writingParts("cd apps/web; cd ../server; sed -i '' 's/a/b/' src/Button.tsx")
  expect(namesFile(hopped, '/repo', 'apps/server/src/Button.tsx')).toBe(true)
  expect(namesFile(hopped, '/repo', 'apps/web/src/Button.tsx')).toBe(false)
  // A later call can rely on the folder an earlier one moved into.
  expect(namesFile([...writingParts('cd apps/web/src'), ...writingParts("sed -i '' 's/a/b/' Button.tsx")],
    '/repo', 'apps/web/src/Button.tsx')).toBe(true)
})

it('credits no shared-checkout file to a command for running it', () => {
  // A verify script another Session edited, run from the repo root (2026-10-12).
  const script = '.cursor/skills/verify-manor/control-manor.mjs'
  const named = (command: string, file: string) => namesFile(writingParts(command), '/repo', file)
  expect(named(`/bin/zsh -lc 'MANOR_VERIFY_PORT=43181 node ${script} launch'`, script)).toBe(false)
  expect(named('node scripts/verify.mjs launch -p 43181', 'scripts/verify.mjs')).toBe(false)
  expect(named('bun run scripts/gen.ts', 'scripts/gen.ts')).toBe(false)
  expect(named('tsx scripts/verify.tsx', 'scripts/verify.tsx')).toBe(false)
  // What it is told to write still counts, and so does every word of code handed over another way.
  expect(named('node scripts/fix.mjs src/Foo.ts', 'src/Foo.ts')).toBe(true)
  expect(named('node src/gen.cjs Foo.ts', 'src/Foo.ts')).toBe(true)
  expect(named('OUT=src/Foo.ts bash scripts/write.sh', 'src/Foo.ts')).toBe(true)
  expect(named('node --cpu-prof-name src/run.cpuprofile scripts/noop.cjs', 'src/run.cpuprofile')).toBe(true)
  expect(named("node --eval=\"fs.writeFileSync(process.argv[1], '')\" src/Foo.ts", 'src/Foo.ts')).toBe(true)
  expect(named("python3 -c'open(sys.argv[1], \"w\")' src/Foo.ts", 'src/Foo.ts')).toBe(true)
  expect(named("printf 'printf x > \"$1\"' | bash -s -- src/Foo.ts", 'src/Foo.ts')).toBe(true)
  expect(named("python3 - <<'EOF'\nopen('src/Foo.ts', 'w')\nEOF", 'src/Foo.ts')).toBe(true)
  expect(named("while read -r f; do printf x > \"$f\"; done <<'EOF'\nsrc/Foo.ts\nEOF", 'src/Foo.ts')).toBe(true)
})

it('lists which reported paths the snapshot cannot hold', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'manor-turn-files-'))
  roots.push(root)
  await git(root, 'init', '-q')
  await writeFile(path.join(root, '.gitignore'), 'local-*.md\n.claude/\n.review/\n')
  const reported = ['local-notes.md', 'README.md', '.claude/plans/p.md', 'local-.env', 'apps/web/test/.review/save.test.tsx']
  expect([...await unmeasuredPaths(root, reported)]).toEqual(['local-notes.md'])
  expect([...await unmeasuredPaths(root, ['README.md'])]).toEqual([])
})

it('places each hunk at the line it occupies in the file', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'manor-turn-files-'))
  roots.push(root)
  await git(root, 'init', '-q')
  const lines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`)
  await writeFile(path.join(root, 'long.txt'), `${lines.join('\n')}\n`)
  const start = await captureTurnTree(root)
  lines[29] = 'changed 30'
  lines.splice(9, 1)
  await writeFile(path.join(root, 'long.txt'), `${lines.join('\n')}\n`)
  const end = await captureTurnTree(root)
  const [change] = await diffTurnTrees(root, start, end)

  // Two context lines above each change: line 10 went, line 30 became line 29.
  expect(change?.edits.map((edit) => edit.offset)).toEqual([
    { before: 7, after: 7 },
    { before: 27, after: 26 },
  ])
})
