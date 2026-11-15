import type { SubagentState, SubagentSummary } from '@manor/contracts'
import type { SidebarSubagent, SubagentGroup } from '../state'
import { EFFORTS, PROVIDERS, modelLabel } from '../runtimes'
import { ProviderMark } from './ProviderMark'
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
 */
export function SubagentChildRows({ group, indent = CHILD_INDENT, onOpen }: {
  group: SubagentGroup | undefined
  /** Where a child's mark starts, in line with the text of the row it hangs off. */
  indent?: number
  /** Opens the parent with this child's view, by its launch call id. */
  onOpen: (toolCallId: string) => void
}) {
  if (group === undefined || group.children.length === 0) return null
  return (
    <ul
      className={`m-0 mb-1 flex list-none flex-col gap-px p-0 ${CHILD_RAIL}`}
      style={{ marginLeft: indent - RAIL_TO_TEXT }}
      aria-label="Subagents"
    >
      {group.children.map((child) => (
        <li key={child.id} className="m-0">
          <ChildBody
            child={child}
            inset={ROW_INSET + (group.depth[child.id] ?? 0) * NEST_STEP}
            onOpen={() => onOpen(child.toolCallId)}
          />
        </li>
      ))}
    </ul>
  )
}

/**
 * Mark, title, spinner. No face: a child is a model with an effort working for the
 * persona on the row above, not someone in the house. Only a running child spins; a
 * finished one that lingers a moment for its own child shows nothing, never a dot,
 * because a dot here would read as unread.
 */
function ChildBody({ child, inset, onOpen }: { child: SidebarSubagent; inset: number; onOpen: () => void }) {
  const { model, effort } = child
  const runsOn = model === undefined || effort === undefined
    ? providerName(child.driver)
    : subagentRuntimeLine({ driver: child.driver, model, effort })
  return (
    <button
      type="button"
      className="flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-lg border-0 bg-transparent pr-3 text-left text-muted hover:bg-surface-2 hover:text-text"
      style={{ paddingLeft: inset }}
      aria-label={`${child.title}, ${runsOn}, ${subagentStateWord(child.state)}. Open`}
      onClick={onOpen}
    >
      <ProviderMark driver={child.driver} size={14} />
      <span className="min-w-0 flex-1 truncate text-[13px] text-inherit">{child.title}</span>
      {child.state === 'running' ? <Standing waiting={false} unread={false} running lastMessageAt={null} now={0} /> : null}
    </button>
  )
}
