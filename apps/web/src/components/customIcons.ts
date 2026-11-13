import type { IconSvgElement } from '@hugeicons/react'

/**
 * Glyphs drawn for Manor, in the HugeIcons data shape so they render through
 * `Icon` with the same size, colour and stroke as every library glyph.
 */

/**
 * A round head glancing right: the Agents door and panel. Scaled up
 * from the r=9.25 original to the library's r=10 circle, so it reads as large as
 * the globe beside it.
 */
export const AiBotHeadLookingIcon: IconSvgElement = [
  ['circle', { cx: '12', cy: '12', r: '10', stroke: 'currentColor', strokeWidth: '1.5', key: '0' }],
  ['path', { d: 'M11.2 9.3V12.55', stroke: 'currentColor', strokeLinecap: 'round', strokeWidth: '1.5', key: '1' }],
  ['path', { d: 'M16.05 9.3V12.55', stroke: 'currentColor', strokeLinecap: 'round', strokeWidth: '1.5', key: '2' }],
]

/** The same head filled, for the Agents door while it is the current one. */
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

/**
 * Two rings, each with a line: the Session door on the right rail, for every Session
 * (Single or Multiple, with or without a repository).
 */
export const SessionListIcon: IconSvgElement = [
  ['circle', { cx: '6.25', cy: '8.2', r: '2.5', stroke: 'currentColor', strokeWidth: '1.5', key: '0' }],
  ['circle', { cx: '6.25', cy: '15.8', r: '2.5', stroke: 'currentColor', strokeWidth: '1.5', key: '1' }],
  ['path', { d: 'M12.5 8.2H20.75', stroke: 'currentColor', strokeLinecap: 'round', strokeWidth: '1.5', key: '2' }],
  ['path', { d: 'M12.5 15.8H20.75', stroke: 'currentColor', strokeLinecap: 'round', strokeWidth: '1.5', key: '3' }],
]

/** The same list filled, while the Session panel is open. */
export const SessionListSolidIcon: IconSvgElement = [
  ['circle', { cx: '6.25', cy: '8.2', r: '3.25', fill: 'currentColor', key: '0' }],
  ['circle', { cx: '6.25', cy: '15.8', r: '3.25', fill: 'currentColor', key: '1' }],
  ['rect', { x: '12.5', y: '7.45', width: '8.25', height: '1.5', rx: '0.75', fill: 'currentColor', key: '2' }],
  ['rect', { x: '12.5', y: '15.05', width: '8.25', height: '1.5', rx: '0.75', fill: 'currentColor', key: '3' }],
]

/** The Agents head with a plus at its open corner: the New agent act. */
export const AddAgentIcon: IconSvgElement = [
  ['path', { d: 'M12 21.25C6.89137 21.25 2.75 17.1086 2.75 12C2.75 6.89137 6.89137 2.75 12 2.75C17.1086 2.75 21.25 6.89137 21.25 12', stroke: 'currentColor', strokeLinecap: 'round', strokeWidth: '1.5', key: '0' }],
  ['path', { d: 'M11.25 9.5V12.5', stroke: 'currentColor', strokeLinecap: 'round', strokeWidth: '1.5', key: '1' }],
  ['path', { d: 'M15.75 9.5V12.5', stroke: 'currentColor', strokeLinecap: 'round', strokeWidth: '1.5', key: '2' }],
  ['path', { d: 'M18 15V21M15 18H21', stroke: 'currentColor', strokeLinecap: 'round', strokeLinejoin: 'round', strokeWidth: '1.5', key: '3' }],
]
