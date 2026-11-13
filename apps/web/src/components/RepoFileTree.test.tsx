import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { repoTreeEntries, RepoFileTree } from './RepoFileTree'

describe('repository file tree', () => {
  it('mounts the Trees explorer with the repository label', () => {
    const html = renderToStaticMarkup(<RepoFileTree files={['Manor/src/App.tsx']} onSelect={() => {}} />)

    expect(html).toContain('aria-label="Repository files"')
    expect(html).toContain('--trees-font-size-override:14px')
    expect(html).toContain('--trees-padding-inline-override:8px')
    expect(html).toContain('--trees-bg-muted-override:var(--color-tree-hover)')
    expect(html).toContain('--trees-item-height:32px')
  })

  it('hides one implied repository root but keeps distinct roots disambiguated', () => {
    expect(repoTreeEntries(['Manor/src/App.tsx', 'Manor/README.md'])).toEqual([
      { displayPath: 'src/App.tsx', sourcePath: 'Manor/src/App.tsx' },
      { displayPath: 'README.md', sourcePath: 'Manor/README.md' },
    ])
    expect(repoTreeEntries(['web/src/App.tsx', 'server/src/main.ts'])).toEqual([
      { displayPath: 'web/src/App.tsx', sourcePath: 'web/src/App.tsx' },
      { displayPath: 'server/src/main.ts', sourcePath: 'server/src/main.ts' },
    ])
  })
})
