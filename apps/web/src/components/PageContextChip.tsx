import {
  Archive02Icon,
  Cancel01Icon,
  CursorRectangleSelection01Icon,
  TextSelectionIcon,
} from '@hugeicons/core-free-icons'
import type { PageContextAttachment } from '@manor/contracts'
import { Icon } from './Icon'

/** Explicit source context in the draft or in the durable transcript. */
export function PageContextChip({
  context,
  onRemove,
}: {
  context: PageContextAttachment
  onRemove?: () => void
}) {
  const title = context.title.trim() || hostOf(context.url)
  return (
    <SourceContextChip
      detail={context.label}
      icon={
        context.kind === 'artifact'
          ? Archive02Icon
          : context.kind === 'text'
            ? TextSelectionIcon
            : CursorRectangleSelection01Icon
      }
      name={title}
      removeLabel={`Remove context from ${title}`}
      title={`${title}\n${context.label}\n${context.url}`}
      {...(onRemove === undefined ? {} : { onRemove })}
    />
  )
}

/** Shared frame for explicit source context in a draft or durable user bubble. */
export function SourceContextChip({
  icon,
  name,
  detail,
  title,
  removeLabel,
  appearance = 'default',
  onRemove,
}: {
  icon: Parameters<typeof Icon>[0]['icon']
  name: string
  detail: string
  title: string
  removeLabel?: string
  appearance?: 'default' | 'composer'
  onRemove?: () => void
}) {
  return (
    <span
      className={`flex min-w-0 max-w-full items-center gap-1.5 rounded-chip px-2 py-1 text-[12px] text-muted ${appearance === 'composer' ? 'bg-user-bg' : 'border border-line bg-surface-2'}`}
      title={title}
    >
      <Icon icon={icon} size={13} className="flex-none" />
      <span className="max-w-[150px] flex-none truncate font-medium text-text">{name}</span>
      <span className="min-w-0 truncate">{detail}</span>
      {onRemove === undefined ? null : (
        <button
          type="button"
          className="grid h-5 w-5 flex-none cursor-pointer place-items-center rounded-full border-0 bg-transparent p-0 text-dim hover:bg-user-bg hover:text-text"
          aria-label={removeLabel}
          onClick={onRemove}
        >
          <Icon icon={Cancel01Icon} size={11} />
        </button>
      )}
    </span>
  )
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}
