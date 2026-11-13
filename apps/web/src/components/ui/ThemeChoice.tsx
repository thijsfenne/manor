import { ComputerIcon, Moon02Icon, Sun03Icon } from '@hugeicons/core-free-icons'
import type { ThemeChoice as Choice } from '../../useTheme'
import { Icon } from '../Icon'
import { SegmentedControl } from './SegmentedControl'

/** The three choices in the order every theme control shows them. */
export const THEME_CHOICES = [
  { value: 'light', label: 'Light', icon: Sun03Icon },
  { value: 'dark', label: 'Dark', icon: Moon02Icon },
  { value: 'system', label: 'System', icon: ComputerIcon },
] as const

/**
 * The three theme states side by side, so the one in force and the other two are all
 * visible. `icons` for the account popover, where the row's label already says Theme;
 * `labels` where the control stands on its own.
 */
export function ThemeChoice({ choice, show = 'labels', onChange }: {
  choice: Choice
  show?: 'icons' | 'labels'
  onChange: (choice: Choice) => void
}) {
  return (
    <SegmentedControl
      label="Theme"
      variant="symbols"
      compact
      value={choice}
      onChange={onChange}
      options={THEME_CHOICES.map((option) => ({
        value: option.value,
        label: option.label,
        symbol: show === 'icons' ? (
          <Icon icon={option.icon} size={15} />
        ) : (
          <span className="flex items-center gap-1.5 px-1">
            <Icon icon={option.icon} size={14} />
            {option.label}
          </span>
        ),
      }))}
    />
  )
}
