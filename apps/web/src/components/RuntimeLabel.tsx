import { FlashIcon } from '@manor/client-runtime/solid-icons'
import { Icon } from './Icon'

/**
 * "Opus 5 High" plus a Fast mark, the runtime a persona runs on: model first,
 * then the quiet reasoning and optional speed qualifier. One component rather than
 * one string, because every compact surface must render the parts the same way.
 *
 * The wrapper carries the width cap; the model truncates inside it so a long name
 * eats itself rather than pushing the level out of the row. The agents roster leaves
 * the level out and mutes the model, so the names lead its rows.
 */
export function RuntimeLabel({
  model,
  effort,
  speed,
  className = '',
}: {
  model: string
  effort?: string
  speed?: string
  className?: string
}) {
  return (
    <span className={`flex min-w-0 items-baseline gap-1 ${className}`}>
      <span className={`truncate ${effort === undefined ? 'text-muted' : 'text-text'}`}>{model}</span>
      {effort === undefined ? null : <span className="flex-none text-muted">{effort}</span>}
      {speed === undefined ? null : (
        <span className="flex flex-none self-center items-center text-muted" title="Fast mode">
          <Icon icon={FlashIcon} size={13} aria-hidden="true" />
          <span className="sr-only">Fast mode</span>
        </span>
      )}
    </span>
  )
}
