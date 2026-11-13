import type { IconSvgElement } from '@hugeicons/react-native'

/**
 * Glyphs the user drew themselves, in the HugeIcons data shape so they render through
 * `HugeiconsIcon` like every library glyph. The phone's copy of the Mac's
 * `apps/web/src/components/customIcons.ts`; change both together.
 */

/** A round head glancing right: the Agents room. */
export const AiBotHeadLookingIcon: IconSvgElement = [
  ['circle', { cx: '12', cy: '12', r: '10', stroke: 'currentColor', strokeWidth: '1.5', key: '0' }],
  ['path', { d: 'M11.2 9.3V12.55', stroke: 'currentColor', strokeLinecap: 'round', strokeWidth: '1.5', key: '1' }],
  ['path', { d: 'M16.05 9.3V12.55', stroke: 'currentColor', strokeLinecap: 'round', strokeWidth: '1.5', key: '2' }],
]

/** The same head filled, for the Agents room while it is the current one. */
export const AiBotHeadLookingSolidIcon: IconSvgElement = [
  [
    'path',
    {
      d: 'M12 2C17.5228 2 22 6.47715 22 12C22 17.5228 17.5228 22 12 22C6.47715 22 2 17.5228 2 12C2 6.47715 6.47715 2 12 2ZM11.25 8.75C10.8358 8.75 10.5 9.08579 10.5 9.5V12.5C10.5 12.9142 10.8358 13.25 11.25 13.25C11.6642 13.25 12 12.9142 12 12.5V9.5C12 9.08579 11.6642 8.75 11.25 8.75ZM15.75 8.75C15.3358 8.75 15 9.08579 15 9.5V12.5C15 12.9142 15.3358 13.25 15.75 13.25C16.1642 13.25 16.5 12.9142 16.5 12.5V9.5C16.5 9.08579 16.1642 8.75 15.75 8.75Z',
      fill: 'currentColor',
      fillRule: 'evenodd',
      clipRule: 'evenodd',
      key: '0',
    },
  ],
]
