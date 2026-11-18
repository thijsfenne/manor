import MaskedView from '@react-native-masked-view/masked-view'
import { LinearGradient } from 'expo-linear-gradient'
import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, View } from 'react-native'
import type { AgentConfig, EventImage, FileAttachment } from '@manor/contracts'
import { Attachments } from './Attachments'
import { clampFade, colors, fonts, radius, spacing, squircle } from '@/theme'
import { Markdown } from './Markdown'
import { Text } from './Text'

/** One body line at the small reading size. */
const LINE = 22
/** Five lines, the same cut the Mac's kickoff card makes. */
const CLOSED_LINES = 5
/** Lines a helper's role adds to the fold, so the task keeps its own five under it. */
const ROLE_LINES = 3

/** The fold's height and its fade for a cut of `lines`: the Mac's fade depth is 0.4 of the kept lines, at most 2.6. */
function foldFor(lines: number) {
  const height = lines * LINE
  const fadeHeight = Math.min(2.6, lines * 0.4) * LINE
  const start = 1 - fadeHeight / height
  return { height, locations: clampFade.stops.map((stop) => start + stop * (1 - start)) as [number, number, ...number[]] }
}
const FOLD = foldFor(CLOSED_LINES)
const FOLD_WITH_ROLE = foldFor(CLOSED_LINES + ROLE_LINES)

/**
 * A Session's brief, or a DM brief handed to the project thread, folded to its opening
 * lines so the thread starts on the work.
 * The header already names the project, so the card carries only the brief. Folded, its
 * last lines dissolve into the card through a mask on the text itself, as on the Mac,
 * and Show more sits on that faded tail rather than under it.
 */
export function KickoffCard({ text, agents, images = [], files = [], role }: { text: string; agents: AgentConfig[]; images?: EventImage[]; files?: FileAttachment[]; role?: string | undefined }) {
  const [open, setOpen] = useState(false)
  const [height, setHeight] = useState(0)
  const fold = role === undefined ? FOLD : FOLD_WITH_ROLE
  const clipped = height > fold.height + 1
  const folded = clipped && !open
  // A still ScrollView reports its content's full height even while the viewport is
  // cut, which a View inside a maxHeight parent does not.
  const body = (
    <ScrollView
      scrollEnabled={false}
      style={open ? undefined : { maxHeight: fold.height }}
      onContentSizeChange={(_, contentHeight) => setHeight(contentHeight)}
    >
      {/* A helper's role leads its task inside the fold, so a folded card shows both. */}
      {role === undefined ? null : (
        <>
          <Text style={styles.role}>{role}</Text>
          <View style={styles.divider} />
        </>
      )}
      <Markdown agents={agents} small text={text} />
    </ScrollView>
  )
  const toggle = clipped ? (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      hitSlop={8}
      onPress={() => setOpen((current) => !current)}
      style={folded ? styles.toggleOver : styles.toggle}
    >
      <Text style={styles.toggleLabel}>{open ? 'Show less' : 'Show more'}</Text>
    </Pressable>
  ) : null
  return (
    <View style={styles.card}>
      <Attachments images={images} files={files} size={52} />
      <View>
        {folded ? (
          <MaskedView
            maskElement={<LinearGradient colors={clampFade.colors} locations={fold.locations} style={StyleSheet.absoluteFill} />}
          >
            {body}
          </MaskedView>
        ) : body}
        {toggle}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  card: { gap: spacing.sm, borderRadius: radius.lg, ...squircle, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.surface, paddingHorizontal: spacing.md, paddingVertical: spacing.md },
  role: { color: colors.muted, fontFamily: fonts.sans, fontSize: 15, lineHeight: LINE },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: spacing.sm, backgroundColor: colors.line },
  toggle: { alignSelf: 'flex-end', marginTop: spacing.sm },
  // The Mac's link target: the last 1.6 lines of the cut, text aligned to its foot.
  toggleOver: { position: 'absolute', right: 0, bottom: 0, height: 1.6 * LINE, justifyContent: 'flex-end' },
  toggleLabel: { color: colors.text, fontFamily: fonts.sans, fontSize: 14, fontWeight: '500' },
})
