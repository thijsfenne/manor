import { useRef, useState } from 'react'
import { ArrowDown01Icon, ColorPickerIcon } from '@hugeicons/core-free-icons'
import type { AgentDraft } from '@manor/contracts'
import { BLOB_SHAPES, blobShapeOf } from '../../blobShapes'
import { personaColorChoices, safeHex } from '../../persona'
import { MODELS, PROVIDERS, effortsFor } from '../../runtimes'
import { Avatar } from '../Avatar'
import { Icon } from '../Icon'
import { ProviderMark } from '../ProviderMark'
import { MenuRow } from '../RuntimeMenu'
import { FormField, formFieldClass, formInputClass, formLabelClass } from '../ui/FormField'
import { Popover } from '../ui/Popover'
import { SegmentedControl } from '../ui/SegmentedControl'
import { SteppedSlider } from '../ui/SteppedSlider'
import { useDismiss } from '../ui/useDismiss'
import { withRuntime } from './newAgent'

type Driver = AgentDraft['driver']

const tileClass = 'grid cursor-pointer place-items-center rounded-full border p-0 leading-none outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary'
const pickedClass = 'border-[var(--color-text)]'
const unpickedClass = 'border-transparent hover:border-dim'

/**
 * The four things a new agent needs: a face, a name, what it helps with and what it
 * runs on. Shared by the New agent dialog and the onboarding's first agent, so the two
 * cannot drift. Everything else (instructions, tools, placement) comes later.
 */
export function NewAgentFields({ draft, providers, disabled = false, onChange }: {
  draft: AgentDraft
  /** The providers the Model picker offers, in order. */
  providers: readonly Driver[]
  disabled?: boolean
  onChange: (draft: AgentDraft) => void
}) {
  const edit = (patch: Partial<AgentDraft>) => { if (!disabled) onChange({ ...draft, ...patch }) }
  const accent = safeHex(draft.color)
  // The face follows the name until a shape is picked, and the row says which one it wears.
  const worn = blobShapeOf(draft.name, draft.avatarShape)?.id

  return (
    <div className="flex flex-col gap-4">
      <div className="grid justify-items-center gap-3">
        <Avatar name={draft.name} color={accent} shape={draft.avatarShape} tone={draft.avatarTone} size={72} />
        <div className="flex flex-wrap justify-center gap-1.5" role="group" aria-label="Agent colour">
          {personaColorChoices(draft.color).map((option) => {
            const selected = option.value.toLowerCase() === accent.toLowerCase()
            return (
              <button
                key={option.value}
                type="button"
                className={`${tileClass} size-7 ${selected ? pickedClass : unpickedClass}`}
                aria-label={option.label}
                aria-pressed={selected}
                title={option.label}
                onClick={() => edit({ color: option.value })}
              >
                <span className="size-[22px] rounded-full" style={{ backgroundColor: option.value }} />
              </button>
            )
          })}
          <span
            className={`${tileClass} relative size-7 border-dashed border-dim text-muted hover:border-[var(--color-text)] hover:text-text focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary`}
            title="Custom colour"
          >
            <Icon icon={ColorPickerIcon} size={14} />
            <input className="absolute inset-0 cursor-pointer opacity-0" type="color" value={accent} aria-label="Custom colour" onChange={(event) => edit({ color: event.target.value })} />
          </span>
        </div>
        <div className="flex flex-wrap justify-center gap-0.5" role="group" aria-label="Shape">
          {BLOB_SHAPES.map((option) => {
            const selected = worn === option.id
            return (
              <button
                key={option.id}
                type="button"
                className={`${tileClass} size-10 ${selected ? `${pickedClass} bg-user-bg` : unpickedClass}`}
                aria-label={`Shape: ${option.label}`}
                aria-pressed={selected}
                title={option.label}
                onClick={() => edit({ avatarShape: option.id })}
              >
                <Avatar name={draft.name} color={accent} shape={option.id} tone={draft.avatarTone} size={28} center />
              </button>
            )
          })}
        </div>
      </div>

      <label className={formFieldClass}>
        <span className={formLabelClass}>Name <span className="text-meta text-dim">required</span></span>
        <input className={formInputClass} value={draft.name} onChange={(event) => edit({ name: event.target.value })} placeholder="Name your agent" autoFocus maxLength={60} required />
      </label>

      <FormField label="What should this agent help with?">
        <textarea
          className={`${formInputClass} min-h-[64px] resize-y leading-relaxed`}
          value={draft.description}
          onChange={(event) => edit({ description: event.target.value })}
          placeholder="Meeting prep, follow-ups and a weekly status."
          rows={2}
        />
      </FormField>

      <ModelField draft={draft} providers={providers} disabled={disabled} onChange={onChange} />
    </div>
  )
}

/**
 * Provider, model and effort as one field: a row naming the pick, opening a card with
 * the providers as a rail, that provider's models and an effort slider.
 */
function ModelField({ draft, providers, disabled, onChange }: {
  draft: AgentDraft
  providers: readonly Driver[]
  disabled: boolean
  onChange: (draft: AgentDraft) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  useDismiss(open, () => setOpen(false), { within: [rootRef] })
  const models = MODELS[draft.driver]
  const modelLabel = models.find((option) => option.value === draft.model)?.label ?? draft.model ?? 'No model'
  const efforts = effortsFor(draft.driver, draft.model)
  const effortLabel = efforts.find((option) => option.value === draft.effort)?.label
  const providerOptions = PROVIDERS.filter((option) => providers.includes(option.value)).map((option) => ({
    value: option.value,
    label: option.label,
    title: option.label,
    symbol: <ProviderMark driver={option.value} size={18} />,
  }))

  return (
    <div
      ref={rootRef}
      // Focusable only so a press on the picker's padding keeps focus inside the field.
      tabIndex={-1}
      className="relative outline-none"
      // Escape closes the picker only, with focus back on its row: the dialog around it
      // would otherwise take the key first. Focus leaving the field closes it too, so an
      // Escape pressed elsewhere never finds a picker still open.
      onKeyDown={(event) => {
        if (!open || event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        setOpen(false)
        triggerRef.current?.focus()
      }}
      onBlur={(event) => {
        if (open && !(event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget))) setOpen(false)
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`${formInputClass} flex cursor-pointer items-center gap-2 text-left disabled:cursor-default disabled:opacity-45`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Model, ${modelLabel}${effortLabel === undefined ? '' : ` ${effortLabel}`}`}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="flex-1 text-muted">Model</span>
        <ProviderMark driver={draft.driver} size={13} />
        <span className="truncate text-text">{modelLabel}</span>
        {effortLabel === undefined ? null : <span className="flex-none text-muted">{effortLabel}</span>}
        <Icon icon={ArrowDown01Icon} size={12} />
      </button>
      <Popover
        open={open}
        origin="bottom"
        className="absolute inset-x-0 bottom-[calc(100%+8px)] z-10 overflow-hidden rounded-xl border border-line surface-floating"
        role="menu"
        aria-label="Model"
      >
        <div className="grid grid-cols-[52px_minmax(0,1fr)]">
          <div className="border-r border-line p-1.5">
            <SegmentedControl
              label="Provider"
              options={providerOptions}
              value={draft.driver}
              variant="symbols"
              floating
              orientation="vertical"
              onChange={(driver) => onChange(withRuntime(draft, driver))}
            />
          </div>
          <div className="min-w-0 p-1.5">
            <p className="m-0 px-2 pt-1.5 pb-0.5 text-meta font-medium text-dim">{PROVIDERS.find((option) => option.value === draft.driver)?.label}</p>
            {models.map((option) => (
              <MenuRow
                key={option.value}
                label={option.label}
                size="lg"
                selected={option.value === draft.model}
                isDefault={false}
                onSelect={() => onChange(withRuntime(draft, draft.driver, option.value))}
              />
            ))}
          </div>
        </div>
        {efforts.length === 0 ? null : (
          <div className="border-t border-line px-3 pt-2 pb-1">
            <div className="flex items-center justify-between text-label">
              <span className="text-muted">Effort</span>
              <span className="font-medium text-text">{effortLabel}</span>
            </div>
            <SteppedSlider label="Reasoning effort" options={efforts} value={draft.effort} onChange={(effort) => onChange({ ...draft, effort })} />
          </div>
        )}
      </Popover>
    </div>
  )
}
