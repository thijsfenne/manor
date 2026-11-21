import { useRef, useState } from 'react'
import { ArrowDown01Icon, ColorPickerIcon } from '@hugeicons/core-free-icons'
import type { AgentConfig, AgentDraft, ChatOverride } from '@manor/contracts'
import { BLOB_SHAPES, blobShapeOf } from '../../blobShapes'
import { personaColorChoices, safeHex } from '../../persona'
import { activeEffort, activeModel, activeSpeed, effectiveDriver, runtimeParts } from '../../runtimeChoices'
import { Avatar } from '../Avatar'
import { Icon } from '../Icon'
import { ProviderMark } from '../ProviderMark'
import { RuntimeLabel } from '../RuntimeLabel'
import { RuntimeSections, SPLIT_PICKER_SHELL, SPLIT_PICKER_WIDTH } from '../RuntimeMenu'
import { FormField, formFieldClass, formInputClass, formLabelClass } from '../ui/FormField'
import { Popover } from '../ui/Popover'
import { useDismiss } from '../ui/useDismiss'

type Driver = AgentDraft['driver']
const NO_PIN: ChatOverride = {}

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
        <input className={formInputClass} value={draft.name} onChange={(event) => edit({ name: event.target.value })} placeholder="Name" autoFocus maxLength={60} required />
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
 * The agent draft a runtime pick makes: the picker speaks in chat overrides, and here
 * each one becomes the agent's own provider, model, effort and speed.
 */
export function withRuntimePick(draft: AgentDraft, next: ChatOverride): AgentDraft {
  const voice: AgentConfig = { ...draft, id: draft.id ?? '', allowedTools: [] }
  const { model: _model, speed: _speed, ...rest } = draft
  const model = activeModel(voice, next)
  return {
    ...rest,
    driver: effectiveDriver(voice, next),
    ...(model === undefined ? {} : { model }),
    effort: activeEffort(voice, next),
    ...(activeSpeed(voice, next) === 'fast' ? { speed: 'fast' as const } : {}),
  }
}

/**
 * Provider, model, effort and Fast mode as one field: a row naming the pick, opening the
 * composer's own picker. There the picker pins a chat; here the pick is the agent's own
 * setting, so nothing in it is marked Default. The card opens above the row at a
 * dialog's foot and below it near a panel's top.
 */
export function ModelField({ draft, providers, disabled, opens = 'up', pin = NO_PIN, onChange }: {
  draft: AgentDraft
  providers: readonly Driver[]
  disabled: boolean
  opens?: 'up' | 'down'
  /**
   * A pin the agent's DM still carries. The field then names what the DM runs, and a
   * pick is the whole runtime it shows, for the caller to save and clear the pin with.
   */
  pin?: ChatOverride
  onChange: (draft: AgentDraft) => void
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  useDismiss(open, () => setOpen(false), { within: [rootRef] })
  const voice: AgentConfig = { ...draft, id: draft.id ?? '', allowedTools: [] }
  const parts = runtimeParts(voice, pin, false)

  const pick = (next: ChatOverride) => onChange(withRuntimePick(draft, next))

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
        aria-label={`Model, ${[parts.model, parts.effort, parts.speed].filter((part) => part !== undefined && part !== '').join(' ')}`}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="flex-1 text-muted">Model</span>
        <ProviderMark driver={effectiveDriver(voice, pin)} size={13} />
        <RuntimeLabel {...parts} />
        <Icon icon={ArrowDown01Icon} size={12} />
      </button>
      <Popover
        open={open}
        origin={opens === 'up' ? 'bottom-right' : 'top-right'}
        className={`absolute right-0 ${opens === 'up' ? 'bottom-[calc(100%+8px)]' : 'top-[calc(100%+8px)]'} z-10 ${SPLIT_PICKER_SHELL} ${SPLIT_PICKER_WIDTH} max-w-full`}
        role="menu"
        aria-label="Model"
      >
        <RuntimeSections
          agent={voice}
          override={pin}
          allowedDrivers={providers}
          layout="split"
          allowAuto={false}
          marksDefault={false}
          onChange={pick}
        />
      </Popover>
    </div>
  )
}
