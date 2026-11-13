import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { motion, useReducedMotion } from 'motion/react'
import { CheckmarkCircle02Icon, FolderOffIcon, HelpCircleIcon, Loading03Icon } from '@hugeicons/core-free-icons'
import type { AgentConfig } from '@manor/contracts'
import { EASE_OUT, INSTANT } from '../motion'
import { projectIcon } from '../projectAppearance'
import type { SwitcherItem, SwitcherStanding } from '../useChatSwitcher'
import { Icon } from './Icon'
import { AgentStack } from './inbox/AgentStack'
import { SelectionMarker } from './ui/SelectionMarker'

/**
 * The highlight's own marker group. A layoutId may be mounted once at a time, so
 * the strip never shares one with a sidebar row, the two would otherwise try to
 * wear one fill while the strip floats over a list that has its own selection.
 */
const SWITCHER_MARKER = 'chat-switcher'

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
  const reduceMotion = useReducedMotion() ?? false
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
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-label="Switch chat"
        initial={reduceMotion ? false : { opacity: 0, scale: 0.96 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={reduceMotion ? INSTANT : { duration: 0.12, ease: EASE_OUT }}
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
              <SelectionMarker layoutId={SWITCHER_MARKER} className="rounded-xl" />
            ) : null}
            <span className="relative grid h-11 w-11 flex-none place-items-center">
              {item.project === null ? (
                <AgentStack agentIds={[...item.agentIds]} agents={agents} size={34} footprint={44} />
              ) : (
                <Icon
                  icon={item.project.noProject === true ? FolderOffIcon : projectIcon(item.project.icon)}
                  size={26}
                  {...(item.project.noProject === true ? { className: 'text-muted' } : { style: { color: item.project.color } })}
                />
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
      </motion.div>
    </div>,
    document.body,
  )
}
