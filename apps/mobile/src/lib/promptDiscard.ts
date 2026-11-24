/**
 * Leaving the prompt sheet: an untouched draft just closes, a changed one first asks.
 * `ask` shows the question and calls `discard` only when the user chooses to drop the edit.
 */
export function leavePrompt({ draft, opened, close, ask }: {
  draft: string
  /** The text the sheet opened with. */
  opened: string
  close: () => void
  ask: (discard: () => void) => void
}) {
  if (draft === opened) close()
  else ask(close)
}
