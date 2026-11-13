import type { AgentConfig } from '@manor/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentBubble } from '../src/components/Bubbles'
import { RepoFileLinkProvider } from '../src/components/RepoFileLink'

const ROSTER: AgentConfig[] = []

const LISTING = ['Manor/apps/server/src/repoFiles.ts', 'Manor/apps/web/src/App.tsx', 'Manor/README.md']

const render = (text: string, files: readonly string[] = LISTING) =>
  renderToStaticMarkup(
    <RepoFileLinkProvider files={files} open={() => {}}>
      <AgentBubble color="#3b82f6" text={text} agents={ROSTER} />
    </RepoFileLinkProvider>,
  )

/**
 * A link is a button exactly when the panel can honour it. The element is the whole
 * assertion: an anchor to `repoFiles.ts` is the bug this replaced — it looked like a
 * link, and clicking it did nothing.
 */
describe('a filename written in a reply', () => {
  it('opens in the files panel when a linked folder holds it', () => {
    expect(render('Doe dit in [`repoFiles.ts`](repoFiles.ts).')).toContain('<button')
  })

  it('is recognised by the path an agent writes, line number and all', () => {
    expect(render('Zie [App.tsx](./apps/web/src/App.tsx:42).')).toContain('<button')
  })

  it('stays an anchor for a website', () => {
    const html = render('Zie [de docs](https://example.com/repoFiles.ts).')
    expect(html).toContain('href="https://example.com/repoFiles.ts"')
    expect(html).not.toContain('<button')
  })

  it('stays an anchor for a file no folder holds', () => {
    expect(render('Zie [notities](memory/daily/2026-08-12.md).')).not.toContain('<button')
  })

  // Two files answering to one name is the case where opening something is worse
  // than opening nothing: the reader would not know which one they got.
  it('stays an anchor when the name is ambiguous', () => {
    const listing = ['Manor/apps/web/src/state.ts', 'Manor/apps/server/src/state.ts']
    expect(render('Zie [state.ts](state.ts).', listing)).not.toContain('<button')
  })

  it('stays an anchor when this chat has no folders to browse', () => {
    expect(
      renderToStaticMarkup(
        <RepoFileLinkProvider open={() => {}}>
          <AgentBubble color="#3b82f6" text="Doe dit in [`repoFiles.ts`](repoFiles.ts)." agents={ROSTER} />
        </RepoFileLinkProvider>,
      ),
    ).not.toContain('<button')
  })
})
