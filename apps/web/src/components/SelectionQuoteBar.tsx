import { createPortal } from 'react-dom'

/** The floating Quote / Add to side chat bar that follows a text selection. */
export function SelectionQuoteBar({
  left,
  top,
  onQuote,
  onAddToSideChat,
}: {
  left: number
  top: number
  onQuote?: () => void
  onAddToSideChat?: () => void
}) {
  if (onQuote === undefined && onAddToSideChat === undefined) return null
  return createPortal(
    <div
      role="toolbar"
      aria-label="Selected text actions"
      data-quote-action
      className="fixed z-40 flex -translate-x-1/2 -translate-y-full overflow-hidden rounded-full border border-line bg-raised text-[12px] font-medium text-text shadow-pill"
      style={{ left, top }}
      onPointerDown={(event) => event.preventDefault()}
    >
      {onQuote === undefined ? null : (
        <button
          type="button"
          className="cursor-pointer px-3 py-1.5 transition-colors hover:bg-surface-2"
          onClick={onQuote}
        >
          Quote selection
        </button>
      )}
      {onAddToSideChat === undefined ? null : (
        <button
          type="button"
          className={`cursor-pointer px-3 py-1.5 transition-colors hover:bg-surface-2${onQuote === undefined ? '' : ' border-l border-line'}`}
          onClick={onAddToSideChat}
        >
          Add to side chat
        </button>
      )}
    </div>,
    document.body,
  )
}
