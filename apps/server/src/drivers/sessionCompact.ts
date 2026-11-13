import type { CompactSessionInput, CompactSessionResult, TurnHandle, TurnInput } from '@manor/contracts'

export const CLAUDE_COMPACT_COMMAND = '/compact'
export const GROK_COMPACT_COMMAND = '/compact'

export const LIVE_COMPACT_NOTE = 'Compacting the live session…'
export const LIVE_COMPACT_DONE = 'Compacted the live session.'
/** `/compact` where no live compact runs: Manor's summary carries the conversation into a fresh session. */
export const ROLLOVER_COMPACT_DONE = 'Compacted. The next reply starts from the summary.'
export const LIVE_COMPACT_FAILED = 'Could not compact the live session.'
export const LIVE_COMPACT_STOPPED = 'Stopped compacting the live session.'

/** Resume input for a compact hook: same session, no Manor catch-up text. */
export function compactTurnInput(input: CompactSessionInput): TurnInput {
  return {
    agent: input.agent,
    threadId: input.threadId,
    cwd: input.cwd,
    repoPaths: input.repoPaths,
    catchUp: [],
    isFullCatchUp: false,
    infrastructure: true,
    sessionId: input.sessionId,
    ...(input.singleSession === true ? { singleSession: true } : {}),
    ...(input.speed === undefined ? {} : { speed: input.speed }),
    ...(input.mcpServers === undefined || input.mcpServers.length === 0
      ? {}
      : { mcpServers: input.mcpServers }),
  }
}

/** Drain a compact handle to one result. Tool noise is ignored. */
export async function awaitSessionCompact(handle: TurnHandle): Promise<CompactSessionResult> {
  try {
    for await (const event of handle.events) {
      if (event.type === 'error') return { ok: false, reason: event.message }
      if (event.type === 'result') return { ok: true }
    }
    return { ok: false, reason: 'the provider finished without compacting' }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}
