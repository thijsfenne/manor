import type { CSSProperties } from 'react'

/** Feeds a persona's hex into CSS as --accent; every persona-tinted rule reads that var. */
export const accentStyle = (color: string) => ({ '--accent': color }) as CSSProperties

// Shared with the native client, which needs the same hue for the same face.
export { accentHue } from '@manor/client-runtime/accent-hue'
