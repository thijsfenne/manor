import { useEffect, useMemo } from 'react'
import { AnimatePresence, motion, useIsPresent, useReducedMotion } from 'motion/react'
import { ArrowRight01Icon } from '@hugeicons/core-free-icons'
import type { SubagentState, SubagentSummary } from '@manor/contracts'
import type { SidebarSubagent, SubagentGroup } from '../state'
import { EFFORTS, PROVIDERS, modelLabel } from '../runtimes'
import { DISCLOSURE, DISCLOSURE_OUT, INSTANT } from '../motion'
import {
  expandSubagentRows,
  litSubagentId,
  rowsHidingActive,
  subagentLines,
  toggleSubagentRow,
  useCollapsedSubagentRows,
  visibleSubagentLines,
} from '../subagentCollapse'
import { Icon } from './Icon'
import { ProviderMark } from './ProviderMark'
import { SelectionMarker, SIDEBAR_ROW_MARKER } from './ui/SelectionMarker'
import { Standing } from './inbox/Standing'

/** The Sessions row's title sits at 12px; its children start one level further in. */
const CHILD_INDENT = 39
/** How much further in a child's own child starts, so it reads as hanging off the row above. */
const NEST_STEP = 12
/**
 * From the rail to where a child's provider mark starts: the 1px rail, the 6px that
 * keeps a row's hover fill from touching it, then the row's own 10px inset. The mark
 * therefore lines up with the parent row's title.
 */
const RAIL_TO_TEXT = 17
const ROW_INSET = 10

/**
 * The rail the children hang from, drawn as a repeating gradient rather than
 * `border-l border-dotted`: at the hairline width and alpha a dotted border uses
 * here, the dots close up and read as a slightly paler solid line. Painting them
 * puts the dot and the gap under our control. The rail stops 4px short at both ends
 * so it never runs into the parent row it hangs from.
 */
const CHILD_RAIL =
  'pl-[7px] [background-image:repeating-linear-gradient(to_bottom,color-mix(in_srgb,var(--color-dim)_45%,transparent)_0_2px,transparent_2px_5px)] [background-position:left_4px] [background-repeat:no-repeat] [background-size:1px_calc(100%_-_8px)]'

const STATE_WORD: Record<SubagentState, string> = {
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
}

/** What one child runs on, the way its row, its bar and the Agents list all say it. */
export const subagentRuntimeLine = (child: Pick<SubagentSummary, 'driver' | 'model' | 'effort'>): string =>
  `${modelLabel(child.driver, child.model)}, ${EFFORTS.find((option) => option.value === child.effort)?.label ?? child.effort}`

export const subagentStateWord = (state: SubagentState): string => STATE_WORD[state]

/** The provider's own name, for a helper that ran on it without Manor choosing a model. */
export const providerName = (driver: SubagentSummary['driver']): string =>
  PROVIDERS.find((option) => option.value === driver)?.label ?? driver

/**
 * The children one sidebar row has working, hanging from a dotted rail under it,
 * however many there are. One line each: provider mark, title, and the spinner while
 * it runs; model and effort live on the turn's card and in its view. A child leaves
 * once it and its own children are finished; the parent's Agents list keeps the full
 * record. A child's own children run one step further in along the same rail. A click
 * opens the parent with that child's conversation on the stage.
 *
 * The row it hangs off and any child with children of its own fold away with a
 * `SubagentDisclosure`; the child whose view is open lights instead of that row and
 * opens every fold above it.
 */
export function SubagentChildRows({ group, rowKey, activeId, marked = false, indent = CHILD_INDENT, onOpen }: {
  group: SubagentGroup | undefined
  /** The key the row it hangs off folds under: that row's chat id. */
  rowKey: string
  /** The child whose view is open, which takes the sidebar's selected fill instead of the row above. */
  activeId?: string | undefined
  /** The lit child carries the list's travelling fill rather than a fill of its own. */
  marked?: boolean
  /** Where a child's mark starts, in line with the text of the row it hangs off. */
  indent?: number
  /** Opens the parent with this child's view, by its launch call id. */
  onOpen: (toolCallId: string) => void
}) {
  const collapsed = useCollapsedSubagentRows()
  const lines = useMemo(() => group === undefined ? [] : subagentLines(group), [group])
  // Opening a child unfolds what hides it once; folding it away again afterwards is the
  // user's call, and the light then rests on the fold that hides it.
  const hiding = rowsHidingActive(rowKey, lines, activeId).join('\0')
  useEffect(() => {
    if (hiding !== '') expandSubagentRows(hiding.split('\0'))
  }, [hiding])
  const litId = litSubagentId(rowKey, group, collapsed, activeId)
  const fold = useReducedMotion() ? FOLD_INSTANT : FOLD
  const shown = collapsed.has(rowKey) ? [] : visibleSubagentLines(lines, collapsed)
  return (
    <AnimatePresence initial={false}>
      {shown.length === 0 ? null : (
        <motion.ul
          key="children"
          className={`m-0 mb-1 flex list-none flex-col gap-px overflow-hidden p-0 ${CHILD_RAIL}`}
          style={{ marginLeft: indent - RAIL_TO_TEXT }}
          aria-label="Subagents"
          {...fold}
        >
          {/* Propagates the list's own exit, so a row leaving with it also gives up the light. */}
          <AnimatePresence initial={false} propagate>
            {shown.map(({ child, depth, descendants }) => (
              <motion.li key={child.id} className="m-0 overflow-hidden" {...fold}>
                <ChildBody
                  child={child}
                  inset={ROW_INSET + depth * NEST_STEP}
                  active={child.id === litId}
                  marked={marked}
                  hidden={descendants}
                  onOpen={() => onOpen(child.toolCallId)}
                />
              </motion.li>
            ))}
          </AnimatePresence>
        </motion.ul>
      )}
    </AnimatePresence>
  )
}

/** A fold opening or shutting: height and opacity on the house disclosure curves. */
const FOLD = {
  initial: { height: 0, opacity: 0 },
  animate: { height: 'auto', opacity: 1, transition: DISCLOSURE },
  exit: { height: 0, opacity: 0, transition: DISCLOSURE_OUT },
} as const
const FOLD_INSTANT = { initial: false, animate: { height: 'auto', opacity: 1 }, exit: { height: 0, opacity: 0, transition: INSTANT } } as const

/**
 * The fold on a row with subagents under it: a chevron that points right while they
 * are hidden, with how many, and down while they show. It only toggles; the row
 * around it still opens.
 */
export function SubagentDisclosure({ rowKey, title, count }: { rowKey: string; title: string; count: number }) {
  const folded = useCollapsedSubagentRows().has(rowKey)
  const reduceMotion = useReducedMotion() ?? false
  return (
    <button
      type="button"
      className="pointer-events-auto flex h-5 flex-none cursor-pointer items-center gap-0.5 rounded-md border-0 bg-transparent px-1 text-dim [font:inherit] hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-primary"
      aria-expanded={!folded}
      aria-label={`${folded ? 'Expand' : 'Collapse'} ${title}`}
      onClick={(event) => {
        event.stopPropagation()
        toggleSubagentRow(rowKey)
      }}
    >
      {folded ? <span className="text-[12px] tabular-nums">{count}</span> : null}
      <motion.span
        className="grid place-items-center"
        initial={false}
        animate={{ rotate: folded ? 0 : 90 }}
        transition={reduceMotion ? INSTANT : DISCLOSURE}
      >
        <Icon icon={ArrowRight01Icon} size={12} />
      </motion.span>
    </button>
  )
}

/**
 * Mark, title, spinner. No face: a child is a model with an effort working for the
 * persona on the row above, not someone in the house. Only a running child spins; a
 * finished one that lingers a moment for its own child shows nothing, never a dot,
 * because a dot here would read as unread.
 */
function ChildBody({ child, inset, active, marked, hidden, onOpen }: {
  child: SidebarSubagent
  inset: number
  active: boolean
  marked: boolean
  /** How many rows hang below this one, which its fold would hide. */
  hidden: number
  onOpen: () => void
}) {
  const { model, effort } = child
  // A row on its way out has left the list: it gives up the light and takes no clicks.
  const present = useIsPresent()
  const lit = active && present
  const runsOn = model === undefined || effort === undefined
    ? providerName(child.driver)
    : subagentRuntimeLine({ driver: child.driver, model, effort })
  return (
    <div
      className={`relative flex h-7 min-w-0 items-center rounded-lg pr-1.5 ${
        lit ? `text-text ${marked ? '' : 'bg-user-bg'}` : 'text-muted hover:bg-surface-2 hover:text-text'
      }`}
      {...(present ? {} : { inert: '' })}
    >
      {lit && marked ? <SelectionMarker layoutId={SIDEBAR_ROW_MARKER} className="rounded-lg" /> : null}
      <button
        type="button"
        className="relative flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 border-0 bg-transparent pr-1.5 text-left text-inherit [font:inherit]"
        style={{ paddingLeft: inset }}
        aria-label={`${child.title}, ${runsOn}, ${subagentStateWord(child.state)}. Open`}
        aria-current={lit ? 'page' : undefined}
        onClick={onOpen}
      >
        <ProviderMark driver={child.driver} size={14} />
        <span className="min-w-0 flex-1 truncate text-[13px] text-inherit">{child.title}</span>
        {child.state === 'running' ? <Standing waiting={false} unread={false} running lastMessageAt={null} now={0} /> : null}
      </button>
      {hidden === 0 ? null : <span className="relative"><SubagentDisclosure rowKey={child.id} title={child.title} count={hidden} /></span>}
    </div>
  )
}
