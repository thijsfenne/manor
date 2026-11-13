import type { ReactNode } from 'react'

export const formFieldClass = 'flex flex-col gap-1.5'
export const formLabelClass = 'flex items-center gap-2 text-[14px] text-muted'
export const formHintClass = 'text-label text-dim'
/** Sits at the far right of the label row, in the label's own case. */
export const formOptionalClass = 'ml-auto text-meta text-dim'
export const formInputClass =
  'w-full rounded-lg border border-line bg-surface-2 px-2.5 py-[7px] text-[13px] text-text outline-none placeholder:text-dim focus:border-dim'

interface FormFieldProps {
  label: string
  optional?: boolean
  hint?: ReactNode
  /**
   * For a control that is not a native form element, our own `Select` above all.
   * A `<label>` forwards a click anywhere in the row — the hint text included — to
   * the first labelable thing inside it, so a wrapped dropdown opens when you meant
   * to read the help text. Such a control names itself with `aria-label` instead.
   */
  custom?: boolean
  className?: string
  children: ReactNode
}

/** Labels and help text stay visually identical across every Manor dialog. */
export function FormField({
  label,
  optional = false,
  hint,
  custom = false,
  className = '',
  children,
}: FormFieldProps) {
  const Wrapper = custom ? 'div' : 'label'
  return (
    <Wrapper className={`${formFieldClass} ${className}`}>
      <span className={formLabelClass}>
        {label}
        {optional ? <span className={formOptionalClass}>optional</span> : null}
      </span>
      {children}
      {hint === undefined ? null : <span className={formHintClass}>{hint}</span>}
    </Wrapper>
  )
}
