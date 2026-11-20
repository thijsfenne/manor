/*
 * THESIS: A DM's agent at a glance, one step behind the chat: who she is, what she runs on and what she holds.
 * FIRST VIEWPORT: Back, her face large with name and role, the Name and Title fields, Model, then Files, Scheduled tasks, Skills and Connectors.
 */
import AiBrain01Icon from '@hugeicons/core-free-icons/AiBrain01Icon'
import ArrowLeft01Icon from '@hugeicons/core-free-icons/ArrowLeft01Icon'
import ArrowRight01Icon from '@hugeicons/core-free-icons/ArrowRight01Icon'
import BoxIcon from '@hugeicons/core-free-icons/BoxIcon'
import Clock01Icon from '@hugeicons/core-free-icons/Clock01Icon'
import ConnectIcon from '@hugeicons/core-free-icons/ConnectIcon'
import Files01Icon from '@hugeicons/core-free-icons/Files01Icon'
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react-native'
import { effectiveDriver, runtimeParts } from '@manor/client-runtime/runtime-choices'
import type { AgentConfig } from '@manor/contracts'
import { router, useLocalSearchParams } from 'expo-router'
import { useState, type ReactNode } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { TextInput } from '@/components/TextInput'
import { SafeAreaView } from 'react-native-safe-area-context'

import { Blobatar } from '@/components/Blobatar'
import { ConnectGate } from '@/components/ConnectGate'
import { GlassIconButton } from '@/components/GlassIconButton'
import { ProviderMark } from '@/components/ProviderMark'
import { routineOn } from '@/components/RoutineRow'
import { AgentRuntimeSheet } from '@/components/RuntimeSheet'
import { Text } from '@/components/Text'
import { agentHoldings, agentOfDm, type AgentList } from '@/lib/agentOverview'
import { useWorkspace, type AgentEdit } from '@/providers/WorkspaceProvider'
import { colors, fonts, radius, spacing, squircle, tracking } from '@/theme'
import { useHostAuto } from '@/useHostAuto'

export default function AgentOverviewScreen() {
  return (
    <ConnectGate>
      <AgentOverview />
    </ConnectGate>
  )
}

function AgentOverview() {
  const { chatId } = useLocalSearchParams<{ chatId: string }>()
  const { workspace } = useWorkspace()
  const agent = agentOfDm(workspace, chatId)
  const back = () => (router.canGoBack() ? router.back() : router.replace({ pathname: '/chat/[id]', params: { id: chatId } }))

  return (
    <SafeAreaView edges={['top']} style={styles.screen}>
      <View style={styles.header}>
        <GlassIconButton accessibilityLabel="Back" icon={ArrowLeft01Icon} onPress={back} />
      </View>
      {agent === undefined ? (
        <Text style={styles.gone}>This agent is no longer in Manor.</Text>
      ) : (
        // Keyed on the agent, so a draft never carries over to another one.
        <AgentPage agent={agent} chatId={chatId} key={agent.id} />
      )}
    </SafeAreaView>
  )
}

function AgentPage({ agent, chatId }: { agent: AgentConfig; chatId: string }) {
  const { workspace, status, setChatOverride, saveAgent } = useWorkspace()
  const hostAuto = useHostAuto()
  const [modelOpen, setModelOpen] = useState(false)
  // Auto never claims a DM, so her pin reads as Auto off, as the composer's chip reads it.
  const override = { ...workspace.threads[chatId]?.overrides[agent.id], auto: false }
  const runtime = runtimeParts(agent, override, hostAuto)
  const runtimeLine = [runtime.model, runtime.effort].filter(Boolean).join(', ')
  const holdings = agentHoldings(workspace, agent)
  const tasksOn = holdings.tasks.filter(routineOn).length
  const openList = (list: AgentList) => router.push({ pathname: '/agent/[chatId]/[list]', params: { chatId, list } })

  return (
    <>
      <ScrollView contentContainerStyle={styles.page} keyboardShouldPersistTaps="handled">
        <View style={styles.identity}>
          <Blobatar color={agent.color} name={agent.name} shape={agent.avatarShape} tone={agent.avatarTone} size={96} src={agent.avatar} />
          <View style={styles.nameLine}>
            <Text maxFontSizeMultiplier={1.35} style={styles.name}>{agent.name}</Text>
            {agent.role === '' ? null : <Text maxFontSizeMultiplier={1.35} style={styles.role}>{agent.role}</Text>}
          </View>
        </View>

        <IdentityFields agent={agent} live={status === 'live'} onSave={(edit) => saveAgent(agent.id, edit)} />

        <View style={styles.group}>
          <Row
            icon={AiBrain01Icon}
            label="Model"
            last
            onPress={() => setModelOpen(true)}
            spoken={runtimeLine}
            value={(
              <>
                <ProviderMark driver={effectiveDriver(agent, override)} size={13} />
                <Text numberOfLines={1} style={styles.value}>{runtimeLine}</Text>
              </>
            )}
          />
        </View>

        <View style={styles.group}>
          <Row icon={Files01Icon} label="Files" onPress={() => router.push({ pathname: '/files/[chatId]', params: { chatId } })} />
          <Row icon={Clock01Icon} label="Scheduled tasks" onPress={() => openList('tasks')} value={holdings.tasks.length === 0 ? 'None yet' : `${tasksOn} on`} />
          <Row icon={BoxIcon} label="Skills" onPress={() => openList('skills')} value={`${holdings.skills.length} on`} />
          <Row icon={ConnectIcon} label="Connectors" last onPress={() => openList('connectors')} value={`${holdings.connectors.length} on`} />
        </View>
      </ScrollView>

      <AgentRuntimeSheet
        agent={agent}
        allowAuto={false}
        disabled={status !== 'live'}
        onChange={(next) => setChatOverride(chatId, agent.id, next)}
        onClose={() => setModelOpen(false)}
        open={modelOpen}
        override={override}
      />
    </>
  )
}

/**
 * Name and Title, each saved on its own as it is left, as the Mac saves without a button.
 * A field shows what is typed, then what was sent until the roster answers, else the
 * roster. A name left empty goes back to the stored one; a refused save says why.
 */
function IdentityFields({ agent, live, onSave }: { agent: AgentConfig; live: boolean; onSave: (edit: Partial<AgentEdit>) => Promise<void> }) {
  const [editing, setEditing] = useState<{ field: keyof AgentEdit; value: string } | null>(null)
  const [sent, setSent] = useState<Partial<AgentEdit>>({})
  const [error, setError] = useState<string | null>(null)
  const shown = (field: keyof AgentEdit) => (editing?.field === field ? editing.value : sent[field] ?? agent[field])

  const commit = () => {
    if (editing === null) return
    const { field } = editing
    const typed = editing.value.trim()
    const before = sent[field] ?? agent[field]
    const value = field === 'name' && typed === '' ? before : typed
    setEditing(null)
    if (value === before) return
    setError(null)
    setSent((current) => ({ ...current, [field]: value }))
    // The roster lands before the ack, so either way the field can fall back to it then.
    const settle = () => setSent(({ [field]: held, ...rest }) => (held === value ? rest : { ...rest, [field]: held }))
    onSave({ [field]: value }).then(settle, (reason: unknown) => {
      setError(reason instanceof Error ? reason.message : 'Manor could not save this agent.')
      settle()
    })
  }

  return (
    <View style={styles.fields}>
      <View style={styles.group}>
        <Field
          editable={live}
          label="Name"
          onBlur={commit}
          onChange={(value) => setEditing({ field: 'name', value })}
          onFocus={() => setEditing({ field: 'name', value: shown('name') })}
          placeholder={agent.name}
          value={shown('name')}
        />
        <Field
          editable={live}
          label="Title"
          last
          onBlur={commit}
          onChange={(value) => setEditing({ field: 'role', value })}
          onFocus={() => setEditing({ field: 'role', value: shown('role') })}
          placeholder="Assistant"
          value={shown('role')}
        />
      </View>
      {error === null ? null : <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    </View>
  )
}

function Field({ label, value, placeholder, editable, last = false, onChange, onFocus, onBlur }: {
  label: string
  value: string
  placeholder: string
  editable: boolean
  last?: boolean
  onChange: (value: string) => void
  onFocus: () => void
  onBlur: () => void
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        autoCapitalize="words"
        autoCorrect={false}
        clearButtonMode="while-editing"
        editable={editable}
        onBlur={onBlur}
        onChangeText={onChange}
        onFocus={onFocus}
        placeholder={placeholder}
        placeholderTextColor={colors.dim}
        returnKeyType="done"
        selectionColor={colors.text}
        style={[styles.input, !editable && styles.disabled]}
        value={value}
      />
      {last ? null : <View style={styles.line} />}
    </View>
  )
}

function Row({ icon, label, value, spoken, last = false, onPress }: {
  icon: IconSvgElement
  label: string
  value?: ReactNode
  /** What a drawn value says aloud; a string value speaks for itself. */
  spoken?: string
  last?: boolean
  onPress: () => void
}) {
  const said = spoken ?? (typeof value === 'string' ? value : undefined)
  return (
    <Pressable
      accessibilityLabel={said === undefined ? label : `${label}, ${said}`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <HugeiconsIcon color={colors.text} icon={icon} size={20} strokeWidth={1.7} />
      <Text numberOfLines={1} style={styles.label}>{label}</Text>
      <View style={styles.valueSlot}>
        {typeof value === 'string' ? <Text numberOfLines={1} style={styles.value}>{value}</Text> : value}
      </View>
      <HugeiconsIcon color={colors.dim} icon={ArrowRight01Icon} size={16} strokeWidth={1.7} />
      {last ? null : <View style={styles.line} />}
    </Pressable>
  )
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  header: { width: '100%', maxWidth: 760, minHeight: 60, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.lg, paddingTop: spacing.xs },
  gone: { color: colors.muted, fontFamily: fonts.sans, fontSize: 15, padding: spacing.lg },
  page: { width: '100%', maxWidth: 760, alignSelf: 'center', gap: spacing.xl, paddingHorizontal: spacing.lg, paddingTop: spacing.sm, paddingBottom: 48 },
  identity: { alignItems: 'center', gap: spacing.md },
  nameLine: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', alignItems: 'baseline', columnGap: spacing.sm },
  name: { color: colors.text, fontFamily: fonts.display, fontSize: 24, letterSpacing: -0.5 },
  role: { color: colors.muted, fontFamily: fonts.display, fontSize: 24, letterSpacing: -0.5 },
  fields: { gap: spacing.sm },
  // The grouped list of the runtime sheet, on the page instead of in a sheet.
  group: { overflow: 'hidden', borderRadius: radius.panel, ...squircle, backgroundColor: colors.sheetSurface },
  row: { minHeight: 56, flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg },
  rowPressed: { backgroundColor: colors.sheetPressed },
  label: { color: colors.text, fontFamily: fonts.sans, fontSize: 16 },
  input: {
    flex: 1,
    minHeight: 56,
    color: colors.text,
    fontFamily: fonts.sans,
    fontSize: 16,
    letterSpacing: tracking.body,
    textAlign: 'right',
  },
  valueSlot: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 5 },
  value: { flexShrink: 1, color: colors.muted, fontFamily: fonts.sans, fontSize: 15 },
  line: { position: 'absolute', right: spacing.lg, bottom: 0, left: spacing.lg, height: StyleSheet.hairlineWidth, backgroundColor: colors.line },
  error: { color: colors.danger, fontFamily: fonts.sans, fontSize: 13, lineHeight: 18, paddingHorizontal: spacing.xs },
  disabled: { opacity: 0.5 },
})
