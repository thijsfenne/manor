import { createContext, useContext, useMemo, type ReactNode } from 'react'
import { resolveMarkdownRepoLink } from '@manor/client-runtime/changed-files'

interface RepoFileLinks {
  /** The listing a link is matched against; absent while this chat has none. */
  files?: readonly string[]
  open: (panelPath: string) => void
}

const RepoFileLinkContext = createContext<RepoFileLinks | null>(null)

/**
 * Makes filenames in a reply lead somewhere. A persona writing `[repoFiles.ts](…)`
 * means the file it just edited, and the one place that shows a file is the panel,
 * so the link opens it there instead of asking the browser to navigate to a path
 * that is not a URL.
 *
 * Context rather than a prop, for the same reason {@link ExternalLinkProvider} is
 * one: the anchor is six levels below the state that can open a file, and every
 * Markdown surface wants the same answer.
 */
export function RepoFileLinkProvider({
  files,
  open,
  children,
}: {
  files?: readonly string[]
  open: (panelPath: string) => void
  children: ReactNode
}) {
  // Memoised, or every link in the transcript re-renders on every delta of a
  // streaming reply: a context value is a new object per render, and `memo` on the
  // Markdown above it cannot stop a re-render that comes through the context.
  const value = useMemo(() => ({ files, open }), [files, open])
  return <RepoFileLinkContext.Provider value={value}>{children}</RepoFileLinkContext.Provider>
}

/**
 * How to open what this href names, or null when it names something the panel cannot
 * show: a website, a file no linked folder holds, or a name so common that two files
 * answer to it. Null is the honest answer for all three, and the caller keeps its
 * ordinary link behaviour.
 */
export function useRepoFileLink(href: string | undefined): (() => void) | null {
  const links = useContext(RepoFileLinkContext)
  if (href === undefined || links === null) return null
  const panelPath = resolveMarkdownRepoLink(href, links.files)
  if (panelPath === undefined) return null
  return () => links.open(panelPath)
}
