import type { MyMindArtifact, MyMindArtifactKind, MyMindSpace, PageContextAttachment } from '@manor/contracts'

/** The id one artifact takes as chat context. Stable, so the same object is never staged twice. */
export const artifactContextId = (artifactId: string): string => `mymind:${artifactId}`.slice(0, 120)

export const kindLabel = (kind: MyMindArtifactKind): string =>
  kind === 'image'
    ? 'Image'
    : kind === 'article'
      ? 'Article'
      : kind === 'note'
        ? 'Note'
        : kind === 'product'
          ? 'Product'
          : 'Artifact'

/** mymind stores markdown; a card and a panel both want the words without the syntax. */
export const plainText = (value: string): string =>
  value
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .trim()

export function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric' }).format(date)
}

/** Saved from x.com or twitter.com, which is a post rather than a page. */
export function isXPost(url: string | undefined): boolean {
  const host = hostname(url)
  return host !== undefined && /(^|\.)(x|twitter)\.com$/.test(host)
}

/**
 * Who wrote it, out of the post's own address. mymind keeps the display name and we
 * do not, so this is the handle: `x.com/Vox/status/…` is Vox. Undefined for the
 * `/i/status/…` shape, which names nobody.
 */
export function xPostHandle(url: string | undefined): string | undefined {
  if (!isXPost(url) || url === undefined) return undefined
  try {
    const [first] = new URL(url).pathname.split('/').filter((part) => part.length > 0)
    return first === undefined || first === 'i' ? undefined : first
  } catch {
    return undefined
  }
}

function hostname(url: string | undefined): string | undefined {
  if (url === undefined) return undefined
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
}

/** What a card shows under its title, and what a panel shows as its body. */
export const artifactBody = (artifact: MyMindArtifact): string | undefined =>
  artifact.note ?? artifact.summary ?? artifact.content

export function artifactContext(artifact: MyMindArtifact, spaces: readonly MyMindSpace[]): PageContextAttachment {
  const spaceNames = spaces.filter((space) => artifact.spaces.includes(space.id)).map((space) => space.name)
  const text = [
    artifact.summary,
    artifact.note,
    artifact.content,
    artifact.tags.length === 0 ? undefined : `Tags: ${artifact.tags.join(', ')}`,
    spaceNames.length === 0 ? undefined : `Spaces: ${spaceNames.join(', ')}`,
  ]
    .filter((part): part is string => part !== undefined && part.trim().length > 0)
    .join('\n\n')
    .slice(0, 6_000)
  return {
    id: artifactContextId(artifact.id),
    kind: 'artifact',
    url: artifact.url ?? 'https://access.mymind.com/',
    title: artifact.title,
    label: `${kindLabel(artifact.kind)} from mymind`,
    text: text || artifact.title,
    html: '',
  }
}
