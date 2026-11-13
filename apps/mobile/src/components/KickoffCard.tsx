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
const CLOSED_HEIGHT = CLOSED_LINES * LINE
/** The Mac's fade depth for a cut this short: 0.4 of the kept lines, at most 2.6. */
const FADE_HEIGHT = Math.min(2.6, CLOSED_LINES * 0.4) * LINE
/** Where the fade starts and each of its stops sits, as fractions of the closed box. */
const FADE_START = 1 - FADE_HEIGHT / CLOSED_HEIGHT
const FADE_LOCATIONS = clampFade.stops.map((stop) => FADE_START + stop * (1 - FADE_START)) as [number, number, ...number[]]

/**
 * A Session's brief, or a DM brief handed to the project thread, folded to its opening
 * lines so the thread starts on the work.
 * The header already names the project, so the card carries only the brief. Folded, its
 * last lines dissolve into the card through a mask on the text itself, as on the Mac,
 * and Show more sits on that faded tail rather than under it.
 */
export function KickoffCard({ text, agents, images = [], files = [] }: { text: string; agents: AgentConfig[]; images?: EventImage[]; files?: FileAttachment[] }) {
  const [open, setOpen] = useState(false)
  const [height, setHeight] = useState(0)
  const clipped = height > CLOSED_HEIGHT + 1
  const folded = clipped && !open
  // A still ScrollView reports its content's full height even while the viewport is
  // cut, which a View inside a maxHeight parent does not.
  const body = (
    <ScrollView
      scrollEnabled={false}
      style={open ? undefined : styles.closed}
      onContentSizeChange={(_, contentHeight) => setHeight(contentHeight)}
    >
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
            maskElement={<LinearGradient colors={clampFade.colors} locations={FADE_LOCATIONS} style={StyleSheet.absoluteFill} />}
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
  closed: { maxHeight: CLOSED_HEIGHT },
  toggle: { alignSelf: 'flex-end', marginTop: spacing.sm },
  // The Mac's link target: the last 1.6 lines of the cut, text aligned to its foot.
  toggleOver: { position: 'absolute', right: 0, bottom: 0, height: 1.6 * LINE, justifyContent: 'flex-end' },
  toggleLabel: { color: colors.text, fontFamily: fonts.sans, fontSize: 14, fontWeight: '500' },
})
