import {
  Calendar03Icon,
  CheckmarkCircle02Icon,
  File01Icon,
  Link01Icon,
  Tag01Icon,
  TextIcon,
} from '@hugeicons/core-free-icons'
import type { NoteProperty } from '../../vaultNotes'
import { Icon } from '../Icon'

const propertyIcons = new Map([
  ['date', Calendar03Icon],
  ['status', CheckmarkCircle02Icon],
  ['tags', Tag01Icon],
  ['type', File01Icon],
  ['source', Link01Icon],
])

const statusColors = new Map([
  ['active', 'bg-busy/12 text-busy'],
  ['done', 'bg-ok/12 text-ok'],
  ['completed', 'bg-ok/12 text-ok'],
  ['blocked', 'bg-warn/12 text-warn'],
  ['pending', 'bg-warn/12 text-warn'],
  ['failed', 'bg-danger/12 text-danger'],
])

export function NoteProperties({ properties, onEdit }: {
  properties: readonly NoteProperty[]
  onEdit: (line: number) => void
}) {
  return (
    <div className="mx-auto max-w-[46rem] border-b border-line pb-4">
      {properties.length === 0 ? (
        <button type="button" className="cursor-pointer text-label text-muted hover:text-text"
          onMouseDown={(event) => event.preventDefault()} onClick={() => onEdit(0)}>
          Edit properties
        </button>
      ) : (
        <dl className="m-0 grid grid-cols-[minmax(0,min(32%,7.5rem))_minmax(0,1fr)] items-start gap-x-2 gap-y-0.5 text-label">
          {properties.map(({ key, line, values }) => (
            <div key={line} className="contents">
              <dt className="flex min-h-7 min-w-0 items-center gap-2 text-muted" title={key}>
                <Icon icon={propertyIcons.get(key) ?? TextIcon} size={14} aria-hidden className="flex-none" />
                <span className="truncate first-letter:uppercase">{key}</span>
              </dt>
              <dd className="m-0 min-w-0">
                <button type="button" aria-label={`Edit ${key}: ${values.join(', ') || 'empty'}`}
                  className="flex min-h-7 w-full min-w-0 cursor-text flex-wrap items-center gap-1 rounded-md px-1.5 py-0.5 text-left text-label text-text hover:bg-tree-hover focus-visible:bg-tree-hover"
                  onMouseDown={(event) => event.preventDefault()} onClick={() => onEdit(line)}>
                  {values.length === 0 ? <span className="text-muted italic">empty</span> : values.map((value, index) => (
                    <span key={index} className={key === 'status'
                      ? `inline-flex min-w-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-meta wrap-anywhere ${statusColors.get(value.toLowerCase()) ?? 'bg-surface-2 text-muted'}`
                      : key === 'tags'
                        ? 'rounded-chip bg-surface-2 px-1.5 py-0.5 text-meta wrap-anywhere text-muted'
                        : 'wrap-anywhere'}>
                      {key === 'status' ? <span aria-hidden className="size-1.5 flex-none rounded-full bg-current" /> : null}
                      {value}
                    </span>
                  ))}
                </button>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  )
}
