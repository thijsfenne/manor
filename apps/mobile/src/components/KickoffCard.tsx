import { StyleSheet, View } from 'react-native'
import type { AgentConfig, EventImage, FileAttachment } from '@manor/contracts'
import { Attachments } from './Attachments'
import { FoldedBody } from './FoldedBody'
import { colors, fonts, radius, spacing, squircle } from '@/theme'
import { Markdown } from './Markdown'
import { Text } from './Text'

/** One body line at the small reading size. */
const LINE = 22
/** Five lines, the same cut the Mac's kickoff card makes. */
const CLOSED_LINES = 5
/** Lines a helper's role adds to the fold, so the task keeps its own five under it. */
const ROLE_LINES = 3

/**
 * A Session's brief, or a DM brief handed to the project thread, folded to its opening
 * lines so the thread starts on the work.
 * The header already names the project, so the card carries only the brief. Folded, its
 * last lines dissolve into the card through a mask on the text itself, as on the Mac,
 * and Show more sits on that faded tail rather than under it.
 */
export function KickoffCard({ text, agents, images = [], files = [], role }: { text: string; agents: AgentConfig[]; images?: EventImage[]; files?: FileAttachment[]; role?: string | undefined }) {
  return (
    <View style={styles.card}>
      <Attachments images={images} files={files} size={52} />
      <FoldedBody lineHeight={LINE} lines={role === undefined ? CLOSED_LINES : CLOSED_LINES + ROLE_LINES}>
        {/* A helper's role leads its task inside the fold, so a folded card shows both. */}
        {role === undefined ? null : (
          <>
            <Text style={styles.role}>{role}</Text>
            <View style={styles.divider} />
          </>
        )}
        <Markdown agents={agents} small text={text} />
      </FoldedBody>
    </View>
  )
}

const styles = StyleSheet.create({
  card: { gap: spacing.sm, borderRadius: radius.lg, ...squircle, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.line, backgroundColor: colors.surface, paddingHorizontal: spacing.md, paddingVertical: spacing.md },
  role: { color: colors.muted, fontFamily: fonts.sans, fontSize: 15, lineHeight: LINE },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: spacing.sm, backgroundColor: colors.line },
})
