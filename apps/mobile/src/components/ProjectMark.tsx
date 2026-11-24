import { HugeiconsIcon } from '@hugeicons/react-native'
import type { ProjectIcon } from '@manor/contracts'
import { isTileRepoIcon, projectIcon, projectTileRadius, repoIconInset, repoTileRadius } from '@manor/client-runtime/project-icons'
import { Image } from 'expo-image'
import { useState } from 'react'
import { View } from 'react-native'
import { Text } from '@/components/Text'
import { serverMediaUri } from '@/lib/connection'

/**
 * A project's icon wherever the phone draws one: its repo icon at the glyph's size and
 * untinted, with rounded corners only when it fills its square and its empty margin cropped,
 * its letters on a tile of its colour, or its glyph in the project's colour. A file deleted from the repo answers
 * 404 and the glyph takes its place.
 */
export function ProjectMark({ icon, color, src, letters, size, strokeWidth = 1.8 }: {
  icon: ProjectIcon
  color: string
  /** `Project.repoIconSrc`; the glyph stands in when absent, unreachable or failing to load. */
  src?: string | undefined
  /** `markLetters` of the project, drawn on a tile of its colour in place of the glyph. */
  letters?: string | undefined
  size: number
  strokeWidth?: number
}) {
  const [failed, setFailed] = useState<string | null>(null)
  const uri = src === undefined ? undefined : serverMediaUri(src)
  if (src !== undefined && uri !== undefined && failed !== uri) {
    const tile = isTileRepoIcon(src)
    const inset = repoIconInset(src)
    const image = (
      <Image
        accessibilityIgnoresInvertColors
        // The server answers `no-cache` with an ETag, so a changed favicon shows on the next load.
        cachePolicy="memory"
        contentFit={tile ? 'cover' : 'contain'}
        onError={() => setFailed(uri)}
        source={{ uri }}
        style={{ width: size, height: size, borderRadius: tile ? projectTileRadius(size, repoTileRadius(src)) : 0, ...(inset > 0 ? { transform: [{ scale: 1 / (1 - 2 * inset) }] } : {}) }}
      />
    )
    // Grown past its box by the margin, which the box then cuts off.
    return inset > 0 ? <View style={{ width: size, height: size, overflow: 'hidden' }}>{image}</View> : image
  }
  if (letters !== undefined && letters !== '') {
    return (
      <View style={{ width: size, height: size, borderRadius: projectTileRadius(size), backgroundColor: `${color}2E`, alignItems: 'center', justifyContent: 'center' }}>
        <Text allowFontScaling={false} style={{ color, fontSize: size * 0.52, fontWeight: '500', letterSpacing: -0.2 }}>{letters}</Text>
      </View>
    )
  }
  return <HugeiconsIcon color={color} icon={projectIcon(icon)} size={size} strokeWidth={strokeWidth} />
}
