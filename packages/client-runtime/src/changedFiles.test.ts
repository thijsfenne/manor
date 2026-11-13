import { describe, expect, it } from 'vitest'
import type { ThreadEvent } from '@manor/contracts'

import { chatChangedFiles, compactCount, resolveMarkdownRepoLink, turnChangedFiles } from './changedFiles'
import { emptyThread, rowsOf, type TurnRow } from './state'

const root = '/checkouts/Manor'
const listing = ['Manor/src/App.tsx', 'Manor/src/Other.tsx']
const tool = (path: string, before = 'old\n', after = 'new\n') => ({
  kind: 'tool' as const,
  key: path,
  tool: 'Write',
  status: 'done' as const,
  startedAt: 1,
  edits: [{ path, before, after }],
})
const turn = (patch: Partial<TurnRow>): TurnRow => ({
  kind: 'turn', key: 'turn', turnId: 'turn', agentId: 'smith', asks: [], drafts: [],
  activities: [], timeline: [], segments: [], answer: [], tail: [], ...patch,
})

describe('measured turn changes', () => {
  it('uses exact snapshot totals and hunks, while keeping reports outside measured roots', () => {
    const measured = { path: `${root}/src/App.tsx`, panelPath: 'Manor/src/App.tsx', status: 'edited' as const, added: 4, removed: 2,
      edits: [{ path: 'src/App.tsx', before: 'old\n', after: 'new\n' }], diffTruncated: true }
    const files = turnChangedFiles(turn({
      activities: [tool(`${root}/src/App.tsx`), tool('/notes/log.md')],
      fileChanges: [measured], fileChangeRoots: [root],
    }), listing)

    expect(files).toHaveLength(2)
    expect(files[0]).toMatchObject({ path: 'src/App.tsx', panelPath: 'Manor/src/App.tsx',
      added: 4, removed: 2, diffTruncated: true, edits: measured.edits })
    expect(files[1]).toMatchObject({ raw: '/notes/log.md', added: 1, removed: 1 })
  })

  // A turn that only wrote memory shows no banner; a real code edit beside it still does.
  it('leaves memory files out and keeps every other change', () => {
    const daily = '/Users/sam/notes/memory/daily/2026-09-28.md'
    const memoryChanges = [{ path: daily, lines: [{ kind: 'added' as const, text: '- [m/smith] Line.' }] }]
    expect(turnChangedFiles(turn({ activities: [tool(daily)], memoryChanges }), listing)).toEqual([])
    expect(turnChangedFiles(turn({
      activities: [tool(daily), tool(`${root}/src/App.tsx`)],
      fileChanges: [{ path: `${root}/src/App.tsx`, status: 'edited', added: 1, removed: 1, edits: [] }],
      fileChangeRoots: [root],
      memoryChanges,
    }), listing)).toMatchObject([{ raw: `${root}/src/App.tsx` }])
  })

  // The footer card cannot show a cut memory diff in full, so the banner keeps it.
  it('keeps a memory file whose change was cut', () => {
    const daily = '/Users/sam/notes/memory/daily/2026-09-28.md'
    const memoryChanges = [{ path: daily, lines: [{ kind: 'added' as const, text: '- [m/smith] Line.' }], truncated: true as const }]
    expect(turnChangedFiles(turn({ activities: [tool(daily)], memoryChanges }), listing)).toMatchObject([{ raw: daily }])
  })

  it('hides a captured file restored to its starting state, including a relative tool report', () => {
    expect(turnChangedFiles(turn({
      activities: [{ ...tool('src/App.tsx'), edits: [{ path: 'src/App.tsx', originPath: `${root}/src/App.tsx`, before: 'old', after: 'new' }] }],
      fileChanges: [], fileChangeRoots: [root],
    }), listing)).toEqual([])
  })

  it('keeps the tool report of an ignored file the snapshot could not see', () => {
    expect(turnChangedFiles(turn({
      activities: [tool(`${root}/local-notes.md`)],
      fileChanges: [], fileChangeRoots: [root], fileChangeUnmeasured: [`${root}/local-notes.md`],
    }), listing)).toMatchObject([{ raw: `${root}/local-notes.md`, added: 1, removed: 1 }])
  })

  it('keeps a relative tool report only when its driver located it in a shared folder', () => {
    const files = turnChangedFiles(turn({
      activities: [{ ...tool('notes.md'), edits: [{ path: 'notes.md', originPath: '/shared/notes.md',
        panelPath: 'Shared/notes.md', before: 'old', after: 'new' }] }],
      fileChanges: [], fileChangeRoots: [root],
    }), [...listing, 'Shared/notes.md'])
    expect(files).toMatchObject([{ panelPath: 'Shared/notes.md', raw: '/shared/notes.md' }])
    expect(turnChangedFiles(turn({
      activities: [tool('notes.md')], fileChanges: [], fileChangeRoots: [root],
    }), [...listing, 'Shared/notes.md'])).toEqual([])
  })

  it('never opens a shared file just because a scratch edit has the same relative name', () => {
    const files = turnChangedFiles(turn({
      activities: [{ ...tool('notes.md'), edits: [{ path: 'notes.md', originPath: '/scratch/notes.md',
        before: 'old', after: 'new' }] }],
      fileChanges: [], fileChangeRoots: [root],
    }), ['Shared/notes.md'])
    expect(files).toMatchObject([{ raw: '/scratch/notes.md', path: '/scratch/notes.md' }])
    expect(files[0]?.panelPath).toBeUndefined()
  })

  it('does not guess a listed file from the suffix of an absolute scratch path', () => {
    for (const edits of [
      [{ path: '/scratch/Shared/notes.md', originPath: '/scratch/Shared/notes.md', before: 'old', after: 'new' }],
      [{ path: '/scratch/Shared/notes.md', before: 'old', after: 'new' }],
    ]) {
      const files = turnChangedFiles(turn({
        activities: [{ ...tool('/scratch/Shared/notes.md'), edits }],
        fileChanges: [], fileChangeRoots: [root],
      }), ['Shared/notes.md'])
      expect(files).toMatchObject([{ raw: '/scratch/Shared/notes.md', path: '/scratch/Shared/notes.md' }])
      expect(files[0]?.panelPath).toBeUndefined()
    }
  })

  it('keeps an outside origin even when its label starts with a captured label', () => {
    const files = turnChangedFiles(turn({
      activities: [{ ...tool('notes.md'), edits: [{ path: 'notes.md', originPath: '/shared/notes.md',
        panelPath: 'a/b/notes.md', before: 'old', after: 'new' }] }],
      fileChanges: [], fileChangeRoots: ['/checkouts/a'],
    }), ['a/b/notes.md'])
    expect(files).toMatchObject([{ panelPath: 'a/b/notes.md', raw: '/shared/notes.md' }])
  })

  it('keeps a shared change reached by an absolute path through the checkout parent', () => {
    const files = turnChangedFiles(turn({
      activities: [tool('/checkout/../shared/notes.md')], fileChanges: [], fileChangeRoots: ['/checkout'],
    }), ['Shared/notes.md'])
    expect(files).toHaveLength(1)
    expect(files[0]?.raw).toBe('/shared/notes.md')
  })

  it('never links a measured file to a matching name in another folder', () => {
    const files = turnChangedFiles(turn({
      fileChanges: [{ path: '/checkouts/A/src/New.tsx', panelPath: 'A/src/New.tsx',
        status: 'created', added: 1, removed: 0, edits: [] }],
      fileChangeRoots: ['/checkouts/A'],
    }), ['B/src/New.tsx'])
    expect(files).toMatchObject([{ path: 'A/src/New.tsx', raw: '/checkouts/A/src/New.tsx' }])
    expect(files[0]?.panelPath).toBeUndefined()
  })

  it('does not revive an ambiguous relative tool report after both checkouts return to their starting state', () => {
    expect(turnChangedFiles(turn({
      activities: [tool('src/App.tsx')], fileChanges: [],
      fileChangeRoots: ['/checkouts/A', '/checkouts/B'],
    }), ['A/src/App.tsx', 'B/src/App.tsx'])).toEqual([])
  })

  it('keeps old turns and failed snapshots on their tool reports', () => {
    const old = turn({ activities: [tool('src/App.tsx')] })
    const failed = turn({ activities: [tool('src/Other.tsx')], fileChanges: undefined })
    expect(chatChangedFiles([old, failed], listing).map((file) => file.path)).toEqual(['src/App.tsx', 'src/Other.tsx'])
  })

  it('adds measured changes to the conversation total once per file', () => {
    const first = turn({ fileChanges: [{ path: `${root}/src/App.tsx`, panelPath: 'Manor/src/App.tsx', status: 'edited',
      added: 3, removed: 1, edits: [] }], fileChangeRoots: [root] })
    const second = turn({ activities: [tool('src/App.tsx')] })
    const files = chatChangedFiles([first, second], listing)
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ added: 4, removed: 2 })
  })

  it('drops a file one turn created and a later turn deleted from the conversation total', () => {
    const measured = (status: 'created' | 'deleted') => turn({ fileChanges: [
      { path: `${root}/src/App.js`, status, added: status === 'created' ? 9 : 0, removed: status === 'deleted' ? 9 : 0, edits: [] },
      { path: `${root}/src/App.tsx`, panelPath: 'Manor/src/App.tsx', status: 'edited', added: 1, removed: 1, edits: [] },
    ], fileChangeRoots: [root] })
    expect(chatChangedFiles([measured('created'), measured('deleted')], listing).map((file) => file.path)).toEqual(['src/App.tsx'])
    // A file that was there before the conversation stays deleted, however often it came back in between.
    expect(chatChangedFiles([measured('deleted'), measured('created'), measured('deleted')], listing)
      .map((file) => [file.path, file.status])).toEqual([['src/App.js', 'deleted'], ['src/App.tsx', 'edited']])
  })

  it('hydrates the measured result from durable transcript events', () => {
    const events: ThreadEvent[] = [{ id: 'result', ts: 1, type: 'turn_result', turnId: 'turn', agentId: 'smith',
      fileChanges: [], fileChangeRoots: [root] }]
    const row = rowsOf({ ...emptyThread, events }).find((item): item is TurnRow => item.kind === 'turn')
    expect(row).toMatchObject({ fileChanges: [], fileChangeRoots: [root] })
  })
})

describe('compactCount', () => {
  it('states a count under a thousand exactly', () => {
    expect(compactCount(0)).toBe('0')
    expect(compactCount(39)).toBe('39')
    expect(compactCount(999)).toBe('999')
  })

  it('abbreviates thousands with a Dutch decimal comma', () => {
    expect(compactCount(1300)).toBe('1,3K')
    expect(compactCount(1000)).toBe('1K')
    expect(compactCount(12_400)).toBe('12K')
  })

  it('abbreviates millions the same way', () => {
    expect(compactCount(2_500_000)).toBe('2,5M')
    expect(compactCount(1_000_000)).toBe('1M')
  })
})

describe('Markdown repo links', () => {
  const files = ['Manor/apps/mobile/src/components/FileBrowser.tsx', 'Manor/docs/BRIEFING NOTES.md']

  it('resolves absolute and relative tool paths after removing location metadata', () => {
    expect(resolveMarkdownRepoLink('/Users/sam/Ontwikkeling/Manor/apps/mobile/src/components/FileBrowser.tsx:96:4', files)).toBe(files[0])
    expect(resolveMarkdownRepoLink('./docs/BRIEFING NOTES.md?plain=1#context', files)).toBe(files[1])
  })

  it('reads a percent-encoded name as the name, which is the only form a space arrives in', () => {
    expect(resolveMarkdownRepoLink('./docs/BRIEFING%20NOTES.md?plain=1#context', files)).toBe(files[1])
    expect(resolveMarkdownRepoLink('docs/BRIEFING%20NOTES.md:12:4', files)).toBe(files[1])
  })

  it('leaves a lone percent alone rather than failing on it', () => {
    expect(resolveMarkdownRepoLink('docs/100% done.md', ['Manor/docs/100% done.md'])).toBe('Manor/docs/100% done.md')
  })

  it('leaves external destinations outside the repo resolver', () => {
    expect(resolveMarkdownRepoLink('https://example.com/FileBrowser.tsx:96', files)).toBeUndefined()
    expect(resolveMarkdownRepoLink('mailto:sam@example.invalid', files)).toBeUndefined()
    expect(resolveMarkdownRepoLink('#section', files)).toBeUndefined()
  })

  it('refuses an unresolved or ambiguous local path', () => {
    expect(resolveMarkdownRepoLink('/tmp/missing.ts:12', files)).toBeUndefined()
    expect(resolveMarkdownRepoLink('index.ts', ['A/index.ts', 'B/index.ts'])).toBeUndefined()
  })
})
