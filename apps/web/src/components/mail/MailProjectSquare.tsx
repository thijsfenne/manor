import { accentStyle } from '../../accent'

/** The square that stands for a linked project. With `named` it carries the name on hover. */
export function MailProjectSquare({ name, color, named = false }: { name: string; color: string; named?: boolean }) {
  return (
    <span className="size-2 flex-none rounded-xs bg-[var(--accent)]" style={accentStyle(color)}
      {...(named ? { title: name, role: 'img', 'aria-label': name } : { 'aria-hidden': true })} />
  )
}
