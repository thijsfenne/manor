import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { ArrowDown01Icon, Folder01Icon, FolderGitIcon, GitBranchIcon } from '@hugeicons/core-free-icons'
import type { CheckoutBranch, CheckoutRequest, ServerMessage } from '@manor/contracts'
import { INSTANT, SPRING_CHEVRON } from '../motion'
import { Icon } from './Icon'
import { MenuRow } from './RuntimeMenu'
import { formInputClass } from './ui/FormField'
import { MENU_SURFACE } from './ui/Menu'
import { Popover } from './ui/Popover'
import { useDismiss } from './ui/useDismiss'

/** The server's last word on where one chat writes: dirt, git roots, and any leftover. */
export type CheckoutStatus = Extract<ServerMessage, { type: 'checkout_status' }>

/** Mode and branch as the directory carries them, or as the new-chat draft intends them. */
export interface CheckoutBase {
  mode: 'current' | 'worktree'
  branch: string | null
}

export interface CheckoutView {
  mode: 'current' | 'worktree'
  /** The chip. New chat says what picking it will do. A live isolated chat says
   *  what it already is, and that name is not a second mode you can switch to. */
  label: string
  /** What picking the worktree option would do, so a leftover branch is never a surprise. */
  worktreeOption: string
  /** The branch on the right, or null when there is nothing true to say about one yet. */
  branch: string | null
  /**
   * The new-chat stage can still choose current vs worktree. A live chat cannot:
   * the checkout is chosen once, and switching maps mid-session is how you lose
   * the files this chat already wrote.
   */
  modeEditable: boolean
  /**
   * A picker where a pick would not move this chat onto a different map. New chat
   * always, because that is where isolation is chosen. Live worktree too, because
   * `git switch` there stays in the same directory. Live current checkout is a
   * label: picking a name there would isolate, and a live chat does not.
   */
  branchEditable: boolean
  /**
   * The branches the menu may offer, or null where a name is typed instead. A live
   * worktree can only be switched onto a branch that already exists, so there the list
   * is the whole truth. The new-chat stage can name anything, so worktree-intent
   * gets the field. Current checkout uses the list only while the chat is still a
   * draft, because a pick there isolates.
   * Null also covers a server that sends no list, which must not leave an empty menu.
   */
  branchRows: CheckoutBranch[] | null
}

/**
 * One reading of where a chat writes, from the two sources that describe it. The
 * directory (or the draft) carries mode and branch and arrives with every chat; the
 * `checkout_status` reply adds the dirt and the leftover, and is asked for rather than
 * pushed. A status from before a mode change is dropped whole rather than merged, so
 * the row cannot pair the new mode with the old branch for a frame.
 */
export function checkoutView(base: CheckoutBase, status: CheckoutStatus | null, planned: boolean): CheckoutView {
  const fresh = status !== null && status.mode === base.mode ? status : null
  // A live status with `branch: null` is a fact (conflict or unreadable HEAD), not a
  // hole to fill from the stored mapping, which would lie.
  const branch = fresh !== null ? fresh.branch : base.branch
  const resume = base.mode === 'current' ? (fresh?.leftover?.branch ?? null) : null
  const rows = fresh?.branches ?? []
  return {
    mode: base.mode,
    label: planned
      ? base.mode === 'current'
        ? 'Current checkout'
        : 'New worktree'
      : base.mode === 'current'
        ? 'Local checkout'
        : (branch ?? 'No shared branch'),
    worktreeOption: resume === null ? 'New worktree' : `New worktree · ${resume}`,
    branch,
    modeEditable: planned,
    branchEditable: planned || base.mode === 'worktree',
    branchRows: rows.length > 0 && !(planned && base.mode === 'worktree') ? rows : null,
  }
}

/**
 * What picking a name in the branch list does. A branch is not a worktree: the list
 * names destinations, and isolation is how Manor reaches one the linked folders are
 * not on. A live chat does not change maps, so `home` and a pick that would isolate
 * stay blocked there. The new-chat stage still uses `home` as return to current
 * checkout when the draft is on a worktree. Occupied in someone else's copy stays
 * blocked either way.
 */
export function pickBranch(
  row: CheckoutBranch,
  current: { mode: 'current' | 'worktree'; branch: string | null },
  locked = false,
): CheckoutRequest | 'stay' | 'blocked' {
  if (row.name === current.branch) return 'stay'
  if (locked && (row.home === true || current.mode === 'current')) return 'blocked'
  if (row.home === true) return { mode: 'current' }
  if (row.available) return { mode: 'worktree', branch: row.name }
  return 'blocked'
}

interface CheckoutRowProps {
  base: CheckoutBase
  /** The live answer for this chat. Null on the new-chat stage, and until the first reply. */
  status: CheckoutStatus | null
  /** Nothing is on disk yet, so the row reads as intent rather than as state. */
  planned: boolean
  disabled: boolean
  /** What leads the tray, ahead of the checkout: the new-Session stage puts its project chip here, and the three then sit together on the left. */
  lead?: ReactNode
  /** The tray keeps only `lead`: no project, so nothing to check out. Same element either way, so the chip in it stays mounted and focused. */
  leadOnly?: boolean
  /** Re-read dirt and leftover when the menu opens. Cheaper than a poll, fresher than a cache. */
  onAsk?: () => void
  onChoose: (next: CheckoutRequest) => void
}

/**
 * Where this chat writes, under the composer. One sentence rather than two pickers:
 * the mode on the left, the branch it lands on at the right end, and a menu only
 * once you press. The new-chat stage is where the map is chosen. A live chat does
 * not switch worktrees: isolation reads as the branch name, current as
 * "Local checkout". A live worktree can still `git switch` inside that directory.
 */
export function CheckoutRow({ base, status, planned, disabled, lead, leadOnly = false, onAsk, onChoose }: CheckoutRowProps) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState<'mode' | 'branch' | null>(null)
  const [draft, setDraft] = useState('')
  useDismiss(open !== null, () => setOpen(null), { within: [rootRef], escape: true })

  const view = checkoutView(base, status, planned)
  // A list of branches is a menu; a name being typed is not. The trigger says the same
  // word as the thing it opens, or a screen reader is told about a menu with no items.
  const branchPopup = view.branchRows === null ? 'dialog' : 'menu'
  // A live chat does not switch worktrees. The checkout chip is a label, not a
  // menu: no arrow, no hover.
  const modeMenu = view.modeEditable

  const choose = (next: CheckoutRequest) => {
    setOpen(null)
    onChoose(next)
  }

  const openMode = () => {
    if (!modeMenu) return
    if (open === 'mode') {
      setOpen(null)
      return
    }
    onAsk?.()
    setOpen('mode')
  }

  const openBranch = () => {
    if (open === 'branch') {
      setOpen(null)
      return
    }
    // Availability goes stale the moment another chat isolates onto a branch, so both
    // chips re-read on the way open rather than trusting whatever was asked for last.
    onAsk?.()
    setDraft(view.branch ?? '')
    setOpen('branch')
  }

  const submitBranch = (event: FormEvent) => {
    event.preventDefault()
    const name = draft.trim()
    choose(name === '' ? { mode: 'worktree' } : { mode: 'worktree', branch: name })
  }

  // The lead (the project chip) sits in the same tray but outside `rootRef`, so a press
  // on it dismisses an open checkout menu, and focus entering it does the same for the
  // keyboard.
  const leadSlot = lead === undefined ? null : (
    <div className="contents" onFocusCapture={() => setOpen(null)}>
      {lead}
    </div>
  )
  useEffect(() => {
    if (leadOnly) setOpen(null)
  }, [leadOnly])

  if (leadOnly) {
    return (
      <div className={`${barClass} gap-2`} role="group" aria-label="Where this chat writes">
        {leadSlot}
      </div>
    )
  }

  return (
    <div
      className={`${barClass} ${lead === undefined ? 'justify-between' : 'justify-start'} gap-2`}
      role="group"
      aria-label="Where this chat writes"
    >
      {leadSlot}
      <div ref={rootRef} className="contents">
        <div className="relative min-w-0">
          {modeMenu ? (
            <button
              type="button"
              className={chipClass(open === 'mode')}
              disabled={disabled}
              aria-haspopup="menu"
              aria-expanded={open === 'mode'}
              title="Where this chat writes: the linked folders, or a worktree of its own"
              onClick={openMode}
            >
              <Icon icon={view.mode === 'current' ? Folder01Icon : FolderGitIcon} size={13} />
              <span className="truncate">{view.label}</span>
              <ChipArrow open={open === 'mode'} />
            </button>
          ) : (
            <span
              className={chipLabelClass}
              title={
                view.mode === 'current'
                  ? 'This chat writes in the linked folders'
                  : 'This chat writes in its own worktree'
              }
            >
              <Icon icon={view.mode === 'current' ? Folder01Icon : FolderGitIcon} size={13} />
              <span className="truncate">{view.label}</span>
            </span>
          )}

          <Popover
            open={open === 'mode' && modeMenu}
            className={`absolute bottom-[calc(100%+8px)] left-0 z-[6] w-[264px] ${MENU_SURFACE}`}
            role="menu"
          >
            <MenuRow
              label="Current checkout"
              selected={view.mode === 'current'}
              isDefault
              onSelect={() => choose({ mode: 'current' })}
            />
            <MenuRow
              label={view.worktreeOption}
              selected={view.mode === 'worktree'}
              isDefault={false}
              onSelect={() => choose({ mode: 'worktree' })}
            />
          </Popover>
        </div>

        {view.branch === null && view.branchRows === null && !view.branchEditable ? null : view.branchEditable ? (
          <div className="relative min-w-0">
            <button
              type="button"
              className={chipClass(open === 'branch')}
              disabled={disabled}
              aria-haspopup={branchPopup}
              aria-expanded={open === 'branch'}
              title={
                view.mode === 'current'
                  ? 'Pick a branch to isolate this chat. The linked folders stay where they are.'
                  : 'The branch this worktree is on'
              }
              onClick={openBranch}
            >
              <Icon icon={GitBranchIcon} size={13} />
              <span className="max-w-[220px] truncate">
                {view.branch ??
                  (view.mode === 'worktree' && !planned
                    ? 'No shared branch'
                    : view.mode === 'current'
                      ? 'Branch'
                      : 'New branch')}
              </span>
              <ChipArrow open={open === 'branch'} />
            </button>

            <Popover
              open={open === 'branch'}
              origin="bottom-right"
              className={`absolute right-0 bottom-[calc(100%+8px)] z-[6] w-[288px] ${MENU_SURFACE}`}
              role={branchPopup}
              aria-label="Branch"
            >
              {view.branchRows === null ? (
                <>
                  <form onSubmit={submitBranch}>
                    <input
                      className={formInputClass}
                      value={draft}
                      autoFocus
                      spellCheck={false}
                      autoCapitalize="off"
                      autoCorrect="off"
                      placeholder="Branch name"
                      aria-label="Branch name"
                      onChange={(event) => setDraft(event.target.value)}
                    />
                  </form>
                  {/* Only where the field would otherwise mislead about what a name
                      does. What picking a branch means is the chip's own tooltip; a
                      paragraph under every menu is a warning nobody reads twice. */}
                  {view.mode === 'current' ? null : (
                    <p className={hintClass}>
                      {planned
                        ? 'Enter to use it. Left empty, Manor names the branch after this chat.'
                        : 'Enter switches this worktree onto a branch that already exists. To start a new one, discard this worktree first.'}
                    </p>
                  )}
                </>
              ) : (
                <>
                  {/* Scrolls rather than filters: every isolated chat leaves its branch
                      behind, so this list grows with use, and a filter is the next thing
                      it needs rather than the first. */}
                  <div className="max-h-[240px] overflow-y-auto">
                    {view.branchRows.map((row) => {
                      const next = pickBranch(row, view, !view.modeEditable)
                      return (
                        <MenuRow
                          key={row.name}
                          label={row.name}
                          selected={row.name === view.branch}
                          isDefault={false}
                          {...(next === 'blocked'
                            ? { unavailable: row.reason ?? 'git will not check it out here' }
                            : {})}
                          onSelect={() => {
                            if (next === 'blocked') return
                            if (next === 'stay') {
                              setOpen(null)
                              return
                            }
                            choose(next)
                          }}
                        />
                      )
                    })}
                  </div>
                </>
              )}
            </Popover>
          </div>
        ) : (
          // A label, never a disabled button: the shared checkout's branch is something
          // Manor reads off disk, so a control here would promise a move it cannot make.
          <span
            className={chipLabelClass}
            title="This chat writes in the linked folders, on the branch they are on"
          >
            <Icon icon={GitBranchIcon} size={13} />
            <span className="max-w-[220px] truncate">{view.branch}</span>
          </span>
        )}
      </div>
    </div>
  )
}

/** The chevron of a chip, turned over while the thing it opened is on screen. */
function ChipArrow({ open }: { open: boolean }) {
  const reduce = useReducedMotion()
  return (
    <motion.span
      className="flex-none"
      animate={{ rotate: open ? 180 : 0 }}
      transition={reduce ? INSTANT : SPRING_CHEVRON}
    >
      <Icon icon={ArrowDown01Icon} size={12} />
    </motion.span>
  )
}

/** The line under a menu that says what it costs or what it cannot do. */
const hintClass = 'mx-0 mt-1.5 mb-0 border-t border-line px-2 pt-1.5 pb-0.5 text-label leading-snug text-dim'

/**
 * A tray tucked behind the composer card, not a bar floating under it: inset on both
 * sides, its top third hidden by the card (`-mt-3` against the card's `z-[1]`), and
 * only its bottom corners drawn. One object saying where this chat writes, hanging off
 * the thing it writes with. No hairline: `bg-composer-tray` is the seam against the
 * card's `bg-composer`, because depth here is luminance and an outline would make the
 * tray a second card. Padding and corner are the user's
 * own numbers off the live row (2026-08-19): the top carries the hidden third, and the
 * 24px corner is read against the card's 27.5px rather than derived from it, so it is
 * the one radius in the app that will not follow `--radius-scale`.
 */
const barClass = 'mx-5 -mt-3 flex min-w-0 items-center rounded-b-[24px] bg-composer-tray px-2 pt-3.5 pb-1'

/**
 * Both chips, so the two halves of one sentence cannot drift apart in weight. An open
 * chip holds the hover fill instead of dropping it the moment the pointer leaves for
 * the menu, which is what ties the popover to the thing that opened it.
 */
const chipClass = (open: boolean) =>
  `flex h-7 min-w-0 cursor-pointer items-center gap-1.5 rounded-full border-0 px-2 text-label [font-family:inherit] hover:bg-user-bg hover:text-text disabled:cursor-default disabled:opacity-45 ${
    open ? 'bg-user-bg text-text' : 'bg-transparent text-muted'
  }`

/** Same weight as a chip, no hover, no arrow: a live chat’s checkout is a fact. */
const chipLabelClass = 'flex h-7 min-w-0 items-center gap-1.5 px-2 text-label text-muted'
