import type { FileEdit } from '@manor/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { changedFiles, changedGroups, changedTotals, changedTree } from '../src/changedFiles'
import { ChangedFiles } from '../src/components/ChangedFiles'

const edit = (path: string, before: string | undefined, after: string | undefined, created = false): FileEdit => ({
  path,
  ...(before === undefined ? {} : { before }),
  ...(after === undefined ? {} : { after }),
  ...(created ? { created: true } : {}),
})

const linkedEdit = (relative: string, before: string, after: string): FileEdit => ({
  ...edit(`/Users/t/Manor/${relative}`, before, after),
  panelPath: `Manor/${relative}`,
})

/** One linked folder, listed the way the files panel lists it. */
const listing = [
  'Manor/BRIEFING.md',
  'Manor/apps/web/src/App.tsx',
  'Manor/apps/web/src/components/Composer.tsx',
  'Manor/apps/web/test/composerLayout.test.tsx',
]

describe('a turn’s changed files', () => {
  it('is one row per file, however many times the turn edited it', () => {
    const files = changedFiles(
      [
        linkedEdit('apps/web/src/App.tsx', 'one\n', 'ONE\n'),
        linkedEdit('apps/web/src/App.tsx', 'two\nthree\n', 'TWO\nTHREE\n'),
        linkedEdit('BRIEFING.md', 'a\n', 'a\nb\n'),
      ],
      listing,
    )

    expect(files).toHaveLength(2)
    expect(files[0]).toMatchObject({ path: 'apps/web/src/App.tsx', added: 3, removed: 3, status: 'edited' })
    expect(changedTotals(files)).toEqual({ added: 4, removed: 3 })
    // Every hunk is kept, in order: the row's own diff renders one box per call, and
    // merging them would invent lines nobody wrote.
    expect(files[0]?.edits.map((hunk) => hunk.before)).toEqual(['one\n', 'two\nthree\n'])
  })

  it('uses an absolute path’s exact panel location and drops the folder label', () => {
    const [file] = changedFiles([linkedEdit('apps/web/src/App.tsx', 'x\n', 'y\n')], listing)

    expect(file?.panelPath).toBe('Manor/apps/web/src/App.tsx')
    expect(file?.path).toBe('apps/web/src/App.tsx')
    expect(file?.raw).toBe('/Users/t/Manor/apps/web/src/App.tsx')
  })

  it('is still one row when the same file is reported two ways', () => {
    const files = changedFiles(
      [linkedEdit('apps/web/src/App.tsx', 'a\n', 'b\n'), edit('apps/web/src/App.tsx', 'c\n', 'd\n')],
      listing,
    )

    // The header counts what the tree shows, which shares the resolved path as its key.
    expect(files).toHaveLength(1)
    expect(files[0]).toMatchObject({ path: 'apps/web/src/App.tsx', added: 2, removed: 2 })
    expect(changedTree(files)).toHaveLength(1)
  })

  it('places a path reported relative to the folder it ran in', () => {
    const files = changedFiles([edit('apps/web/src/App.tsx', 'x\n', 'y\n'), edit('BRIEFING.md', 'x\n', 'y\n')], listing)

    expect(files.map((file) => file.panelPath)).toEqual(['Manor/apps/web/src/App.tsx', 'Manor/BRIEFING.md'])
  })

  it('never guesses a file it cannot place', () => {
    // The daily log lives outside every linked folder, and a repo file that happens
    // to share a basename must not answer for it.
    const [log] = changedFiles([edit('/Users/t/notes/memory/daily/BRIEFING.md', 'x\n', 'y\n')], listing)
    expect(log?.panelPath).toBeUndefined()
    expect(log?.path).toBe('/Users/t/notes/memory/daily/BRIEFING.md')

    const [scratch] = changedFiles([edit('/scratch/Manor/apps/web/src/App.tsx', 'x\n', 'y\n')], listing)
    expect(scratch?.panelPath).toBeUndefined()

    // Two folders holding the same relative path: nothing is opened rather than the
    // wrong one, and the label stays on so the two rows read apart.
    const twoFolders = ['Manor/src/App.tsx', 'Sketch/src/App.tsx']
    const [ambiguous] = changedFiles([edit('src/App.tsx', 'x\n', 'y\n')], twoFolders)
    expect(ambiguous?.panelPath).toBeUndefined()

    const [placed] = changedFiles([{
      ...edit('/Users/t/code/Sketch/src/App.tsx', 'x\n', 'y\n'), panelPath: 'Sketch/src/App.tsx',
    }], twoFolders)
    expect(placed?.panelPath).toBe('Sketch/src/App.tsx')
    expect(placed?.path).toBe('Sketch/src/App.tsx')
  })

  it('keeps creation over a later edit, and takes a deletion whenever it lands', () => {
    const made = changedFiles([edit('a.ts', undefined, 'x\n', true), edit('a.ts', 'x\n', 'y\n')])
    expect(made[0]?.status).toBe('created')

    const gone = changedFiles([edit('b.ts', undefined, 'x\n', true), edit('b.ts', 'x\n', undefined)])
    expect(gone[0]?.status).toBe('deleted')
  })

  it('lists Codex metadata-only changes without inventing line counts', () => {
    const files = changedFiles([
      { path: 'new.ts', kind: 'add' },
      { path: 'changed.ts', kind: 'update' },
      { path: 'gone.ts', kind: 'delete' },
    ])

    expect(files.map((file) => ({ path: file.path, status: file.status }))).toEqual([
      { path: 'new.ts', status: 'created' },
      { path: 'changed.ts', status: 'edited' },
      { path: 'gone.ts', status: 'deleted' },
    ])
    expect(changedTotals(files)).toEqual({ added: 0, removed: 0 })
    const html = renderToStaticMarkup(<ChangedFiles files={files} />)
    expect(html).toContain('bg-composer-tray')
    expect(html).toContain('3 changed files')
    expect(html).not.toContain('aria-label="Show the changes')
  })

  it('folds a run of single-child folders into one row and sums what it holds', () => {
    const tree = changedTree(
      changedFiles(
        [
          linkedEdit('apps/web/src/App.tsx', 'a\n', 'b\n'),
          linkedEdit('apps/web/src/components/Composer.tsx', 'a\nb\n', 'c\nd\n'),
          linkedEdit('BRIEFING.md', 'a\n', 'a\nb\n'),
        ],
        listing,
      ),
    )

    // Folders first, then files, and `apps/web` wears both names because `apps` held
    // nothing else.
    expect(tree.map((node) => node.name)).toEqual(['apps/web/src', 'BRIEFING.md'])
    expect(tree[0]).toMatchObject({ added: 3, removed: 3 })
    expect(tree[0]?.children.map((node) => node.name)).toEqual(['components', 'App.tsx'])
    expect(tree[0]?.children[0]?.children[0]?.file?.panelPath).toBe('Manor/apps/web/src/components/Composer.tsx')
  })

  it('counts the closed card’s groups by top folder, with Top level for a bare file', () => {
    const files = changedFiles(
      [
        linkedEdit('apps/web/src/App.tsx', 'a\n', 'b\n'),
        linkedEdit('apps/web/test/composerLayout.test.tsx', 'a\n', 'b\n'),
        linkedEdit('BRIEFING.md', 'a\n', 'b\n'),
      ],
      listing,
    )

    expect(changedGroups(files)).toEqual([
      { name: 'apps', count: 2 },
      { name: 'Top level', count: 1 },
    ])
  })
})

describe('the changed-files card', () => {
  const files = changedFiles(
    [
      linkedEdit('apps/web/src/App.tsx', 'a\n', 'b\n'),
      linkedEdit('apps/web/src/components/Composer.tsx', 'a\n', 'b\n'),
      linkedEdit('apps/web/test/composerLayout.test.tsx', 'a\n', 'b\n'),
      linkedEdit('BRIEFING.md', 'a\n', 'b\n'),
    ],
    listing,
  )

  it('opens closed, claiming the count and offering the names', () => {
    const html = renderToStaticMarkup(<ChangedFiles files={files} onOpenFile={() => {}} />)

    expect(html).toContain('4 changed files')
    expect(html).toContain('Show files')
    expect(html).not.toContain('Hide files')
    expect(html).toContain('+4')
    expect(html).toContain('−4')
    // Three names, alphabetical, and a count for the rest.
    expect(html.indexOf('App.tsx')).toBeLessThan(html.indexOf('BRIEFING.md'))
    expect(html).toContain('Show all 4 files')
    expect(html).not.toContain('composerLayout.test.tsx')
  })

  it('names the top-level group only beside others, and prints no group header for a single one', () => {
    expect(renderToStaticMarkup(<ChangedFiles files={files} onOpenFile={() => {}} />)).toContain('Top level')
    expect(renderToStaticMarkup(<ChangedFiles files={files} onOpenFile={() => {}} />)).not.toContain('root')

    const single = changedFiles([linkedEdit('BRIEFING.md', 'a\n', 'b\n')], listing)
    const html = renderToStaticMarkup(<ChangedFiles files={single} onOpenFile={() => {}} />)
    expect(html).toContain('1 changed file')
    expect(html).not.toContain('Top level')
    expect(html).not.toContain('>1 file<')
  })

  it('makes a placed file a way into the files panel and an unplaced one a plain name', () => {
    const openable = renderToStaticMarkup(<ChangedFiles files={files} onOpenFile={() => {}} />)
    expect(openable).toContain('title="Open /Users/t/Manor/apps/web/src/App.tsx"')

    // No files panel in this chat: the same names, none of them a way in.
    const inert = renderToStaticMarkup(<ChangedFiles files={changedFiles(files.map((file) => edit(file.raw, 'a\n', 'b\n')))} />)
    expect(inert).toContain('App.tsx')
    expect(inert).not.toContain('title="Open')
  })

  it('says nothing at all when the turn changed nothing', () => {
    expect(renderToStaticMarkup(<ChangedFiles files={[]} />)).toBe('')
  })

  it('marks a clipped snapshot diff without changing its measured count', () => {
    const html = renderToStaticMarkup(<ChangedFiles files={[{
      ...files[0]!, added: 42, removed: 7, diffTruncated: true,
    }]} />)
    expect(html).toContain('1 changed file')
    expect(html).toContain('+42')
    expect(html).toContain('−7')
    expect(html).toContain('Partial diff')
  })

  it('never calls a file the turn budget skipped partial or too large', () => {
    const html = renderToStaticMarkup(<ChangedFiles files={[{ ...files[0]!, edits: [], diffSkipped: true }]} />)
    expect(html).not.toContain('artial')
  })
})
