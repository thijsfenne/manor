import { ArrowDown01Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import type { RepoFileApp } from '@manor/contracts'
import { useEffect, useRef, useState } from 'react'
import { AppMark } from './AppMarks'
import { Icon } from './Icon'
import { Popover } from './ui/Popover'
import { useDismiss } from './ui/useDismiss'

export const APP_LABELS: Record<RepoFileApp, string> = {
  cursor: 'Cursor',
  vscode: 'VS Code',
  windsurf: 'Windsurf',
  terminal: 'Terminal',
  iterm: 'iTerm',
  xcode: 'Xcode',
  finder: 'Finder',
}

interface RepoFileOpenMenuProps {
  apps: readonly RepoFileApp[]
  compact?: boolean
  onOpen: (app: RepoFileApp) => void
}

/** One quick open plus the host's other installed targets, in its advertised order. */
export function RepoFileOpenMenu({ apps, compact = false, onOpen }: RepoFileOpenMenuProps) {
  const root = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [preferred, setPreferred] = useState<RepoFileApp | null>(() => apps[0] ?? null)
  useDismiss(open, () => setOpen(false), { within: [root], escape: true, layoutMoved: true })

  useEffect(() => {
    if (preferred !== null && apps.includes(preferred)) return
    setPreferred(apps[0] ?? null)
    setOpen(false)
  }, [apps, preferred])

  const active = preferred !== null && apps.includes(preferred) ? preferred : (apps[0] ?? null)
  if (active === null) return null

  const select = (app: RepoFileApp) => {
    setPreferred(app)
    setOpen(false)
    if (compact) onOpen(app)
  }

  return (
    <div ref={root} className="relative flex-none">
      {compact ? (
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label="Open file in application"
          title={`Open file in ${APP_LABELS[active]}`}
          onClick={() => setOpen((current) => !current)}
          className="grid h-8 w-8 cursor-pointer place-items-center rounded-button-sm border-0 bg-[color-mix(in_srgb,var(--color-text)_8%,transparent)] text-muted [font:inherit] hover:bg-[color-mix(in_srgb,var(--color-text)_13%,transparent)] hover:text-text"
        >
          <AppMark app={active} />
        </button>
      ) : (
        <div className="flex h-8 items-stretch overflow-hidden rounded-button-sm bg-[color-mix(in_srgb,var(--color-text)_8%,transparent)] text-muted">
          <button
            type="button"
            aria-label={`Open in ${APP_LABELS[active]}`}
            title={`Open in ${APP_LABELS[active]}`}
            onClick={() => onOpen(active)}
            className="flex cursor-pointer items-center gap-1.5 border-0 bg-transparent pr-2 pl-2.5 text-[14px] font-medium text-inherit hover:bg-[color-mix(in_srgb,var(--color-text)_5%,transparent)] hover:text-text"
          >
            <AppMark app={active} />
            Open
          </button>
          <span aria-hidden="true" className="my-1.5 w-px flex-none bg-current opacity-20" />
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label="Choose application"
            title="Choose application"
            onClick={() => setOpen((current) => !current)}
            className="flex cursor-pointer items-center border-0 bg-transparent px-2 text-inherit [font:inherit] hover:bg-[color-mix(in_srgb,var(--color-text)_5%,transparent)] hover:text-text"
          >
            <Icon icon={ArrowDown01Icon} size={12} />
          </button>
        </div>
      )}

      <Popover
        open={open}
        origin="top-right"
        className="absolute top-[calc(100%+6px)] right-0 z-[9] w-[196px] rounded-xl border border-line surface-floating p-1.5 shadow-menu"
        role="menu"
        aria-label="Open file in"
      >
        {apps.map((app) => (
          <button
            key={app}
            type="button"
            role="menuitemradio"
            aria-checked={app === active}
            onClick={() => select(app)}
            className="flex w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 py-1.5 text-left text-label text-text hover:bg-user-bg"
          >
            <AppMark app={app} />
            <span className="min-w-0 flex-1 truncate">{APP_LABELS[app]}</span>
            {app === active ? <Icon icon={Tick02Icon} size={13} className="flex-none" /> : null}
          </button>
        ))}
      </Popover>
    </div>
  )
}
