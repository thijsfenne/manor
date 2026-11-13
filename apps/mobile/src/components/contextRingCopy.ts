import type { ContextFigureRead } from '@manor/client-runtime/context-meter'

/**
 * How a figure got its number, as a word rather than a colour alone. Measured is the
 * provider's own reading, estimated is Manor's arithmetic, not reported is a
 * driver that says nothing and must never read as a zero.
 */
export const SOURCE_WORD = {
  measured: 'measured',
  estimated: 'estimated',
  unknown: 'not reported',
} as const

export const sourceWord = (figure: ContextFigureRead | undefined): string | null =>
  figure === undefined ? null : SOURCE_WORD[figure.source]

/**
 * Three different sentences on purpose. A driver that reports no fill is named as
 * such; a reading that exists is shown against the window it was read with.
 */
export function usageCopy(
  meter: { percent: number; usedLabel: string | null; limitLabel: string },
  used: ContextFigureRead | undefined,
): string {
  if (meter.usedLabel !== null) return `${meter.percent}% · ${meter.usedLabel}/${meter.limitLabel}`
  return used?.source === 'unknown' ? 'This provider reports no fill' : 'Not reported yet'
}

/**
 * The figure's own number, never the client's catalog value: after a runtime switch
 * the catalog moves and the server's mark would describe someone else's window.
 */
export const windowCopy = (
  meter: { windowLabel: string },
  window: ContextFigureRead | undefined,
): string => `Model window: ${window?.tokens ?? meter.windowLabel} tokens`

/**
 * The dial divides by this threshold rather than by the model window, so the sentence
 * says so when it does: the percent is the distance to a compact that really happens.
 */
export const compactCopy = (
  autoCompactAt: ContextFigureRead | undefined,
  limitIsCompact = false,
): string =>
  autoCompactAt === undefined || autoCompactAt.tokens === null
    ? 'Compacts automatically when needed.'
    : limitIsCompact
      ? `Compacts at ${autoCompactAt.tokens} tokens, which the ring measures against.`
      : `Compacts at ${autoCompactAt.tokens} tokens.`
