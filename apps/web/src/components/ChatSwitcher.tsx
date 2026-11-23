import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { CheckmarkCircle02Icon, FolderOffIcon, HelpCircleIcon, Loading03Icon } from '@hugeicons/core-free-icons'
import type { AgentConfig } from '@manor/contracts'
import { ProjectMark } from './ProjectMark'
import type { SwitcherItem, SwitcherStanding } from '../useChatSwitcher'
import { Icon } from './Icon'
import { AgentStack } from './inbox/AgentStack'

/**
 * The badge on the tile's face, the sidebar's Waiting / Working / Done words as
 * glyphs: it rides the icon's corner, so it costs the tile no height and the
 * title no width. Only the spinner turns, because a turn is literally in flight;
 * the other two stand still, the strip is up for a second and the colour does
 * the reading.
 */
const STANDING: Record<
  SwitcherStanding,
  { icon: typeof HelpCircleIcon; tone: string; label: string; spin?: boolean }
> = {
  waiting: { icon: HelpCircleIcon, tone: 'text-warn', label: 'Waiting' },
  working: { icon: Loading03Icon, tone: 'text-busy', label: 'Working', spin: true },
  done: { icon: CheckmarkCircle02Icon, tone: 'text-ok', label: 'Done' },
}

interface ChatSwitcherProps {
  items: readonly SwitcherItem[]
  highlightId: string | null
  agents: AgentConfig[]
  onHover: (chatId: string) => void
  onPick: (chatId: string) => void
  onCancel: () => void
}

/**
 * The Cmd+Tab strip, centred over the stage. It is not a dialog: it lives only
 * while Ctrl is held, traps no focus, and dims nothing, so the chat underneath
 * stays fully readable and the release of the key is the commit. A click still
 * chooses directly, the way macOS lets you point at an icon mid-hold.
 *
 * The overlay itself ignores the pointer so a stray click lands on the app, and
 * that landing is what cancels the strip, wired below rather than through a
 * backdrop, because a backdrop would eat the click it should pass on.
 */
export function ChatSwitcher({
  items,
  highlightId,
  agents,
  onHover,
  onPick,
  onCancel,
}: ChatSwitcherProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  // Mounted only while the strip is up, so mounting is the registration.

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const panel = panelRef.current
      if (panel !== null && !panel.contains(event.target as Node)) onCancel()
    }
    window.addEventListener('pointerdown', onPointerDown, { capture: true })
    return () => window.removeEventListener('pointerdown', onPointerDown, { capture: true })
  }, [onCancel])

  return createPortal(
    <div className="pointer-events-none fixed inset-0 z-30 grid place-items-center p-8">
      {/* Keyboard-driven and pressed in bursts, so nothing here moves: the strip is up at
          once and the highlight lands on the tile the key just reached, never behind it. */}
      <div
        ref={panelRef}
        role="dialog"
        aria-label="Switch chat"
        className="pointer-events-auto flex max-w-full items-start gap-1 overflow-x-auto rounded-2xl border border-line surface-floating p-2 shadow-menu"
      >
        {items.map((item) => (
          <button
            key={item.chatId}
            type="button"
            onMouseEnter={() => onHover(item.chatId)}
            onClick={() => onPick(item.chatId)}
            // Always square: a tile with a room line and one without stand at the
            // same measure, so the strip reads as one row of equals.
            className="relative flex h-[104px] w-[104px] flex-none cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-0 bg-transparent px-2 py-1.5 [font:inherit]"
          >
            {item.chatId === highlightId ? (
              <span aria-hidden className="pointer-events-none absolute inset-0 rounded-xl bg-user-bg" />
            ) : null}
            <span className="relative grid h-11 w-11 flex-none place-items-center">
              {item.project === null ? (
                <AgentStack agentIds={[...item.agentIds]} agents={agents} size={34} footprint={44} />
              ) : item.project.noProject === true ? (
                <Icon icon={FolderOffIcon} size={26} className="text-muted" />
              ) : (
                <ProjectMark icon={item.project.icon} color={item.project.color} src={item.project.iconSrc} letters={item.project.letters} size={26} />
              )}
              {item.standing === null ? null : (
                <Icon
                  icon={STANDING[item.standing].icon}
                  size={16}
                  strokeWidth={2}
                  className={`absolute -right-1 -bottom-1 ${STANDING[item.standing].tone} ${STANDING[item.standing].spin ? 'motion-safe:animate-spin-calm' : ''}`}
                />
              )}
            </span>
            <span className="relative w-full truncate text-center text-[13px] font-medium text-text">
              {item.title}
            </span>
            {item.standing === null ? null : (
              <span className="sr-only">{`, ${STANDING[item.standing].label}`}</span>
            )}
            {item.project === null || (item.project.name === '' && item.project.noProject !== true) ? null : (
              <span className="relative -mt-1 w-full truncate text-center text-meta text-dim">
                {item.project.noProject === true ? 'No project' : item.project.name}
              </span>
            )}
          </button>
        ))}
      </div>
    </div>,
    document.body,
  )
}
