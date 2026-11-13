import { forwardRef, type ComponentProps } from 'react'
import { Icon } from '../Icon'
import { IconSwap } from './IconSwap'

interface IconButtonProps extends Omit<ComponentProps<'button'>, 'children'> {
  icon: ComponentProps<typeof Icon>['icon']
  iconSize?: number
  /**
   * The box, when the default 32 is too much room around a small mark. A style
   * rather than a class on purpose: `h-8 w-8` is in the base class list, and a
   * caller passing `h-6 w-6` loses to it depending on Tailwind's own ordering, which
   * is how two call sites here silently kept the big square they were trying to
   * shrink.
   */
  size?: number
  label: string
  selected?: boolean
  /**
   * For a button whose mark changes under it: name what the current mark stands for
   * and the two cross-fade in place. Absent, the icon simply switches.
   */
  swapKey?: string
  /**
   * A solid glyph: drawn without the stroke every other icon gets, which would trace its
   * cut-outs shut (a solid check circle became a plain disc).
   */
  solid?: boolean
}

/** The shared square control for actions whose icon already names the act. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton({
  icon,
  iconSize = 15,
  size,
  label,
  selected = false,
  swapKey,
  solid = false,
  className = '',
  style,
  type = 'button',
  ...props
}, ref) {
  return (
    <button
      ref={ref}
      type={type}
      className={`grid h-8 w-8 flex-none cursor-pointer place-items-center rounded-button border-0 [font:inherit] disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted ${
        selected ? 'bg-icon-fill text-text' : 'bg-transparent text-muted hover:bg-icon-fill hover:text-text'
      } ${className}`}
      style={size === undefined ? style : { height: size, width: size, ...style }}
      title={label}
      aria-label={label}
      {...props}
    >
      {swapKey === undefined ? (
        <Icon icon={icon} size={iconSize} {...(solid ? { strokeWidth: 0 } : {})} />
      ) : (
        <IconSwap swapKey={swapKey}>
          <Icon icon={icon} size={iconSize} {...(solid ? { strokeWidth: 0 } : {})} />
        </IconSwap>
      )}
    </button>
  )
})
