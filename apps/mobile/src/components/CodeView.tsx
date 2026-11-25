import { highlight, type Token } from '@manor/client-runtime/highlight'
import { useMemo } from 'react'
import { FlatList, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native'

import { useScrimScroll } from '@/components/EdgeScrim'
import { Text } from '@/components/Text'
import { colors, fonts, spacing, syntax } from '@/theme'

/** Past this many lines the colourer is skipped: a generated file is scrolled, not read. */
const HIGHLIGHT_UP_TO = 4000
const FONT_SIZE = 12
const LINE_HEIGHT = 18
/** SF Mono at 12pt, near enough to size the row to the longest line. */
const CHAR_WIDTH = 7.25
const GUTTER = 44

/**
 * A file's text, coloured by kind and numbered by line, in a list that scrolls both
 * ways. One row per line rather than one text for the file: a phone reads a
 * thousand-line file a screen at a time, and a single text of that many spans is
 * a single layout of that many spans.
 */
export function CodeView({ code, language }: { code: string; language: string }) {
  const { width } = useWindowDimensions()
  const lines = useMemo(
    () => (code.split('\n').length > HIGHLIGHT_UP_TO ? highlight(code, 'plain') : highlight(code, language)),
    [code, language],
  )
  const longest = useMemo(() => lines.reduce((max, line) => Math.max(max, line.reduce((n, token) => n + token.text.length, 0)), 0), [lines])
  const rowWidth = Math.max(width - spacing.lg * 2, GUTTER + longest * CHAR_WIDTH + spacing.xl)
  const digits = String(lines.length).length
  // The page scrolls sideways under the header too; only the lines pad clear of it.
  const scroll = useScrimScroll(styles.list)

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={[styles.host, scroll.style]}>
      <FlatList
        contentContainerStyle={scroll.contentContainerStyle}
        scrollIndicatorInsets={scroll.scrollIndicatorInsets}
        data={lines}
        getItemLayout={(_, index) => ({ length: LINE_HEIGHT, offset: LINE_HEIGHT * index, index })}
        initialNumToRender={48}
        keyExtractor={(_, index) => String(index)}
        renderItem={({ item, index }) => <Line digits={digits} number={index + 1} tokens={item} />}
        style={{ width: rowWidth }}
        windowSize={7}
      />
    </ScrollView>
  )
}

function Line({ tokens, number, digits }: { tokens: Token[]; number: number; digits: number }) {
  return (
    <View style={styles.line}>
      <Text style={[styles.number, { width: GUTTER - spacing.sm, minWidth: digits * CHAR_WIDTH + spacing.sm }]}>{number}</Text>
      <Text selectable style={styles.code}>
        {tokens.length === 0 ? ' ' : tokens.map((token, index) => (
          <Text key={index} style={{ color: syntax[token.kind] }}>{token.text}</Text>
        ))}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  host: { flex: 1 },
  list: { paddingBottom: spacing.xxl, paddingTop: spacing.xs },
  line: { height: LINE_HEIGHT, flexDirection: 'row', alignItems: 'flex-start', paddingLeft: spacing.lg },
  number: { color: colors.dim, fontFamily: fonts.mono, fontSize: 11, lineHeight: LINE_HEIGHT, textAlign: 'right', paddingRight: spacing.sm, fontVariant: ['tabular-nums'] },
  code: { color: colors.text, fontFamily: fonts.mono, fontSize: FONT_SIZE, lineHeight: LINE_HEIGHT },
})
