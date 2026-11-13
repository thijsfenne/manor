/**
 * What the sidebar knows about a chat nobody is looking at. Turns keep running
 * server-side, so a closed chat still has news and still has work in flight.
 */
export interface ChatActivity {
  /** Something landed here while another chat was open. Cleared on selection. */
  unread: boolean
  /** Turn ids the server reported running; the dot stays on while any remain. */
  runningTurns: string[]
  /**
   * When the current run began, null while idle. The lists sort a working chat on
   * this instead of `lastMessageAt`, because every streamed message bumps the
   * latter and two working chats would leapfrog each other for the whole run.
   */
  runStartedAt: number | null
  /**
   * Whether this client watched the current run start, rather than finding it
   * already going in a snapshot. Kept apart from `runStartedAt`, which a snapshot
   * legitimately fills so the sidebar can sort a working chat and the header can
   * show a timer: what a reconnect cannot give is the fact that *this* window was
   * there when the work began, and that is the fact a done notice needs. Without it
   * a turn that ran while the laptop was shut announces itself as news.
   */
  sawStart: boolean
  /**
   * Request ids this chat has asked and nobody has answered. Its own list rather than
   * a flag on the running turn: a chat with a question open is not working, it is
   * waiting on the user, and those two say different words in the same slot of a row.
   */
  awaitingInput: string[]
  /**
   * Request ids this session already answered. A late directory listing can still
   * name one of these after the response event, and seeding it again would put
   * Waiting back on a chat that is done.
   */
  answeredInput: string[]
}

export const IDLE: ChatActivity = {
  unread: false,
  runningTurns: [],
  runStartedAt: null,
  sawStart: false,
  awaitingInput: [],
  answeredInput: [],
}

export function withActivity(
  activity: Record<string, ChatActivity>,
  chatId: string,
  next: ChatActivity,
): Record<string, ChatActivity> {
  const current = activity[chatId]
  // Every field, not just the two the sidebar draws. `runStartedAt` and `sawStart`
  // change without the dot changing — a `turn_state: running` for a turn a delta had
  // already registered moves both and neither of the others — and an early-out blind
  // to them silently kept the old values, which is a run that can never be announced.
  // `awaitingInput` is the same trap: a question lands mid-run and moves nothing else.
  if (
    current &&
    current.unread === next.unread &&
    current.runStartedAt === next.runStartedAt &&
    current.sawStart === next.sawStart &&
    current.awaitingInput.length === next.awaitingInput.length &&
    current.awaitingInput.every((id, index) => id === next.awaitingInput[index]) &&
    current.answeredInput.length === next.answeredInput.length &&
    current.answeredInput.every((id, index) => id === next.answeredInput[index]) &&
    current.runningTurns.length === next.runningTurns.length &&
    current.runningTurns.every((id, index) => id === next.runningTurns[index])
  ) {
    return activity
  }
  return { ...activity, [chatId]: next }
}
