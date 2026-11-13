import { EDIT_SIDE_LIMIT, MAX_EDITS_PER_CALL, REASONING_LIMIT, ThreadEventSchema } from '@manor/contracts'
import { describe, expect, it } from 'vitest'
import {
  buildEdit,
  editsFromApplyPatch,
  editsFromCodexFileChanges,
  editsFromCursorToolCall,
  editsFromShellWrite,
  editsFromToolInput,
  isEditTool,
  withEditOrigins,
} from '../src/drivers/edits.js'

describe('withEditOrigins', () => {
  it('records the exact linked folder for a native relative file edit', () => {
    expect(withEditOrigins([{ path: '../shared/notes.md', before: 'old', after: 'new' }],
      '/project/work', ['/project/work', '/project/shared']))
      .toEqual([{ path: '../shared/notes.md', originPath: '/project/shared/notes.md',
        panelPath: 'shared/notes.md', before: 'old', after: 'new' }])
  })

  it('normalizes an absolute path before choosing its linked folder', () => {
    expect(withEditOrigins([{ path: '/checkout/../shared/notes.md' }], '/scratch', ['/checkout', '/shared']))
      .toEqual([{ path: '/checkout/../shared/notes.md', originPath: '/shared/notes.md',
        panelPath: 'shared/notes.md' }])
  })

  it('records an absolute origin even when it needs no normalization', () => {
    expect(withEditOrigins([{ path: '/scratch/Shared/notes.md' }], '/checkout', ['/checkout', '/shared']))
      .toEqual([{ path: '/scratch/Shared/notes.md', originPath: '/scratch/Shared/notes.md' }])
  })
})

describe('isEditTool', () => {
  it('recognises the tools that change files and nothing else', () => {
    for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'search_replace', 'str_replace_editor']) {
      expect(isEditTool(tool), tool).toBe(true)
    }
    for (const tool of ['Read', 'Grep', 'Bash', 'WebFetch']) {
      expect(isEditTool(tool), tool).toBe(false)
    }
  })
})

describe('buildEdit', () => {
  it('keeps both sides when they fit', () => {
    expect(buildEdit('a.md', 'one', 'two')).toEqual({ path: 'a.md', before: 'one', after: 'two' })
  })

  it('flags a side that lost its tail rather than showing a diff that lies', () => {
    const edit = buildEdit('a.md', 'x'.repeat(EDIT_SIDE_LIMIT + 50), 'y')
    expect(edit.before).toHaveLength(EDIT_SIDE_LIMIT)
    expect(edit.truncated).toBe(true)
  })

  it('omits an absent side instead of storing an empty string', () => {
    const edit = buildEdit('new.md', undefined, 'hello')
    expect(edit.before).toBeUndefined()
    expect(edit).not.toHaveProperty('truncated')
  })
})

describe('editsFromToolInput', () => {
  it('reads an Edit as the two sides of one hunk', () => {
    expect(editsFromToolInput('Edit', { file_path: '/tmp/a.md', old_string: 'a', new_string: 'b' })).toEqual([
      { path: '/tmp/a.md', before: 'a', after: 'b' },
    ])
  })

  it('reads Grok search_replace through the same replacement shape', () => {
    expect(
      editsFromToolInput('search_replace', {
        file_path: '/tmp/a.md',
        old_string: 'before',
        new_string: 'after',
      }),
    ).toEqual([{ path: '/tmp/a.md', before: 'before', after: 'after' }])
  })

  it('treats a Write as a file with no previous contents', () => {
    const edits = editsFromToolInput('Write', { file_path: '/tmp/new.md', content: 'fresh' })
    expect(edits).toEqual([{ path: '/tmp/new.md', after: 'fresh', offset: { before: 0, after: 0 } }])
  })

  it('will not call a Write a creation without being told the file was absent', () => {
    const edits = editsFromToolInput('Write', { file_path: '/tmp/there.md', content: 'fresh' }, () => true)
    expect(edits?.[0]).not.toHaveProperty('created')
  })

  it('marks a Write as created only when the file was not there beforehand', () => {
    const edits = editsFromToolInput('Write', { file_path: '/tmp/new.md', content: 'fresh' }, () => false)
    expect(edits).toEqual([{ path: '/tmp/new.md', after: 'fresh', created: true, offset: { before: 0, after: 0 } }])
  })

  it('never calls a targeted Edit a creation, however the disk answers', () => {
    const edits = editsFromToolInput('Edit', { file_path: '/tmp/a.md', old_string: 'a', new_string: 'b' }, () => false)
    expect(edits?.[0]).not.toHaveProperty('created')
  })

  it('splits a MultiEdit into one row per hunk against the same file', () => {
    const edits = editsFromToolInput('MultiEdit', {
      file_path: '/tmp/a.md',
      edits: [
        { old_string: 'one', new_string: '1' },
        { old_string: 'two', new_string: '2' },
      ],
    })
    expect(edits).toHaveLength(2)
    expect(edits?.map((edit) => edit.after)).toEqual(['1', '2'])
    expect(new Set(edits?.map((edit) => edit.path))).toEqual(new Set(['/tmp/a.md']))
  })

  it('reads a NotebookEdit through its own path key', () => {
    expect(editsFromToolInput('NotebookEdit', { notebook_path: '/tmp/n.ipynb', new_source: 'print(1)' })).toEqual([
      { path: '/tmp/n.ipynb', after: 'print(1)' },
    ])
  })

  it('returns nothing for a read-only tool, so no diff is offered', () => {
    expect(editsFromToolInput('Read', { file_path: '/tmp/a.md' })).toBeUndefined()
    expect(editsFromToolInput('Edit', { file_path: '/tmp/a.md' })).toBeUndefined()
    expect(editsFromToolInput('Edit', 'not-an-object')).toBeUndefined()
  })
})

describe('editsFromShellWrite', () => {
  it('reads a cat heredoc as a whole-file write', () => {
    const command = ["cat > apps/web/test/foo.test.ts <<'TS'", "import { it } from 'vitest'", 'TS'].join('\n')
    expect(editsFromShellWrite(command, () => false)).toEqual([
      { path: 'apps/web/test/foo.test.ts', after: "import { it } from 'vitest'\n", created: true, offset: { before: 0, after: 0 } },
    ])
  })

  it('reads a python old/new replacement', () => {
    const command = [
      "python3 - <<'PYEOF'",
      "p = 'apps/web/src/App.tsx'",
      's = open(p).read()',
      'old = """before"""',
      'new = """after"""',
      "open(p, 'w').write(s.replace(old, new, 1))",
      'PYEOF',
    ].join('\n')
    expect(editsFromShellWrite(command)).toEqual([
      { path: 'apps/web/src/App.tsx', before: 'before', after: 'after' },
    ])
  })

  it('leaves a command that is not a write alone', () => {
    expect(editsFromShellWrite('sed -n 1,40p README.md')).toBeUndefined()
    expect(editsFromShellWrite('cat README.md')).toBeUndefined()
  })

  it('does not treat a python read with an encoding argument as a write', () => {
    const command = [
      "python3 - <<'PY'",
      "p = 'notes.md'",
      'old = """before"""',
      'new = """after"""',
      "print(open(p, encoding='utf-8').read())",
      'PY',
    ].join('\n')
    expect(editsFromShellWrite(command)).toBeUndefined()
  })

  it('does not treat old and new as an edit without a write', () => {
    const command = [
      "python3 - <<'PY'",
      "p = 'notes.md'",
      'old = """before"""',
      'new = """after"""',
      'print(old, new)',
      'PY',
    ].join('\n')
    expect(editsFromShellWrite(command)).toBeUndefined()
  })

  it('reads a write on a path variable that is not named p', () => {
    const command = [
      "python3 - <<'PY'",
      "path = Path('notes.md')",
      "path.write_text('hello')",
      'PY',
    ].join('\n')
    expect(editsFromShellWrite(command, () => false)).toEqual([{ path: 'notes.md', kind: 'add' }])
  })

  it('reads a python replacement through a name other than p', () => {
    const command = [
      "python3 - <<'PYEOF'",
      "target = 'apps/web/src/App.tsx'",
      's = open(target).read()',
      'old = """before"""',
      'new = """after"""',
      "open(target, 'w').write(s.replace(old, new, 1))",
      'PYEOF',
    ].join('\n')
    expect(editsFromShellWrite(command)).toEqual([
      { path: 'apps/web/src/App.tsx', before: 'before', after: 'after' },
    ])
  })

  it('reads a cat heredoc whose path is quoted and contains spaces', () => {
    for (const quoted of [`'notes with spaces.md'`, `"notes with spaces.md"`]) {
      const command = [`cat > ${quoted} <<'EOF'`, 'hello', 'EOF'].join('\n')
      expect(editsFromShellWrite(command, () => false), quoted).toEqual([
        { path: 'notes with spaces.md', after: 'hello\n', created: true, offset: { before: 0, after: 0 } },
      ])
    }
  })
})

describe('editsFromApplyPatch', () => {
  it('leaves an ordinary shell command alone', () => {
    expect(editsFromApplyPatch('rg --files')).toBeUndefined()
  })

  it('puts context lines on both sides of an update', () => {
    const patch = [
      "apply_patch <<'EOF'",
      '*** Begin Patch',
      '*** Update File: notes.md',
      '@@',
      ' # Notes',
      '-old line',
      '+new line',
      '*** End Patch',
      'EOF',
    ].join('\n')
    expect(editsFromApplyPatch(patch)).toEqual([
      { path: 'notes.md', before: '# Notes\nold line\n', after: '# Notes\nnew line\n' },
    ])
  })

  it('marks an added file as created, since the patch header says so outright', () => {
    const patch = ['*** Begin Patch', '*** Add File: new.md', '+hello', '*** End Patch'].join('\n')
    expect(editsFromApplyPatch(patch)).toEqual([{ path: 'new.md', after: 'hello\n', created: true, offset: { before: 0, after: 0 } }])
  })

  it('models a delete as a file with neither side', () => {
    const patch = ['*** Begin Patch', '*** Delete File: gone.md', '*** End Patch'].join('\n')
    expect(editsFromApplyPatch(patch)).toEqual([{ path: 'gone.md' }])
  })

  it('splits a patch that touches several files', () => {
    const patch = [
      '*** Begin Patch',
      '*** Update File: a.md',
      '-a',
      '+A',
      '*** Update File: b.md',
      '-b',
      '+B',
      '*** End Patch',
    ].join('\n')
    const edits = editsFromApplyPatch(patch)
    expect(edits?.map((edit) => edit.path)).toEqual(['a.md', 'b.md'])
    expect(edits?.map((edit) => edit.after)).toEqual(['A\n', 'B\n'])
  })
})

describe('editsFromCodexFileChanges', () => {
  it('keeps the paths and operation without inventing diff contents', () => {
    expect(
      editsFromCodexFileChanges([
        { path: 'new.md', kind: { type: 'add' }, diff: '' },
        { path: 'notes.md', kind: { type: 'update', move_path: null }, diff: '' },
        { path: 'gone.md', kind: { type: 'delete' }, diff: '' },
      ]),
    ).toEqual([
      { path: 'new.md', kind: 'add' },
      { path: 'notes.md', kind: 'update' },
      { path: 'gone.md', kind: 'delete' },
    ])
  })

  it('drops malformed changes and keeps the transcript caps', () => {
    const changes = Array.from({ length: 60 }, (_, index) => ({
      path: `f${index}.md`, kind: { type: 'update', move_path: null }, diff: '',
    }))
    changes.push({ path: 'not-a-change.md', kind: { type: 'move', move_path: null }, diff: '' })
    expect(editsFromCodexFileChanges(changes)).toHaveLength(MAX_EDITS_PER_CALL)
    expect(editsFromCodexFileChanges('not an array')).toBeUndefined()
  })
})

describe('editsFromCursorToolCall', () => {
  it('reads the landed hunk from Cursor\'s successful native edit result', () => {
    expect(editsFromCursorToolCall({
      editToolCall: {
        args: { path: '/tmp/notes.md', streamContent: 'one\nchanged\nthree\n' },
        result: {
          success: {
            path: '/tmp/notes.md',
            linesAdded: 1,
            linesRemoved: 1,
            diffString: [
              '--- a/notes.md',
              '+++ b/notes.md',
              '@@ -1,3 +1,3 @@',
              ' one',
              '-two',
              '+changed',
              ' three',
            ].join('\n'),
          },
        },
      },
    })).toEqual([{
      path: '/tmp/notes.md',
      before: 'one\ntwo\nthree\n',
      after: 'one\nchanged\nthree\n',
      offset: { before: 0, after: 0 },
    }])
  })

  it('marks a /dev/null diff as a creation and ignores a successful no-op', () => {
    expect(editsFromCursorToolCall({
      editToolCall: {
        args: { path: '/tmp/new.md', streamContent: 'fresh\n' },
        result: {
          success: {
            path: '/tmp/new.md',
            linesAdded: 1,
            linesRemoved: 0,
            diffString: '--- /dev/null\n+++ b/new.md\n@@ -0,0 +1 @@\n+fresh',
          },
        },
      },
    })).toEqual([{ path: '/tmp/new.md', after: 'fresh\n', created: true, offset: { before: 0, after: 0 } }])

    expect(editsFromCursorToolCall({
      editToolCall: {
        args: { path: '/tmp/same.md' },
        result: { success: { path: '/tmp/same.md', linesAdded: 0, linesRemoved: 0, diffString: '' } },
      },
    })).toBeUndefined()
  })

  it('uses Cursor write contents and the pre-write existence check for a creation', () => {
    const call = {
      writeToolCall: {
        args: { path: 'summary.txt', fileText: '# Summary\n\nFresh.\n' },
        result: {
          success: { path: '/tmp/summary.txt', linesCreated: 3, fileSize: 19 },
        },
      },
    }

    expect(editsFromCursorToolCall(call, false)).toEqual([{
      path: '/tmp/summary.txt',
      after: '# Summary\n\nFresh.\n',
      created: true,
      offset: { before: 0, after: 0 },
    }])
    expect(editsFromCursorToolCall(call, true)).toEqual([{
      path: '/tmp/summary.txt',
      after: '# Summary\n\nFresh.\n',
      offset: { before: 0, after: 0 },
    }])
  })

  it('uses Cursor delete contents and falls back to file metadata', () => {
    expect(editsFromCursorToolCall({
      deleteToolCall: {
        args: { path: 'old.txt' },
        result: { success: { path: '/tmp/old.txt', prevContent: 'old\n' } },
      },
    })).toEqual([{ path: '/tmp/old.txt', before: 'old\n' }])

    expect(editsFromCursorToolCall({
      deleteToolCall: {
        args: { path: 'opaque.txt' },
        result: { success: { path: '/tmp/opaque.txt' } },
      },
    })).toEqual([{ path: '/tmp/opaque.txt', kind: 'delete' }])
  })

  it('keeps an unparseable landed diff as an update instead of implying deletion', () => {
    expect(editsFromCursorToolCall({
      editToolCall: {
        args: { path: '/tmp/opaque.md' },
        result: {
          success: {
            path: '/tmp/opaque.md',
            linesAdded: 1,
            linesRemoved: 1,
            diffString: 'provider changed the file without a unified diff',
          },
        },
      },
    })).toEqual([{ path: '/tmp/opaque.md', kind: 'update' }])

    expect(editsFromCursorToolCall({
      writeToolCall: {
        args: { path: '/tmp/missing-diff.md' },
        result: { success: { path: '/tmp/missing-diff.md', linesAdded: 2, linesRemoved: 1 } },
      },
    })).toEqual([{ path: '/tmp/missing-diff.md', kind: 'update' }])
  })
})

/**
 * The caps exist so one pathological turn cannot make a thread expensive to load.
 * That only works if the driver trims BEFORE the store validates: an edit that got
 * past the driver oversized would fail zod at append time and break the whole turn.
 */
describe('caps hold at the store boundary', () => {
  const toolUse = (edits: unknown) =>
    ThreadEventSchema.safeParse({
      id: 'e1',
      ts: 1,
      type: 'tool_use',
      agentId: 'sage',
      turnId: 't1',
      tool: 'Edit',
      edits,
    })

  it('trims an oversized Edit rather than letting it fail validation', () => {
    const huge = 'x'.repeat(EDIT_SIDE_LIMIT * 3)
    expect(toolUse(editsFromToolInput('Edit', { file_path: '/tmp/a.md', old_string: huge, new_string: huge })).success).toBe(true)
  })

  it('trims an oversized apply_patch the same way', () => {
    const body = Array.from({ length: 5_000 }, (_, index) => `+line ${index}`).join('\n')
    const edits = editsFromApplyPatch(`*** Begin Patch\n*** Add File: big.md\n${body}\n*** End Patch`)
    expect(toolUse(edits).success).toBe(true)
  })

  it('trims a patch that touches more files than the per-call cap', () => {
    const files = Array.from({ length: 60 }, (_, index) => `*** Update File: f${index}.md\n-a\n+b`).join('\n')
    const edits = editsFromApplyPatch(`*** Begin Patch\n${files}\n*** End Patch`)
    expect(edits?.length).toBeLessThanOrEqual(MAX_EDITS_PER_CALL)
    expect(toolUse(edits).success).toBe(true)
  })

  it('trims a path longer than the cap instead of rejecting the event', () => {
    expect(toolUse([buildEdit('/'.repeat(900), 'a', 'b')]).success).toBe(true)
  })

  it('accepts reasoning at exactly the cap', () => {
    const parsed = ThreadEventSchema.safeParse({
      id: 'e1',
      ts: 1,
      type: 'reasoning',
      agentId: 'sage',
      turnId: 't1',
      text: 'y'.repeat(REASONING_LIMIT),
    })
    expect(parsed.success).toBe(true)
  })
})
