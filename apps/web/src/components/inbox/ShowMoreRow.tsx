import { QUIET_PAGE_SIZE } from '@manor/client-runtime/session-overview-ui'
import { FoldItem } from '../ui/Fold'

/** The next page of Settled or Archived rows, aligned with the row titles. */
export function ShowMoreRow({ remaining, mode, onClick }: {
  remaining: number
  mode: 'settled' | 'archived'
  onClick: () => void
}) {
  if (remaining <= 0) return null
  return (
    <FoldItem className="h-8">
      <button
        type="button"
        className="h-full w-full cursor-pointer rounded-lg border-0 bg-transparent pr-3 pl-[33px] text-left text-dim [font:inherit] hover:bg-surface-2 hover:text-muted"
        onClick={onClick}
      >
        {/* Sized here, not on the button: `[font:inherit]` there outranks a text utility. */}
        <span className={mode === 'archived' ? 'text-[15px]' : 'text-[14px]'}>
          Show {Math.min(QUIET_PAGE_SIZE, remaining)} more
        </span>
      </button>
    </FoldItem>
  )
}
