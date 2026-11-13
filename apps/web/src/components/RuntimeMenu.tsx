import { useRef, useState } from 'react'
import { motion, useReducedMotion } from 'motion/react'
import { ArrowDown01Icon, FlashIcon, RefreshIcon, Settings01Icon, Tick02Icon } from '@hugeicons/core-free-icons'
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
import { Popover } from './ui/Popover'
import { Switch } from './ui/Switch'
import { SteppedSlider } from './ui/SteppedSlider'
import { useDismiss } from './ui/useDismiss'
import { Icon } from './Icon'
import { ProviderMark } from './ProviderMark'
import { RuntimeLabel } from './RuntimeLabel'
import { SegmentedControl, type SymbolSegmentOption } from './ui/SegmentedControl'
import { useHostAuto } from '../useHostAuto'

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
        open={open}
        className={
          layout === 'split'
            ? `absolute bottom-[calc(100%+8px)] left-0 z-[6] overflow-hidden rounded-xl border border-line surface-floating ${
                compact
                  ? 'w-[min(360px,calc(var(--side-width)-36px),calc(100vw-48px))]'
                  : 'w-[360px] max-w-[calc(100vw-24px)]'
              }`
            : 'absolute bottom-[calc(100%+8px)] left-0 z-[6] w-[236px] rounded-xl border border-line surface-floating p-1.5'
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
}) {
  const hostAuto = useHostAuto()
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
  const providerOptions: readonly SymbolSegmentOption<AgentConfig['driver']>[] = providerRowsFor(agent)
    .filter((option) => allowedDrivers === undefined || allowedDrivers.includes(option.value))
    .map((option) => ({
      value: option.value,
      label: `${option.label}${option.value === agent.driver ? ', Default' : ''}`,
      title: `${option.label}${option.value === agent.driver ? ' · Default' : ''}`,
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
      onChange={(next) => onChange(withDriver(agent, override, next))}
    />
  )

  // Every provider's list keeps the longest list's height, so switching provider never
  // resizes the menu under the pointer.
  const tallestModelList = Math.max(
    0,
    ...providerOptions.map((option) => modelRowsFor(agent, withDriver(agent, override, option.value)).length),
  )
  const modelHeading = <p className="m-0 px-2 pt-1.5 pb-0.5 text-meta font-medium text-dim">Model</p>

  const scrollableSettings = tallestModelList === 0 ? null : (
    <div className="grid">
      {MODELS[driver].length > 0 ? (
        <div className="col-start-1 row-start-1">
          {modelHeading}
          {modelRowsFor(agent, override).map((row) => (
            <MenuRow
              key={row.value}
              label={row.label}
              size="lg"
              selected={row.value === model}
              // Under a pinned provider her own model belongs to the other CLI, so
              // nothing here is her default and the provider row above is the way back.
              isDefault={
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
          <MenuRow key={index} label={'\u00a0'} size="lg" selected={false} isDefault={index === 0} onSelect={() => {}} />
        ))}
      </div>
    </div>
  )

  const reasoningControl = effortOptions.length > 0 ? (
    <div className="shrink-0 border-t border-line px-2 pt-2 pb-1">
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
        <IconButton
          icon={RefreshIcon}
          iconSize={14}
          size={24}
          label="Reset reasoning to default"
          disabled={effort === defaultEffort}
          onClick={() => onChange(withEffort(agent, override, effortDefault))}
        />
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
          <div className="h-full min-h-0 overflow-y-auto overscroll-contain p-1.5">
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
      <div className="shrink-0 px-1 pt-1 pb-0.5">
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
    <div className="flex items-center justify-between gap-2.5 border-b border-line px-2 py-2 text-label text-text">
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
 * One choice in a runtime menu. Exported for the side chat's own menu, which offers a
 * model and an effort with no persona behind them, and for the checkout row's branch
 * list: same rows, same Default chip, so the menus cannot drift into looking like
 * different mechanisms.
 *
 * `unavailable` is for a row that exists and cannot be taken — a branch another
 * worktree has checked out. It carries the reason rather than only dimming, because a
 * greyed row with no explanation is a dead end. Leave it off wherever the honest move
 * is to not offer the row at all; only give it a reason a user can act on.
 *
 * `size` is `sm` everywhere a menu holds settings, and `md` under the composer, where
 * the checkout row reads at the size of the message being written. A prop rather than
 * a class, so the two sizes stay a choice this component knows about.
 */
export function MenuRow({
  label,
  selected,
  isDefault,
  unavailable,
  size = 'sm',
  onSelect,
}: {
  label: string
  selected: boolean
  isDefault: boolean
  unavailable?: string
  size?: 'sm' | 'md' | 'lg'
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      disabled={unavailable !== undefined}
      title={unavailable}
      className={`flex w-full cursor-pointer items-center gap-2 rounded-md border-0 px-2 py-1.5 text-left text-text disabled:cursor-default disabled:text-dim disabled:hover:bg-transparent ${
        selected ? 'bg-menu-selected' : 'bg-transparent hover:bg-user-bg'
      } ${
        size === 'md' ? 'text-label' : size === 'lg' ? 'text-[14px] leading-[1.125rem]' : 'text-label'
      }`}
      onClick={onSelect}
    >
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {unavailable === undefined ? null : (
        <span className="max-w-[150px] flex-none truncate text-meta text-dim">{unavailable}</span>
      )}
      {isDefault ? (
        <span className="flex-none rounded-chip border border-line px-1.5 py-px text-meta text-dim">Default</span>
      ) : null}
      {selected ? <Icon icon={Tick02Icon} size={13} /> : <span className="w-[13px] flex-none" aria-hidden="true" />}
    </button>
  )
}
