import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { ArrowDown01Icon, FlashIcon, RefreshIcon, Settings01Icon } from '@hugeicons/core-free-icons'
import { FlashIcon as FlashSolidIcon } from '@manor/client-runtime/solid-icons'
import type { AgentConfig, ChatOverride, DriverName } from '@manor/contracts'
import {
  activeEffort,
  activeModel,
  activeSpeed,
  effectiveDriver,
  isAutoOn,
  isAutoPending,
  modelRowsFor,
  pinnedDriver,
  providerRowsFor,
  runtimeParts,
  supportsFastMode,
  withAuto,
  withDriver,
  withEffort,
  withModel,
  withSpeed,
} from '../runtimeChoices'
import { MODELS, defaultModel, effortsFor } from '../runtimes'
import { INSTANT, TEXT_SWAP } from '../motion'
import { useAutoRulesConfig } from './settings/AutoRulesPage'
import { IconButton } from './ui/IconButton'
import { MENU_SURFACE, MenuItem } from './ui/Menu'
import { Popover } from './ui/Popover'
import { Switch } from './ui/Switch'
import { SteppedSlider } from './ui/SteppedSlider'
import { useDismiss } from './ui/useDismiss'
import { Icon } from './Icon'
import { ProviderMark } from './ProviderMark'
import { RuntimeLabel } from './RuntimeLabel'
import { SegmentedControl, type SymbolSegmentOption } from './ui/SegmentedControl'
import { useHostAuto } from '../useHostAuto'
import { useOffModels } from '../useOffModels'

interface RuntimeMenuProps {
  agent: AgentConfig
  /** This chat's pin for this agent; empty when the roster config is in charge. */
  override: ChatOverride
  disabled: boolean
  /** Limits a voice without a persona to providers its runtime supports. */
  allowedDrivers?: readonly DriverName[]
  /** Gives a model-heavy bare runtime a provider rail beside its scrolling settings. */
  layout?: 'stacked' | 'split'
  /** Keeps the trigger proportional inside the side chat's compact composer. */
  compact?: boolean
  /** Side chat has no speed field, so it must not offer one. */
  allowSpeed?: boolean
  allowAuto?: boolean
  /** Single's synthetic voice follows its pin; its reset target stays with the fallback. */
  effortDefault?: AgentConfig['effort']
  title?: string
  /** The whole next override. Sending one with nothing in it clears the pin. */
  onChange: (override: ChatOverride) => void
}

/**
 * One persona's runtime for this chat, in the composer's bottom row: the mark of
 * the provider this chat runs her on, and one dropdown holding provider,
 * model and reasoning together. A pick here pins the value for this chat only (the
 * roster keeps the default every new chat starts from), so the menu marks the roster
 * values as Default and choosing them back is what removes the pin. Above a handful
 * of personas `RuntimeControls` folds these into one panel instead.
 */
export function RuntimeMenu({
  agent,
  override,
  disabled,
  allowedDrivers,
  layout = 'stacked',
  compact = false,
  allowSpeed = true,
  allowAuto = true,
  effortDefault,
  title,
  onChange,
}: RuntimeMenuProps) {
  const hostAuto = useHostAuto()
  const rootRef = useRef<HTMLDivElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion()
  const liveLabel = {
    driver: effectiveDriver(agent, override),
    pending: isAutoPending(agent, override, hostAuto),
    parts: runtimeParts(agent, override, hostAuto),
  }
  // The opening label keeps sizing the button until dismissal, including its mark
  // and speed badge. No measurement or width animation can move the click target.
  const [frozenLabel, setFrozenLabel] = useState<typeof liveLabel | null>(null)
  const open = frozenLabel !== null
  const label = frozenLabel ?? liveLabel
  useDismiss(open, () => setFrozenLabel(null), { within: [rootRef], escape: true })
  const fit = useFitInside(open, rootRef, popoverRef)

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        // No `[font:inherit]`: the shorthand overrides `text-meta` and makes these
        // labels inherit the larger body size instead.
        className={`flex min-w-0 cursor-pointer items-center rounded-full border-0 text-meta disabled:cursor-default disabled:opacity-45 ${
          compact ? 'h-7 gap-1 px-1.5' : 'h-9 gap-1.5 px-2'
        } ${
          open ? 'bg-user-bg text-text' : 'bg-transparent text-muted hover:bg-user-bg hover:text-text'
        }`}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={title ?? `${agent.name}, provider, model, reasoning and speed for this chat`}
        aria-label={`Change model and reasoning, ${liveLabel.parts.model} ${liveLabel.parts.effort}`}
        onClick={() => setFrozenLabel((current) => current === null ? liveLabel : null)}
      >
        <span className="relative min-w-0">
          <motion.span
            aria-hidden={open}
            className={`flex min-w-0 items-center ${compact ? 'gap-1' : 'gap-1.5'}`}
            initial={false}
            animate={{ opacity: open ? 0 : 1 }}
            transition={reduce ? INSTANT : TEXT_SWAP}
          >
            {label.pending ? null : <ProviderMark driver={label.driver} size={compact ? 11 : 13} />}
            <RuntimeLabel {...label.parts} className={compact ? 'max-w-[150px]' : 'max-w-[180px]'} />
          </motion.span>
          {open ? (
            <motion.span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden whitespace-nowrap text-muted"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={reduce ? INSTANT : TEXT_SWAP}
            >
              <span className="truncate">
                {effortsFor(liveLabel.driver, activeModel(agent, override)).length > 1 ? 'Select effort' : 'Select model'}
              </span>
            </motion.span>
          ) : null}
        </span>
        <Icon icon={ArrowDown01Icon} size={compact ? 10 : 12} />
      </button>

      <Popover
        ref={popoverRef}
        open={open}
        {...(fit === undefined ? {} : { style: fit })}
        className={
          layout === 'split'
            ? `absolute bottom-[calc(100%+8px)] left-0 z-[6] ${SPLIT_PICKER_SHELL} ${
                compact
                  ? 'w-[min(360px,calc(var(--side-width)-36px),calc(100vw-48px))]'
                  : SPLIT_PICKER_WIDTH
              }`
            : `absolute bottom-[calc(100%+8px)] left-0 z-[6] w-[236px] ${MENU_SURFACE}`
        }
        role="menu"
      >
        <RuntimeSections
          agent={agent}
          override={override}
          allowedDrivers={allowedDrivers}
          layout={layout}
          allowSpeed={allowSpeed}
          allowAuto={allowAuto}
          {...(effortDefault === undefined ? {} : { effortDefault })}
          onChange={onChange}
          onConfigureAuto={() => setFrozenLabel(null)}
        />
      </Popover>
    </div>
  )
}

/** Room kept between a shifted picker and the edge it would otherwise cross. */
const FIT_MARGIN = 8

/**
 * Keeps a picker that hangs from its trigger's left edge inside what can show it: the
 * window and every ancestor that clips. A trigger near the right edge, such as the
 * Browser session's composer, would otherwise run the card off the window. Only a
 * card that crosses an edge moves, so a picker with room renders where it always did.
 * Widths are read from layout, not from the box on screen, which the arrival scale
 * shrinks for its first frames.
 */
function useFitInside(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  cardRef: RefObject<HTMLElement | null>,
): CSSProperties | undefined {
  const [fit, setFit] = useState<CSSProperties | undefined>(undefined)
  // The card's own width, read while no cap of ours narrows it. Kept across opens, so a
  // card that reopens with last time's cap still knows how wide it wants to be.
  const natural = useRef(0)
  useLayoutEffect(() => {
    const anchor = anchorRef.current
    const card = cardRef.current
    // Nothing resets on close: the card is still leaving and must not jump back.
    if (!open || anchor === null || card === null) return
    const measure = () => {
      if (card.style.maxWidth === '') natural.current = card.offsetWidth
      let left = 0
      let right = window.innerWidth
      for (let node = anchor.parentElement; node !== null; node = node.parentElement) {
        if (getComputedStyle(node).overflowX === 'visible') continue
        const box = node.getBoundingClientRect()
        left = Math.max(left, box.left)
        right = Math.min(right, box.right)
      }
      const room = right - left - 2 * FIT_MARGIN
      const start = anchor.getBoundingClientRect().left
      const width = Math.min(natural.current, room)
      const shift = Math.max(left + FIT_MARGIN - start, Math.min(0, right - FIT_MARGIN - (start + width)))
      const next = natural.current > room ? { left: shift, maxWidth: room } : shift < 0 ? { left: shift } : undefined
      setFit((current) => current?.left === next?.left && current?.maxWidth === next?.maxWidth ? current : next)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [open, anchorRef, cardRef])
  return fit
}

/** The split picker's card and its width, shared with the Model field of Agent settings. */
export const SPLIT_PICKER_SHELL = 'overflow-hidden rounded-panel border border-line surface-floating'
export const SPLIT_PICKER_WIDTH = 'w-[360px] max-w-[calc(100vw-24px)]'

/**
 * The Provider, Model and Reasoning sections of one persona's choice, with Fast mode as a toggle
 * beside the reasoning label where the model has one. Shared verbatim
 * by the single menu and by a row of the folded roster panel, so the two surfaces
 * cannot drift into offering different things.
 *
 * Provider comes before Model because it decides what that list contains. In the
 * model-heavy split layout it becomes the left rail instead of taking vertical room.
 * Picking one costs more than the other two:
 * the CLI session for this chat ends and the whole thread is replayed into a fresh one
 * on the new provider, which is why it is a pick here and not something a message
 * carries.
 */
export function RuntimeSections({
  agent,
  override,
  onChange,
  onConfigureAuto,
  allowedDrivers,
  layout = 'stacked',
  allowSpeed = true,
  allowAuto = true,
  effortDefault = agent.effort,
  marksDefault = true,
}: {
  agent: AgentConfig
  override: ChatOverride
  onChange: (override: ChatOverride) => void
  /** Puts the surface around these sections away as the rule file opens over it. */
  onConfigureAuto?: () => void
  allowedDrivers?: readonly DriverName[]
  layout?: 'stacked' | 'split'
  allowSpeed?: boolean
  allowAuto?: boolean
  effortDefault?: AgentConfig['effort']
  /** False where the pick is the agent's own setting: nothing is a pin, so no Default mark and no reset. */
  marksDefault?: boolean
}) {
  const hostAuto = useHostAuto()
  const off = useOffModels()
  const driver = effectiveDriver(agent, override)
  const model = activeModel(agent, override)
  const effort = activeEffort(agent, override)
  const effortOptions = effortsFor(driver, model)
  const defaultEffort = activeEffort(agent, { ...override, effort: effortDefault })
  const speed = activeSpeed(agent, override)
  const fastCapable = allowSpeed && supportsFastMode(driver, model)
  const autoControl = allowAuto && hostAuto && driver !== 'mock' ? (
    <RuntimeAutoToggle
      checked={isAutoOn(override, hostAuto)}
      onChange={(checked) => onChange(withAuto(override, checked))}
      {...(onConfigureAuto === undefined ? {} : { onConfigure: onConfigureAuto })}
    />
  ) : null
  const providerOptions: readonly SymbolSegmentOption<AgentConfig['driver']>[] = providerRowsFor(agent, override, off)
    .filter((option) => allowedDrivers === undefined || allowedDrivers.includes(option.value))
    .map((option) => ({
      value: option.value,
      label: `${option.label}${marksDefault && option.value === agent.driver ? ', Default' : ''}`,
      title: `${option.label}${marksDefault && option.value === agent.driver ? ', Default' : ''}`,
      symbol: <ProviderMark driver={option.value} size={18} />,
    }))

  const providerControl = (
    <SegmentedControl
      label="Provider"
      options={providerOptions}
      value={driver}
      variant="symbols"
      floating
      orientation={layout === 'split' ? 'vertical' : 'horizontal'}
      onChange={(next) => onChange(withDriver(agent, override, next, off))}
    />
  )

  // Every provider's list keeps the longest list's height, so switching provider never
  // resizes the menu under the pointer.
  const tallestModelList = Math.max(
    0,
    ...providerOptions.map((option) => modelRowsFor(agent, withDriver(agent, override, option.value, off), off).length),
  )
  const modelHeading = <p className="m-0 px-3 pt-1.5 pb-0.5 text-meta font-medium text-dim">Model</p>

  const scrollableSettings = tallestModelList === 0 ? null : (
    <div className="grid">
      {MODELS[driver].length > 0 ? (
        <div className="col-start-1 row-start-1">
          {modelHeading}
          {modelRowsFor(agent, override, off).map((row) => (
            <MenuRow
              key={row.value}
              label={row.label}
              selected={row.value === model}
              {...(row.off ? { unavailable: 'Off' } : {})}
              // Under a pinned provider her own model belongs to the other CLI, so
              // nothing here is her default and the provider row above is the way back.
              isDefault={
                marksDefault &&
                pinnedDriver(agent, override) === undefined &&
                row.value === (agent.model ?? defaultModel(agent.driver))
              }
              onSelect={() => onChange(withModel(agent, override, row.value))}
            />
          ))}
        </div>
      ) : null}
      <div aria-hidden="true" className="invisible col-start-1 row-start-1">
        {modelHeading}
        {Array.from({ length: tallestModelList }, (_, index) => (
          <MenuRow key={index} label={'\u00a0'} selected={false} isDefault={marksDefault && index === 0} onSelect={() => {}} />
        ))}
      </div>
    </div>
  )

  const reasoningControl = effortOptions.length > 0 ? (
    <div className="shrink-0 border-t border-line px-3 pt-2 pb-1">
      <div className="mb-0.5 grid grid-cols-[24px_minmax(0,1fr)_24px] items-center">
        {fastCapable ? (
          <IconButton
            icon={speed === 'fast' ? FlashSolidIcon : FlashIcon}
            solid={speed === 'fast'}
            swapKey={speed}
            iconSize={14}
            size={24}
            label="Fast mode"
            selected={speed === 'fast'}
            aria-pressed={speed === 'fast'}
            onClick={() => onChange(withSpeed(agent, override, speed === 'fast' ? 'standard' : 'fast'))}
          />
        ) : <span aria-hidden="true" />}
        <span className="text-center text-label font-medium text-text">
          {effortOptions.find((option) => option.value === effort)?.label}
        </span>
        {marksDefault ? (
          <IconButton
            icon={RefreshIcon}
            iconSize={14}
            size={24}
            label="Reset reasoning to default"
            disabled={effort === defaultEffort}
            onClick={() => onChange(withEffort(agent, override, effortDefault))}
          />
        ) : <span aria-hidden="true" />}
      </div>
      <SteppedSlider
        label="Reasoning effort"
        options={effortOptions}
        value={effort}
        onChange={(next) => onChange(withEffort(agent, override, next))}
      />
    </div>
  ) : null

  if (layout === 'split') {
    return (
      <div className="flex max-h-[calc(100dvh-128px)] flex-col">
        {autoControl}
        <div className="grid min-h-0 grid-cols-[52px_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] overflow-hidden">
          <div className="border-r border-line p-1.5">{providerControl}</div>
          <div className="h-full min-h-0 overflow-y-auto overscroll-contain p-1">
            {scrollableSettings}
          </div>
        </div>
        {reasoningControl}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 max-h-[min(600px,calc(100dvh-128px))] flex-1 flex-col">
      {autoControl}
      <div className="shrink-0 px-1.5 pt-1.5 pb-0.5">
        {providerControl}
      </div>
      {/* Deliberately no note about what a switch costs. It restarts her session here,
          so the turn after it is read the whole chat again, but the user asked for the
          line out (2026-08-17): the menu is three rows of settings and a paragraph
          under one of them read as a warning about the pick above it. */}
      <div className="min-h-0 overflow-y-auto overscroll-contain pb-1">
        {scrollableSettings}
      </div>
      {reasoningControl}
    </div>
  )
}

/**
 * Auto on the composer row, left of the model picker. The gear sits after the
 * switch, the same order the runtime menu uses. In Single the model picker
 * collapses away while this switch is on.
 */
export function ComposerAutoControl({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}) {
  const configure = useAutoRulesConfig()

  return (
    <span className="flex h-9 flex-none items-center gap-2.5 px-1.5">
      <span className="text-meta text-muted">Auto</span>
      <Switch label="Auto mode" checked={checked} disabled={disabled} onChange={onChange} />
      {configure === null ? null : (
        <IconButton
          icon={Settings01Icon}
          iconSize={15}
          size={24}
          label="Auto mode rules"
          disabled={disabled}
          onClick={configure}
        />
      )}
    </span>
  )
}

export function RuntimeAutoToggle({ checked, disabled, onChange, onConfigure }: {
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  /** Closes whatever this row sits in, before the rule file opens over it. */
  onConfigure?: () => void
}) {
  const configure = useAutoRulesConfig()

  return (
    <div className="flex items-center justify-between gap-2.5 border-b border-line px-3 py-2 text-label text-text">
      <span>Auto mode</span>
      {/* Switch then gear: the house rule file stays reachable while Auto is off,
          and the composer strip uses the same order. */}
      <span className="flex items-center gap-2">
        <Switch label="Auto mode" checked={checked} disabled={disabled} onChange={onChange} />
        {configure === null ? null : (
          <IconButton
            icon={Settings01Icon}
            iconSize={15}
            size={24}
            label="Auto mode rules"
            disabled={disabled}
            onClick={() => {
              onConfigure?.()
              configure()
            }}
          />
        )}
      </span>
    </div>
  )
}

/**
 * One choice in a runtime menu: the shared menu row with a Default chip. Exported for
 * the checkout row's branch list, so the menus under the composer cannot drift into
 * looking like different mechanisms.
 *
 * `unavailable` is for a row that exists and cannot be taken — a branch another
 * worktree has checked out. It carries the reason rather than only dimming, because a
 * greyed row with no explanation is a dead end. Leave it off wherever the honest move
 * is to not offer the row at all; only give it a reason a user can act on.
 */
export function MenuRow({
  label,
  selected,
  isDefault,
  unavailable,
  onSelect,
}: {
  label: string
  selected: boolean
  isDefault: boolean
  unavailable?: string
  onSelect: () => void
}) {
  return (
    <MenuItem
      role="menuitemradio"
      checked={selected}
      blocked={unavailable}
      trailing={unavailable === undefined && !isDefault ? undefined : (
        <>
          {unavailable === undefined ? null : (
            <span className="max-w-[150px] flex-none truncate text-meta">{unavailable}</span>
          )}
          {isDefault ? (
            <span className="flex-none rounded-chip border border-line px-1.5 py-px text-meta text-dim">Default</span>
          ) : null}
        </>
      )}
      onClick={onSelect}
    >
      {label}
    </MenuItem>
  )
}
