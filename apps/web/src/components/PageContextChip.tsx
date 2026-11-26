import {
  Archive02Icon,
  Cancel01Icon,
  CursorRectangleSelection01Icon,
  Mail01Icon,
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
  // A mail has no page to name it by, and its label only repeats its subject.
  const mail = context.kind === 'mail'
  const title = context.title.trim() || (mail ? context.label : hostOf(context.url))
  return (
    <SourceContextChip
      {...(mail ? {} : { detail: context.label })}
      icon={
        mail
          ? Mail01Icon
          : context.kind === 'artifact'
            ? Archive02Icon
            : context.kind === 'text'
              ? TextSelectionIcon
              : CursorRectangleSelection01Icon
      }
      name={title}
      removeLabel={`Remove context from ${title}`}
      title={mail ? title : `${title}\n${context.label}\n${context.url}`}
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
  /** Without one, the name has the chip to itself. */
  detail?: string
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
      <span className={`truncate font-medium text-text ${detail === undefined ? 'max-w-[260px] min-w-0' : 'max-w-[150px] flex-none'}`}>{name}</span>
      {detail === undefined ? null : <span className="min-w-0 truncate">{detail}</span>}
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
