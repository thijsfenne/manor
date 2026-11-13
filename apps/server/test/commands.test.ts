import { describe, expect, it } from 'vitest'
import { redactToolActivity } from '../src/drivers/toolActivity.js'
import { describeCommand } from '../src/drivers/commands.js'

describe('describeCommand', () => {
  it('labels a plain command by the caller\'s description and keeps the command', () => {
    const command = 'cd /repo && pnpm exec vitest run test/a.test.ts'
    const activity = describeCommand(command, undefined, '  Run the a tests\n')
    expect(activity).toMatchObject({ tool: 'Shell', command })
    expect(redactToolActivity(activity, (value) => value).subject).toBe('Run the a tests')
  })

  it('keeps the deterministic label when the command resolves into a read', () => {
    const activity = describeCommand("sed -n '1,40p' README.md", undefined, 'Show the readme')
    expect(activity).toMatchObject({ tool: 'Read', targets: ['README.md'] })
    expect(activity).not.toHaveProperty('subject')
  })

  it('extracts every file from a chained read command', () => {
    const command = `/bin/zsh -lc "sed -n '1,240p' README.md; sed -n '1,240p' AGENTS.md; sed -n '1,220p' user-core.md"`

    expect(describeCommand(command)).toEqual({
      tool: 'Read',
      detail: '3 files',
      targets: ['README.md', 'AGENTS.md', 'user-core.md'],
      command,
    })
  })

  it('extracts only files from newline-separated read commands', () => {
    const command = `/bin/zsh -lc "sed -n '1,240p' TextEditor.tsx
sed -n '1,220p' RepoFilesPanel.tsx
sed -n '1,240p' DESIGN.md"`

    expect(describeCommand(command)).toEqual({
      tool: 'Read',
      detail: '3 files',
      targets: ['TextEditor.tsx', 'RepoFilesPanel.tsx', 'DESIGN.md'],
      command,
    })
  })

  it('names a repository listing without presenting it as a generic shell command', () => {
    const command = `/bin/zsh -lc "pwd && rg --files -g '!**/.env*' -g '!**/.git/**'"`

    expect(describeCommand(command)).toEqual({
      tool: 'Search',
      detail: 'repository files',
      command,
    })
  })

  it('reads an unwrapped cat the way Claude actually sends it', () => {
    const command = 'cat apps/web/src/composerDrafts.ts'
    expect(describeCommand(command)).toEqual({
      tool: 'Read',
      detail: 'apps/web/src/composerDrafts.ts',
      targets: ['apps/web/src/composerDrafts.ts'],
      command,
    })
  })

  it('does not call a sed -i a read', () => {
    expect(describeCommand("sed -i '' 's/a/b/' notes.md")).toMatchObject({ tool: 'Shell' })
  })

  it('turns a grep of one file into a Search with that target', () => {
    const command = 'grep -n "stageComposer" apps/web/src/App.tsx'
    expect(describeCommand(command)).toEqual({
      tool: 'Search',
      detail: 'apps/web/src/App.tsx',
      subject: '“stageComposer” in apps/web/src/App.tsx',
      targets: ['apps/web/src/App.tsx'],
      command,
    })
  })

  it('keeps context flags from being mistaken for paths', () => {
    const command = 'grep -n "tool_use" -B 30 apps/server/src/drivers/claudeDriver.ts'
    expect(describeCommand(command)).toEqual({
      tool: 'Search',
      detail: 'apps/server/src/drivers/claudeDriver.ts',
      subject: '“tool_use” in apps/server/src/drivers/claudeDriver.ts',
      targets: ['apps/server/src/drivers/claudeDriver.ts'],
      command,
    })
  })

  it('counts every directory a grep searched', () => {
    const command = 'grep -rn "COMPOSER_TRAVEL_MS" apps/web/src apps/web/test'
    expect(describeCommand(command)).toEqual({
      tool: 'Search',
      detail: '2 files',
      targets: ['apps/web/src', 'apps/web/test'],
      subject: '“COMPOSER_TRAVEL_MS” in apps/web/src, apps/web/test',
      command,
    })
  })

  it('does not turn shell redirects or operators into searched files', () => {
    const command = [
      'rg -n "forced balance"',
      '/Users/sam/notes/memory/projects/example-app.md',
      '/Users/sam/notes/memory',
      '2>/dev/null | head -20 && true',
    ].join(' ')

    expect(describeCommand(command)).toEqual({
      tool: 'Search',
      detail: '2 files',
      targets: [
        '/Users/sam/notes/memory/projects/example-app.md',
        '/Users/sam/notes/memory',
      ],
      subject: '“forced balance” in /Users/sam/notes/memory/projects/example-app.md, /Users/sam/notes/memory',
      command,
    })
  })

  it('does not describe a mixed read and test script as only a read', () => {
    expect(describeCommand('cat README.md && pnpm test')).toEqual({
      tool: 'Shell', detail: 'cat README.md && pnpm test', command: 'cat README.md && pnpm test',
    })
  })

  it('does not call a script a search because it ends in a grep', () => {
    const script = "python3 - <<'EOF'\np=pathlib.Path('a.ts'); p.write_text(p.read_text().replace('x', 'y'))\nEOF"
    expect(describeCommand(script)).toMatchObject({ tool: 'Shell' })
    expect(describeCommand('pnpm exec vitest run 2>&1 | grep -E "Tests |FAIL"')).toMatchObject({ tool: 'Shell' })
  })

  it('does not call a search that writes its results a search', () => {
    expect(describeCommand('rg x input | sort -o output.txt')).toMatchObject({ tool: 'Shell' })
    expect(describeCommand('rg x > output.txt')).toMatchObject({ tool: 'Shell' })
    expect(describeCommand('rg x 2>/dev/null | head -5')).toMatchObject({ tool: 'Search' })
    expect(describeCommand('rg needle input.txt>output.txt')).toMatchObject({ tool: 'Shell' })
    expect(describeCommand("rg '>' README.md 2>&1")).toMatchObject({ tool: 'Search' })
  })

  it('leaves a real command as Shell', () => {
    const command = 'git status --short && git log --oneline -12'
    expect(describeCommand(command)).toEqual({
      tool: 'Shell',
      detail: command,
      command,
    })
  })
})

describe('describeCommand with apply_patch', () => {
  it('reads an apply_patch as an edit rather than a shell command that opened files', () => {
    const patch = [
      "apply_patch <<'EOF'",
      '*** Begin Patch',
      '*** Update File: notes.md',
      '@@',
      ' # Notes',
      '-- who owns the intake form',
      '+- who owns the intake form',
      '+- when does the pilot start',
      '*** End Patch',
      'EOF',
    ].join('\n')

    const described = describeCommand(patch)
    expect(described.tool).toBe('Edit')
    expect(described.detail).toBe('notes.md')
    expect(described.edits).toEqual([
      {
        path: 'notes.md',
        before: '# Notes\n- who owns the intake form\n',
        after: '# Notes\n- who owns the intake form\n- when does the pilot start\n',
      },
    ])
  })

  it('still describes an ordinary read command without edits', () => {
    const described = describeCommand(`/bin/zsh -lc "sed -n '1,40p' README.md"`)
    expect(described.tool).toBe('Read')
    expect(described.edits).toBeUndefined()
  })
})

describe('describeCommand with shell writes', () => {
  it('reads a cat heredoc as an edit of that file', () => {
    const command = ["cat > notes.md <<'EOF'", 'hello', 'EOF'].join('\n')
    const described = describeCommand(command, () => false)
    expect(described.tool).toBe('Edit')
    expect(described.detail).toBe('notes.md')
    expect(described.edits).toEqual([{ path: 'notes.md', after: 'hello\n', created: true, offset: { before: 0, after: 0 } }])
  })

  it('does not treat a cat of an existing file as a creation', () => {
    const command = ["cat > notes.md <<'EOF'", 'hello', 'EOF'].join('\n')
    const described = describeCommand(command, () => true)
    expect(described.edits?.[0]).not.toHaveProperty('created')
  })

  it('reads a python replacement as the two sides of one hunk', () => {
    const command = [
      "python3 - <<'PYEOF'",
      "p = 'apps/web/src/motion.ts'",
      's = open(p).read()',
      'old = """',
      'const travel = 180',
      '"""',
      'new = """',
      'const travel = 220',
      '"""',
      'if old not in s:',
      "    raise SystemExit('not found')",
      's = s.replace(old, new, 1)',
      "open(p, 'w').write(s)",
      'PYEOF',
    ].join('\n')

    const described = describeCommand(command)
    expect(described.tool).toBe('Edit')
    expect(described.detail).toBe('apps/web/src/motion.ts')
    expect(described.edits).toEqual([
      {
        path: 'apps/web/src/motion.ts',
        before: 'const travel = 180\n',
        after: 'const travel = 220\n',
      },
    ])
  })

  it('does not call a python script that only reads a file an edit', () => {
    const command = [
      "python3 - <<'PY'",
      "p = 'notes.md'",
      'print(open(p).read())',
      'PY',
    ].join('\n')
    expect(describeCommand(command)).toMatchObject({ tool: 'Shell' })
  })

  it('does not call a python read with an encoding argument an edit', () => {
    const command = [
      "python3 - <<'PY'",
      "p = 'notes.md'",
      'old = """before"""',
      'new = """after"""',
      "print(open(p, encoding='utf-8').read())",
      'PY',
    ].join('\n')
    expect(describeCommand(command)).toMatchObject({ tool: 'Shell' })
  })

  it('reads a write on a path variable that is not named p', () => {
    const command = [
      "python3 - <<'PY'",
      "path = Path('notes.md')",
      "path.write_text('hello')",
      'PY',
    ].join('\n')
    const described = describeCommand(command, () => false)
    expect(described.tool).toBe('Edit')
    expect(described.detail).toBe('notes.md')
    expect(described.edits).toEqual([{ path: 'notes.md', kind: 'add' }])
  })

  it('reads a cat heredoc whose path is quoted and contains spaces', () => {
    const command = ["cat > 'notes with spaces.md' <<'EOF'", 'hello', 'EOF'].join('\n')
    const described = describeCommand(command, () => false)
    expect(described.tool).toBe('Edit')
    expect(described.detail).toBe('notes with spaces.md')
    expect(described.edits).toEqual([{ path: 'notes with spaces.md', after: 'hello\n', created: true, offset: { before: 0, after: 0 } }])
  })
})
