import type { TurnRow } from './transcriptState'

/**
 * Copy the live-compact notes from `sessionCompact.ts`. The UI matches these
 * strings rather than importing the server module.
 */
export const LIVE_COMPACT_NOTE = 'Compacting the live session…'
export const LIVE_COMPACT_DONE = 'Compacted the live session.'
export const ROLLOVER_COMPACT_DONE = 'Compacted. The next reply starts from the summary.'
export const LIVE_COMPACT_FAILED = 'Could not compact the live session.'
export const LIVE_COMPACT_STOPPED = 'Stopped compacting the live session.'

/**
 * A compaction is in flight: Manor's live compact before the turn, or the CLI's own
 * mid-turn. Same slot as Waiting: a pause, not a ticker. While it holds, Compacting
 * is the only thing in the turn that reads as active: the transcript state pauses the
 * plan's spinner on it, and the trace settles the newest call.
 */
export const isCompacting = (turn: TurnRow): boolean =>
  turn.live?.state === 'running' && (
    turn.live.context?.compacting === true ||
    (turn.note?.kind === 'info' && turn.note.text === LIVE_COMPACT_NOTE)
  )
