import { FlashIcon } from '@manor/client-runtime/solid-icons'
import ArrowRight01Icon from '@hugeicons/core-free-icons/ArrowRight01Icon'
import Files01Icon from '@hugeicons/core-free-icons/Files01Icon'
import Tick02Icon from '@hugeicons/core-free-icons/Tick02Icon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import {
  type AgentConfig,
  type ChatOverride,
  type SingleRuntime,
} from '@manor/contracts'
import {
  activeEffort,
  activeModel,
  activeSpeed,
  effectiveDriver,
  isAutoOn,
  isAutoPending,
  isSingleDriver,
  readSingleRuntime,
  modelRowsFor,
  pinnedDriver,
  providerRowsFor,
  runtimeLabel,
  runtimeParts,
  singleRuntimeVoice,
  supportsFastMode,
  withAuto,
  withDriver,
  withEffort,
  withModel,
  withSpeed,
} from '@manor/client-runtime/runtime-choices'
import { MODELS, defaultModel, effortsFor } from '@manor/client-runtime/runtimes'
import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native'
import Animated, { FadeIn, FadeOut, SlideInLeft, SlideInRight, useReducedMotion } from 'react-native-reanimated'

import { Blobatar } from '@/components/Blobatar'
import { ProviderMark } from '@/components/ProviderMark'
import { Sheet } from '@/components/Sheet'
import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle } from '@/theme'
import { useHostAuto } from '@/useHostAuto'

interface RuntimeSheetProps {
  open: boolean
  onClose: () => void
  agents: AgentConfig[]
  overrides: Record<string, ChatOverride>
  /** Who has a seat in the chat. Absent on the new-chat stage, where nobody has yet. */
  activeAgentIds?: readonly string[]
  /** Personas whose first turn in this chat has already started. */
  startedAgentIds?: readonly string[]
  /** True while the socket is down: the values stay readable, the picks do not. */
  disabled?: boolean
  onChange: (agentId: string, override: ChatOverride) => void
  /** A DM's file library. When set, the list ends with a Files row that opens it. */
  onFiles?: () => void
}

/**
 * The household as a list, and one persona's provider, model and reasoning behind
 * it. The same two views the Mac's roster panel has, in a sheet, so a pin means the
 * same thing on both: this chat only, the Agents section keeps her defaults.
 */
export function RuntimeSheet({ open, onClose, agents, overrides, activeAgentIds, startedAgentIds = [], disabled = false, onChange, onFiles }: RuntimeSheetProps) {
  const hostAuto = useHostAuto()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [direction, setDirection] = useState<'forward' | 'back'>('forward')
  const still = useReducedMotion()
  const selected = agents.find((agent) => agent.id === selectedId) ?? null
  const active = activeAgentIds === undefined ? null : new Set(activeAgentIds)
  const started = new Set(startedAgentIds)
  const canEnableAuto = (agent: AgentConfig) =>
    !started.has(agent.id) && overrides[agent.id]?.autoResolved !== true

  const enter = (agentId: string) => {
    setDirection('forward')
    setSelectedId(agentId)
  }
  const back = () => {
    setDirection('back')
    setSelectedId(null)
  }
  const close = () => {
    setSelectedId(null)
    onClose()
  }

  return (
    <Sheet
      onClose={close}
      onBack={selected === null ? undefined : back}
      open={open}
      subtitle={selected === null
        ? 'This chat only. Agents keeps the default.'
        : <RuntimeSummary agent={selected} override={overrides[selected.id] ?? {}} />}
      title={selected === null ? 'Agents' : selected.name}
    >
      {selected === null ? (
        <Animated.View entering={still ? undefined : direction === 'back' ? SlideInLeft.duration(220) : FadeIn.duration(120)} exiting={still ? undefined : FadeOut.duration(80)} key="list" style={styles.fill}>
          <ScrollView contentContainerStyle={styles.list}>
            <View style={styles.group}>
              {agents.map((agent, index) => {
                const override = overrides[agent.id] ?? {}
                const seated = active === null || active.has(agent.id)
                const parts = runtimeParts(agent, override, hostAuto)
                return (
                  <Pressable
                    accessibilityLabel={`${agent.name}, ${runtimeLabel(agent, override, hostAuto)}`}
                    accessibilityRole="button"
                    disabled={disabled}
                    key={agent.id}
                    onPress={() => enter(agent.id)}
                    style={({ pressed }) => [styles.row, pressed && styles.rowPressed, disabled && styles.disabled]}
                  >
                    <View style={[styles.identity, !seated && styles.unseated]}>
                      <Blobatar color={agent.color} name={agent.name} shape={agent.avatarShape} tone={agent.avatarTone} size={30} src={agent.avatar} />
                      <View style={styles.names}>
                        <Text numberOfLines={1} style={styles.name}>{agent.name}</Text>
                        <Text numberOfLines={1} style={styles.role}>{agent.role}</Text>
                      </View>
                    </View>
                    <View style={[styles.value, !seated && styles.unseated]}>
                      {isAutoPending(agent, override, hostAuto) ? null : (
                        <ProviderMark driver={effectiveDriver(agent, override)} size={13} />
                      )}
                      <Text numberOfLines={1} style={styles.model}>{parts.model}</Text>
                      <Text numberOfLines={1} style={styles.effort}>{parts.effort}</Text>
                      {parts.speed === undefined ? null : (
                        <HugeiconsIcon color={colors.muted} icon={FlashIcon} size={13} strokeWidth={1.8} />
                      )}
                    </View>
                    <HugeiconsIcon color={colors.dim} icon={ArrowRight01Icon} size={16} strokeWidth={1.7} />
                    {index === agents.length - 1 ? null : <View style={styles.line} />}
                  </Pressable>
                )
              })}
            </View>
            {onFiles === undefined ? null : (
              <View style={styles.group}>
                <Pressable
                  accessibilityLabel="Files"
                  accessibilityRole="button"
                  onPress={onFiles}
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                >
                  <HugeiconsIcon color={colors.text} icon={Files01Icon} size={20} strokeWidth={1.7} />
                  <Text numberOfLines={1} style={styles.menuLabel}>Files</Text>
                  <HugeiconsIcon color={colors.dim} icon={ArrowRight01Icon} size={16} strokeWidth={1.7} />
                </Pressable>
              </View>
            )}
          </ScrollView>
        </Animated.View>
      ) : (
        <Animated.View entering={still ? undefined : SlideInRight.duration(220)} exiting={still ? undefined : FadeOut.duration(80)} key={selected.id} style={styles.fill}>
          <RuntimeSections
            agent={selected}
            allowAuto={canEnableAuto(selected)}
            disabled={disabled}
            onChange={(next) => onChange(selected.id, next)}
            onFinalPicked={back}
            override={overrides[selected.id] ?? {}}
          />
        </Animated.View>
      )}
    </Sheet>
  )
}

/**
 * One persona's runtime without the roster in front of it, for a DM's model chip:
 * the room has one voice, so the list would be a step with a single row.
 */
export function AgentRuntimeSheet({ open, onClose, agent, override, allowAuto, disabled = false, onChange }: {
  open: boolean
  onClose: () => void
  agent: AgentConfig
  override: ChatOverride
  allowAuto: boolean
  disabled?: boolean
  onChange: (override: ChatOverride) => void
}) {
  return (
    <Sheet onClose={onClose} open={open} subtitle={<RuntimeSummary agent={agent} override={override} />} title="Model">
      <RuntimeSections
        agent={agent}
        allowAuto={allowAuto}
        disabled={disabled}
        onChange={onChange}
        onFinalPicked={onClose}
        override={override}
      />
    </Sheet>
  )
}

/** The same runtime picker without a persona roster for a bare Single session. */
export function SingleRuntimeSheet({
  open,
  onClose,
  override,
  fallback,
  disabled = false,
  allowAuto = true,
  onChange,
}: {
  open: boolean
  onClose: () => void
  override: ChatOverride
  fallback: SingleRuntime
  disabled?: boolean
  allowAuto?: boolean
  onChange: (override: ChatOverride) => void
}) {
  const hostAuto = useHostAuto()
  const voice = singleRuntimeVoice(readSingleRuntime(override, fallback))

  const select = (next: ChatOverride) => {
    if (allowAuto && isAutoOn(next, hostAuto) && next.autoResolved !== true) {
      onChange(next)
      return
    }
    const driver = effectiveDriver(voice, next)
    if (!isSingleDriver(driver)) return
    const model = activeModel(voice, next) ?? defaultModel(driver)
    if (model === undefined) return
    const speed = activeSpeed(voice, next)
    onChange({
      driver,
      model,
      effort: activeEffort(voice, next),
      auto: false,
      ...(speed === 'fast' ? { speed } : {}),
    })
  }

  return (
    <AgentRuntimeSheet
      agent={voice}
      allowAuto={allowAuto}
      disabled={disabled}
      onChange={select}
      onClose={onClose}
      open={open}
      override={override}
    />
  )
}

function RuntimeSummary({ agent, override }: { agent: AgentConfig; override: ChatOverride }) {
  const hostAuto = useHostAuto()
  const parts = runtimeParts(agent, override, hostAuto)
  return (
    <View accessibilityLabel={runtimeLabel(agent, override, hostAuto)} accessible style={styles.runtimeSummary}>
      <Text numberOfLines={1} style={styles.runtimeSummaryText}>{[parts.model, parts.effort].filter(Boolean).join(', ')}</Text>
      {parts.speed === undefined ? null : (
        <HugeiconsIcon color={colors.muted} icon={FlashIcon} size={13} strokeWidth={1.8} />
      )}
    </View>
  )
}

/**
 * Provider, model, reasoning and optional speed for one persona, in the same order
 * as the Mac. Provider decides the models; model decides reasoning and Fast support.
 */
function RuntimeSections({
  agent,
  override,
  disabled,
  onChange,
  onFinalPicked,
  allowAuto = true,
}: {
  agent: AgentConfig
  override: ChatOverride
  disabled: boolean
  onChange: (override: ChatOverride) => void
  onFinalPicked: () => void
  allowAuto?: boolean
}) {
  const hostAuto = useHostAuto()
  const driver = effectiveDriver(agent, override)
  const model = activeModel(agent, override)
  const effort = activeEffort(agent, override)
  const speed = activeSpeed(agent, override)
  const fastCapable = supportsFastMode(driver, model)

  return (
    <ScrollView contentContainerStyle={styles.list}>
      {allowAuto && hostAuto && driver !== 'mock' ? (
        <View style={styles.row}>
          <Text style={styles.menuLabel}>Auto mode</Text>
          <Switch accessibilityLabel="Auto mode" disabled={disabled} value={isAutoOn(override, hostAuto)}
            onValueChange={(checked) => onChange(withAuto(override, checked))} />
        </View>
      ) : null}
      <View accessibilityLabel="Provider" accessibilityRole="radiogroup" style={styles.providerTabs}>
        {providerRowsFor(agent).map((option) => {
          const selected = option.value === driver
          const isDefault = option.value === agent.driver
          return (
            <Pressable
              accessibilityLabel={`${option.label}${isDefault ? ', Default' : ''}`}
              accessibilityRole="radio"
              accessibilityState={{ selected, disabled }}
              disabled={disabled}
              key={option.value}
              onPress={() => onChange(withDriver(agent, override, option.value))}
              style={({ pressed }) => [
                styles.providerTab,
                selected && styles.providerTabSelected,
                pressed && !selected && styles.providerTabPressed,
                disabled && styles.disabled,
              ]}
            >
              <ProviderMark driver={option.value} size={20} />
            </Pressable>
          )
        })}
      </View>
      {MODELS[driver].length > 0 ? (
        <Section title="Model">
          {modelRowsFor(agent, override).map((row, index, all) => (
            <MenuRow
              disabled={disabled}
              isDefault={pinnedDriver(agent, override) === undefined && row.value === (agent.model ?? defaultModel(agent.driver))}
              key={row.value}
              label={row.label}
              last={index === all.length - 1}
              onSelect={() => onChange(withModel(agent, override, row.value))}
              selected={row.value === model}
            />
          ))}
        </Section>
      ) : null}
      <Section title="Reasoning">
        {effortsFor(driver, model).map((option, index, all) => (
          <MenuRow
            disabled={disabled}
            isDefault={option.value === agent.effort}
            key={option.value}
            label={option.label}
            last={index === all.length - 1}
            onSelect={() => {
              onChange(withEffort(agent, override, option.value))
              if (!fastCapable) onFinalPicked()
            }}
            selected={option.value === effort}
          />
        ))}
      </Section>
      {fastCapable ? (
        <Section title="Speed">
          <MenuRow
            disabled={disabled}
            isDefault
            label="Standard"
            last={false}
            onSelect={() => {
              onChange(withSpeed(agent, override, 'standard'))
              onFinalPicked()
            }}
            selected={speed === 'standard'}
          />
          <MenuRow
            disabled={disabled}
            isDefault={false}
            label="Fast"
            last
            onSelect={() => {
              onChange(withSpeed(agent, override, 'fast'))
              onFinalPicked()
            }}
            selected={speed === 'fast'}
          />
        </Section>
      ) : null}
    </ScrollView>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.group}>{children}</View>
    </View>
  )
}

function MenuRow({
  label,
  leading,
  selected,
  isDefault,
  last,
  disabled,
  onSelect,
}: {
  label: string
  /** A mark before the label, the provider's for a provider row. */
  leading?: React.ReactNode
  selected: boolean
  isDefault: boolean
  last: boolean
  disabled: boolean
  onSelect: () => void
}) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onSelect}
      style={({ pressed }) => [styles.row, styles.menuRow, pressed && styles.rowPressed, disabled && styles.disabled]}
    >
      {leading === undefined ? null : <View style={styles.leading}>{leading}</View>}
      <Text numberOfLines={1} style={styles.menuLabel}>{label}</Text>
      {isDefault ? <View style={styles.defaultChip}><Text style={styles.defaultText}>Default</Text></View> : null}
      <View style={styles.tick}>
        {selected ? <HugeiconsIcon color={colors.text} icon={Tick02Icon} size={17} strokeWidth={2} /> : null}
      </View>
      {last ? null : <View style={styles.line} />}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  list: { gap: spacing.xl, paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: spacing.xxl },
  group: { overflow: 'hidden', borderRadius: radius.panel, ...squircle, backgroundColor: colors.sheetSurface },
  providerTabs: { flexDirection: 'row', gap: spacing.xs },
  providerTab: { flex: 1, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md, ...squircle },
  providerTabSelected: { backgroundColor: colors.sheetPressed },
  providerTabPressed: { opacity: 0.65 },
  row: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg },
  rowPressed: { backgroundColor: colors.sheetPressed },
  identity: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  runtimeSummary: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  runtimeSummaryText: { flexShrink: 1, color: colors.muted, fontFamily: fonts.sans, fontSize: 13 },
  unseated: { opacity: 0.45 },
  names: { flex: 1, minWidth: 0, gap: 1 },
  name: { color: colors.text, fontFamily: fonts.sans, fontSize: 16, fontWeight: '500' },
  role: { color: colors.muted, fontFamily: fonts.sans, fontSize: 12 },
  // The model in text colour and the level muted beside it: two facts, two weights,
  // the same pair the Mac's `RuntimeLabel` draws.
  value: { maxWidth: 150, flexDirection: 'row', alignItems: 'center', gap: 5 },
  model: { color: colors.text, fontFamily: fonts.sans, fontSize: 13, fontWeight: '500', flexShrink: 1 },
  effort: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13 },
  // From the avatar's left edge to past the chevron, not edge to edge.
  line: { position: 'absolute', right: spacing.lg, bottom: 0, left: spacing.lg, height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  leading: { width: 20, alignItems: 'center', marginRight: -2 },
  section: { gap: spacing.sm },
  sectionTitle: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13, fontWeight: '500', paddingHorizontal: spacing.xs },
  menuRow: { minHeight: 52 },
  menuLabel: { flex: 1, color: colors.text, fontFamily: fonts.sans, fontSize: 16 },
  defaultChip: { borderRadius: radius.round, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, paddingHorizontal: spacing.sm, paddingVertical: 2 },
  defaultText: { color: colors.dim, fontFamily: fonts.sans, fontSize: 11 },
  tick: { width: 20, alignItems: 'flex-end' },
  disabled: { opacity: 0.5 },
})
