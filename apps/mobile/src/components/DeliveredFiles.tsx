import Download04Icon from '@hugeicons/core-free-icons/Download04Icon'
import File01Icon from '@hugeicons/core-free-icons/File01Icon'
import SquareArrowUpRightIcon from '@hugeicons/core-free-icons/SquareArrowUpRightIcon'
import { HugeiconsIcon } from '@hugeicons/react-native'
import type { DeliveredFile } from '@manor/contracts'
import { describeBytes } from '@manor/client-runtime/attachments'
import { Directory, File, Paths } from 'expo-file-system'
import * as WebBrowser from 'expo-web-browser'
import { useState } from 'react'
import { Pressable, Share, StyleSheet, View } from 'react-native'

import { Text } from '@/components/Text'
import { colors, fonts, radius, spacing, squircle } from '@/theme'

const GONE = 'This file is no longer available in Manor.'
const UNREACHABLE = 'Manor cannot be reached right now. Try again once the connection is back.'

/**
 * Files a persona handed over, under the answer of the turn that made them. Open
 * shows the file in the in-app browser, which previews PDFs, Office files and images;
 * Save downloads a copy and hands it to the share sheet, where “Save to Files”
 * lives.
 */
export function DeliveredFiles({ files }: { files: readonly DeliveredFile[] }) {
  if (files.length === 0) return null
  return (
    <View style={styles.stack}>
      {files.map((file) => <DeliveredFileRow file={file} key={file.id} />)}
    </View>
  )
}

function DeliveredFileRow({ file }: { file: DeliveredFile }) {
  const [busy, setBusy] = useState<'open' | 'save' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const src = file.src

  const run = async (action: 'open' | 'save') => {
    if (src === undefined || busy !== null) return
    setBusy(action)
    setError(null)
    try {
      if (action === 'open') {
        // A cheap probe first: the in-app browser would otherwise show a bare 404 page.
        const probe = await fetch(src, { method: 'HEAD' }).catch(() => undefined)
        if (probe === undefined) return setError(UNREACHABLE)
        if (!probe.ok) return setError(probe.status === 404 ? GONE : `Manor could not fetch the file (HTTP ${probe.status}).`)
        await WebBrowser.openBrowserAsync(src)
        return
      }
      const folder = new Directory(Paths.cache, 'manor-files', file.id)
      folder.create({ intermediates: true, idempotent: true })
      const saved = await File.downloadFileAsync(src, new File(folder, file.name), { idempotent: true })
      await Share.share({ url: saved.uri })
    } catch (failure: unknown) {
      const message = failure instanceof Error ? failure.message : ''
      setError(/\b404\b/.test(message) ? GONE : /\b\d{3}\b/.test(message) ? 'Manor could not fetch the file.' : UNREACHABLE)
    } finally {
      setBusy(null)
    }
  }

  return (
    <View style={styles.row}>
      <View style={styles.card}>
        <HugeiconsIcon color={colors.muted} icon={File01Icon} size={16} strokeWidth={1.7} />
        <View style={styles.label}>
          <Text numberOfLines={1} style={styles.name}>{file.name}</Text>
          <Text style={styles.size}>{describeBytes(file.size)}</Text>
        </View>
        <Action busy={busy === 'open'} disabled={src === undefined || busy !== null} icon={SquareArrowUpRightIcon} label="Open" onPress={() => void run('open')} />
        <Action busy={busy === 'save'} disabled={src === undefined || busy !== null} icon={Download04Icon} label="Save" onPress={() => void run('save')} />
      </View>
      {error === null ? null : <Text accessibilityRole="alert" style={styles.error}>{error}</Text>}
    </View>
  )
}

function Action({ label, icon, busy, disabled, onPress }: { label: string; icon: typeof File01Icon; busy: boolean; disabled: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      accessibilityState={{ busy, disabled }}
      disabled={disabled}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [styles.action, pressed && styles.pressed, disabled && !busy && styles.disabled]}
    >
      <HugeiconsIcon color={colors.muted} icon={icon} size={15} strokeWidth={1.7} />
      <Text style={styles.actionText}>{busy ? '…' : label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  stack: { gap: spacing.sm },
  row: { gap: spacing.xs },
  card: {
    alignItems: 'center',
    backgroundColor: colors.chip,
    borderRadius: radius.md,
    ...squircle,
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  label: { flex: 1, minWidth: 0 },
  name: { color: colors.text, fontFamily: fonts.sans, fontSize: 14 },
  size: { color: colors.dim, fontFamily: fonts.sans, fontSize: 11 },
  action: { alignItems: 'center', flexDirection: 'row', gap: 4, paddingHorizontal: 6, paddingVertical: 4 },
  actionText: { color: colors.muted, fontFamily: fonts.sans, fontSize: 13 },
  pressed: { opacity: 0.7 },
  disabled: { opacity: 0.5 },
  error: { color: colors.warning, fontFamily: fonts.sans, fontSize: 12, paddingHorizontal: spacing.sm },
})
