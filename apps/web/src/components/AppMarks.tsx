import { FolderGitIcon } from '@hugeicons/core-free-icons'
import type { RepoFileApp } from '@manor/contracts'
import { useId, type ReactNode } from 'react'
import { Icon } from './Icon'
import { CursorMark } from './ProviderMark'

/**
 * Brand marks for the apps a folder or file opens in, and for the host a branch pushes
 * to. These are logos, not UI glyphs, so they keep the brand's own colours the way any
 * macOS "Open in" menu does; that is why this file is on the check-colors exempt list.
 * VS Code, GitHub, GitLab and Windsurf use the official paths. Apple publishes no vector
 * Xcode, Terminal or Finder icon, so those are drawn after the macOS app icons, and iTerm
 * after its own. Monochrome brands (GitHub, Cursor, Windsurf) take the text colour, which
 * is their black on light and white on dark.
 */
export function AppMark({ app, size = 16 }: { app: RepoFileApp; size?: number }) {
  if (app === 'cursor') return <span className="flex flex-none text-text"><CursorMark size={size} /></span>
  if (app === 'vscode') return <VsCodeMark size={size} />
  if (app === 'windsurf') return <WindsurfMark size={size} />
  if (app === 'terminal') return <TerminalMark size={size} />
  if (app === 'iterm') return <ItermMark size={size} />
  if (app === 'xcode') return <XcodeMark size={size} />
  return <FinderMark size={size} />
}

/** The remote's host by its logo; an unknown host falls back to the plain git folder glyph. */
export function RepoHostMark({ host, size = 16 }: { host: string; size?: number }) {
  if (host === 'github.com') return <GithubMark size={size} />
  if (host.startsWith('gitlab.')) return <GitlabMark size={size} />
  return <Icon icon={FolderGitIcon} size={14} className="flex-none text-dim" />
}

/** Gradient ids per instance, without React 18's colons that `url(#…)` would trip on. */
function useGradientId() {
  return useId().replace(/:/g, '')
}

function Mark({ size, viewBox = '0 0 24 24', children }: { size: number; viewBox?: string; children: ReactNode }) {
  return (
    <svg aria-hidden="true" className="block flex-none" width={size} height={size} viewBox={viewBox} fill="none">
      {children}
    </svg>
  )
}

/** The macOS icon tile, a 22-unit rounded square in the 24 box. */
const TILE = 'M6 1h12a5 5 0 0 1 5 5v12a5 5 0 0 1-5 5H6a5 5 0 0 1-5-5V6a5 5 0 0 1 5-5Z'

function VsCodeMark({ size }: { size: number }) {
  const id = useGradientId()
  return (
    <Mark size={size} viewBox="0 0 100 100">
      <mask id={`${id}m`} width="100" height="100" x="0" y="0" maskUnits="userSpaceOnUse">
        <path fill="#fff" fillRule="evenodd" clipRule="evenodd" d="M70.91 99.32a6.22 6.22 0 0 0 4.96-.19l20.59-9.91A6.25 6.25 0 0 0 100 83.59V16.41a6.25 6.25 0 0 0-3.54-5.63L75.87.874a6.23 6.23 0 0 0-7.1 1.21L29.36 38.04 12.19 25.01a4.16 4.16 0 0 0-5.32.236l-5.51 5.01a4.17 4.17 0 0 0-.004 6.16L16.25 50 1.36 63.58a4.17 4.17 0 0 0 .004 6.16l5.51 5.01a4.16 4.16 0 0 0 5.32.236l17.17-13.03L68.77 97.92a6.22 6.22 0 0 0 2.14 1.4ZM75.02 27.3 45.11 50l29.91 22.7V27.3Z" />
      </mask>
      <g mask={`url(#${id}m)`}>
        <path fill="#0065A9" d="M96.46 10.8 75.86.876a6.23 6.23 0 0 0-7.11 1.21l-67.45 61.5a4.17 4.17 0 0 0 .004 6.16l5.51 5.01a4.17 4.17 0 0 0 5.32.24l81.23-61.62c2.73-2.07 6.64-.124 6.64 3.3v-.24a6.25 6.25 0 0 0-3.54-5.63Z" />
        <path fill="#007ACC" d="m96.46 89.2-20.6 9.92a6.23 6.23 0 0 1-7.11-1.21l-67.45-61.5a4.17 4.17 0 0 1 .004-6.16l5.51-5.01a4.17 4.17 0 0 1 5.32-.236l81.23 61.62c2.73 2.07 6.64.124 6.64-3.3v.24a6.25 6.25 0 0 1-3.54 5.63Z" />
        <path fill="#1F9CF0" d="M75.86 99.13a6.23 6.23 0 0 1-7.11-1.21c2.31 2.31 6.25.67 6.25-2.59V4.67c0-3.26-3.94-4.89-6.25-2.59a6.23 6.23 0 0 1 7.11-1.21l20.6 9.91A6.25 6.25 0 0 1 100 16.41v67.17a6.25 6.25 0 0 1-3.54 5.63l-20.6 9.91Z" />
      </g>
    </Mark>
  )
}

function XcodeMark({ size }: { size: number }) {
  const id = useGradientId()
  return (
    <Mark size={size}>
      <defs>
        <linearGradient id={`${id}t`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3AB0FF" />
          <stop offset="1" stopColor="#1468F2" />
        </linearGradient>
        <linearGradient id={`${id}h`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6E6E73" />
          <stop offset="1" stopColor="#2C2C2E" />
        </linearGradient>
      </defs>
      <path d={TILE} fill={`url(#${id}t)`} />
      <path d="M8 1.5V22.5M16 1.5V22.5M1.5 8H22.5M1.5 16H22.5" stroke="#fff" strokeOpacity=".16" strokeWidth=".4" />
      <path d="M4.2 19.8 11.3 12.7" stroke="#1C1C1E" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M11 13 16.4 7.6" stroke="#48484A" strokeWidth="1.7" strokeLinecap="round" />
      <path d="M12.3 4.1c1.7-.9 3.9-.6 5.4.5l1.5 1.2.6-.4 1.6 1.6-.4.6.4.5-2.2 2.2-.5-.4-.6.4-1.7-1.5c-.7-.6-1.6-.8-2.4-.6l-.4-.4c.6-.5.6-1.5.1-2.1-.5-.6-1.2-.9-1.8-1.1Z" fill={`url(#${id}h)`} />
    </Mark>
  )
}

function TerminalMark({ size }: { size: number }) {
  const id = useGradientId()
  return (
    <Mark size={size}>
      <defs>
        <linearGradient id={`${id}t`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3A3A3C" />
          <stop offset="1" stopColor="#161618" />
        </linearGradient>
      </defs>
      <path d={TILE} fill={`url(#${id}t)`} />
      {/* The rim keeps the dark tile's edge visible on a dark panel. */}
      <path d="M6 1.5h12A4.5 4.5 0 0 1 22.5 6v12a4.5 4.5 0 0 1-4.5 4.5H6A4.5 4.5 0 0 1 1.5 18V6A4.5 4.5 0 0 1 6 1.5Z" stroke="#fff" strokeOpacity=".14" />
      <path d="m6 7.2 4.4 2.6L6 12.4" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11.4 14.6h4.6" stroke="#C7C7CC" strokeWidth="1.7" strokeLinecap="round" />
    </Mark>
  )
}

function ItermMark({ size }: { size: number }) {
  const id = useGradientId()
  return (
    <Mark size={size}>
      <defs>
        <linearGradient id={`${id}t`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#E5E7EA" />
          <stop offset="1" stopColor="#8E9399" />
        </linearGradient>
      </defs>
      <path d={TILE} fill={`url(#${id}t)`} />
      <rect x="2.8" y="2.8" width="18.4" height="18.4" rx="3.4" fill="#0B0F14" />
      <path d="M9.2 7.1c-.4-.5-1.1-.8-1.8-.8-.9 0-1.6.5-1.6 1.2 0 1.6 3.5 1 3.5 2.7 0 .8-.7 1.3-1.8 1.3-.8 0-1.5-.3-2-.8M7.4 5.4v7.6" stroke="#3CE65C" strokeWidth="1.1" strokeLinecap="round" />
      <path d="M11.4 12.4h3.6" stroke="#3CE65C" strokeWidth="1.3" strokeLinecap="round" />
    </Mark>
  )
}

function FinderMark({ size }: { size: number }) {
  const id = useGradientId()
  return (
    <Mark size={size}>
      <defs>
        <linearGradient id={`${id}t`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#4ACBFF" />
          <stop offset="1" stopColor="#168DEE" />
        </linearGradient>
        <linearGradient id={`${id}f`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#F4FAFF" />
          <stop offset="1" stopColor="#D6EBFC" />
        </linearGradient>
      </defs>
      <path d={TILE} fill={`url(#${id}t)`} />
      <path d="M13.6 2.6h5.2a2.6 2.6 0 0 1 2.6 2.6v13.6a2.6 2.6 0 0 1-2.6 2.6h-6.3c-.3-2.2-.3-4.8-.2-7.1-.9-.1-1.6-.4-1.6-.9.3-1.3 1-2.6 1.4-4.2.4-2.1.8-4.4 1.5-6.6Z" fill={`url(#${id}f)`} />
      <path d="M7.4 7.8v2M16.4 7.8v2" stroke="#1D1D1F" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M5.4 13.6c3.6 3.4 9.4 3.4 13 .2" stroke="#1D1D1F" strokeWidth="1.2" strokeLinecap="round" />
    </Mark>
  )
}

function WindsurfMark({ size }: { size: number }) {
  return (
    <Mark size={size}>
      <path fill="var(--color-text)" d="M23.55 5.067c-1.2038-.002-2.1806.973-2.1806 2.1765v4.8676c0 .972-.8035 1.7594-1.7597 1.7594-.568 0-1.1352-.286-1.4718-.7659l-4.9713-7.1003c-.4125-.5896-1.0837-.941-1.8103-.941-1.1334 0-2.1533.9635-2.1533 2.153v4.8957c0 .972-.7969 1.7594-1.7596 1.7594-.57 0-1.1363-.286-1.4728-.7658L.4076 5.1598C.2822 4.9798 0 5.0688 0 5.2882v4.2452c0 .2147.0656.4228.1884.599l5.4748 7.8183c.3234.462.8006.8052 1.3509.9298 1.3771.313 2.6446-.747 2.6446-2.0977v-4.893c0-.972.7875-1.7593 1.7596-1.7593h.003a1.798 1.798 0 0 1 1.4718.7658l4.9723 7.0994c.4135.5905 1.05.941 1.8093.941 1.1587 0 2.1515-.9645 2.1515-2.153v-4.8948c0-.972.7875-1.7594 1.7596-1.7594h.194a.22.22 0 0 0 .2204-.2202v-4.622a.22.22 0 0 0-.2203-.2203Z" />
    </Mark>
  )
}

function GithubMark({ size }: { size: number }) {
  return (
    <Mark size={size}>
      <path fill="var(--color-text)" d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </Mark>
  )
}

function GitlabMark({ size }: { size: number }) {
  return (
    <Mark size={size}>
      <path fill="#FC6D26" d="m23.6004 9.5927-.0337-.0862L20.3.9814a.851.851 0 0 0-.3362-.405.8748.8748 0 0 0-.9997.0539.8748.8748 0 0 0-.29.4399l-2.2055 6.748H7.5375l-2.2057-6.748a.8573.8573 0 0 0-.29-.4412.8748.8748 0 0 0-.9997-.0537.8585.8585 0 0 0-.3362.4049L.4332 9.5015l-.0325.0862a6.0657 6.0657 0 0 0 2.0119 7.0105l.0113.0087.03.0213 4.976 3.7264 2.462 1.8633 1.4995 1.1321a1.0085 1.0085 0 0 0 1.2197 0l1.4995-1.1321 2.4619-1.8633 5.006-3.7489.0125-.01a6.0682 6.0682 0 0 0 2.0094-7.003z" />
    </Mark>
  )
}
