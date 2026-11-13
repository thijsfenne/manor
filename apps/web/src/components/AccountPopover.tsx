import { useEffect, useRef, useState } from 'react'
import { Settings02Icon } from '@hugeicons/core-free-icons'
import type { ProviderUsage } from '@manor/contracts'
import { byCardOrder, displayPercent, heatOf, providerPeak } from '@manor/client-runtime/usage'
import type { ThemeChoice as Choice } from '../useTheme'
import { Icon } from './Icon'
import { ProviderMark } from './ProviderMark'
import { ThemeChoice } from './ui/ThemeChoice'
import { Popover } from './ui/Popover'
import { useDismiss } from './ui/useDismiss'

/** The bundled photo, until a profile picture replaces it. */
export const DEFAULT_PROFILE_PHOTO = './images/profile.svg'

const PROVIDER_NAME: Record<ProviderUsage['provider'], string> = {
  claude: 'Claude',
  codex: 'Codex',
  grok: 'Grok',
  cursor: 'Cursor',
}

/** What is left of each plan, at its fullest window, the same reading the rail's rings draw. */
export function usageLeft(perProvider: readonly ProviderUsage[]) {
  return [...perProvider].sort(byCardOrder).flatMap((usage) => {
    const peak = providerPeak(usage)
    if (peak === undefined) return []
    const left = Math.max(0, 100 - displayPercent(peak.usedPercent))
    return [{ provider: usage.provider, left, heat: heatOf(peak) }]
  })
}

interface AccountPopoverProps {
  name: string
  photo: string
  providerUsage: readonly ProviderUsage[]
  theme: Choice
  /** Inside the phone drawer, where the face needs a touch-sized target. */
  size: number
  onTheme: (choice: Choice) => void
  onOpenUsage: () => void
  onOpenSettings: () => void
}

/**
 * The face at the rail's foot and the small sheet behind it: who is signed in, how
 * much of each plan is left, the theme, and the way into Settings. There is no Log
 * out or Profile row; Manor has one local user and Profile lives in Settings › General.
 */
export function AccountPopover({ name, photo, providerUsage, theme, size, onTheme, onOpenUsage, onOpenSettings }: AccountPopoverProps) {
  const [open, setOpen] = useState(false)
  const wrapper = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const sheet = useRef<HTMLDivElement>(null)
  const close = (refocus: boolean) => {
    setOpen(false)
    if (refocus) trigger.current?.focus({ preventScroll: true })
  }
  useDismiss(open, () => close(false), { within: [wrapper], onEscape: () => close(true), windowBlur: true })

  useEffect(() => {
    if (open) sheet.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })
  }, [open])

  const left = usageLeft(providerUsage)
  const usageReading = left.map((entry) => `${PROVIDER_NAME[entry.provider]} ${String(entry.left)}% left`).join(', ')
  const go = (act: () => void) => {
    setOpen(false)
    act()
  }
  const row =
    'flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg border-0 bg-transparent px-2.5 text-left text-[14px] text-text outline-none hover:bg-surface-2 focus-visible:bg-surface-2'

  return (
    <div ref={wrapper} className="relative">
      <button
        ref={trigger}
        type="button"
        data-settings-return
        className={`grid cursor-pointer place-items-center rounded-xl border-0 outline-none focus-visible:outline-2 focus-visible:outline-primary ${
          open ? 'bg-surface-2' : 'bg-transparent hover:bg-surface-2'
        }`}
        style={{ width: size, height: size }}
        title={name}
        aria-label={`${name}, account`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((shown) => !shown)}
      >
        <img className="h-7 w-7 rounded-full object-cover" src={photo} alt="" aria-hidden="true" />
      </button>
      <Popover
        ref={sheet}
        open={open}
        origin="bottom-left"
        role="dialog"
        aria-label="Account"
        // Clear of the rail's edge, the way the provider-updates sheet sits.
        className="absolute bottom-0 left-[calc(100%+12px)] z-20 w-[320px] rounded-xl border border-line surface-floating p-1.5 shadow-menu"
      >
        <div className="flex items-center gap-2.5 px-2.5 pt-1.5 pb-2.5">
          <img className="h-8 w-8 flex-none rounded-full object-cover" src={photo} alt="" aria-hidden="true" />
          <span className="min-w-0 truncate text-[14px] font-medium text-text">{name}</span>
        </div>
        <div className="mx-1 mb-1 h-px bg-line" aria-hidden="true" />

        {/* Label and readings in one row, sized for four plans at 100%. The label says
            what the number is, and no chevron, as Settings below has none either. */}
        <button
          type="button"
          className={row}
          aria-label={left.length === 0 ? 'Usage' : `Usage, ${usageReading}`}
          onClick={() => go(onOpenUsage)}
        >
          <span className="flex-1">Usage</span>
          {left.length === 0 ? (
            <span className="text-label text-dim">No reading yet</span>
          ) : (
            <span className="flex items-center gap-2" aria-hidden="true">
              {left.map((entry) => (
                <span key={entry.provider} className="flex items-center gap-1 text-label tabular-nums">
                  <ProviderMark driver={entry.provider} size={12} />
                  <span className={entry.heat === 'critical' ? 'text-danger' : entry.heat === 'warn' ? 'text-warn' : 'text-muted'}>
                    {entry.left}%
                  </span>
                </span>
              ))}
            </span>
          )}
        </button>

        <div className="flex h-9 items-center gap-2.5 pr-1 pl-2.5">
          <span className="flex-1 text-[14px] text-text">Theme</span>
          <ThemeChoice choice={theme} show="icons" onChange={onTheme} />
        </div>

        <div className="mx-1 my-1 h-px bg-line" aria-hidden="true" />
        <button type="button" className={row} onClick={() => go(onOpenSettings)}>
          <Icon icon={Settings02Icon} size={16} className="flex-none text-muted" />
          <span className="flex-1">Settings</span>
          <kbd className="font-sans text-label text-dim">⌘,</kbd>
        </button>
      </Popover>
    </div>
  )
}
