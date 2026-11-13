import { useRef, type KeyboardEvent } from 'react'
import type { Theme, ThemeChoice as Choice } from '../../useTheme'
import { THEME_CHOICES } from '../ui/ThemeChoice'

/**
 * Manor in miniature: the sidebar on the left, a few clouds and the composer on the
 * canvas. Proportions only, so the drawing scales with the card.
 */
function Miniature({ theme }: { theme: Theme }) {
  return (
    <div aria-hidden="true" className={`absolute inset-0 rounded-[inherit] border border-(--preview-line) bg-(--preview-sidebar) ${theme === 'dark' ? 'theme-preview-dark' : 'theme-preview-light'}`}>
      <div className="absolute top-[16%] left-[7%] flex w-[17%] flex-col gap-2">
        <div className="h-1 w-full rounded-full bg-(--preview-own)" />
        <div className="h-1 w-3/4 rounded-full bg-(--preview-own)" />
        <div className="h-1 w-5/6 rounded-full bg-(--preview-own)" />
      </div>
      <div className="absolute inset-y-0 right-0 left-[31%] border-l border-(--preview-line) bg-(--preview-canvas)">
        <div className="absolute top-[13%] left-[10%] h-[13%] w-1/2 rounded-md bg-(--preview-bubble)" />
        <div className="absolute top-[32%] right-[10%] h-[13%] w-[42%] rounded-md bg-(--preview-own)" />
        <div className="absolute top-[51%] left-[10%] h-[13%] w-[46%] rounded-md bg-(--preview-bubble)" />
        <div className="absolute inset-x-[8%] bottom-[9%] h-[15%] rounded-lg border border-(--preview-line) bg-(--preview-composer)" />
      </div>
    </div>
  )
}

/** System is both: light on the left half, dark on the right, one window across the split. */
function Preview({ choice }: { choice: Choice }) {
  if (choice !== 'system') return <Miniature theme={choice} />
  return (
    <>
      <Miniature theme="light" />
      <div className="absolute inset-0 rounded-[inherit] [clip-path:inset(0_0_0_50%)]">
        <Miniature theme="dark" />
      </div>
    </>
  )
}

/**
 * The theme as three cards, each a small Manor in that theme, for the Appearance page.
 * One radio group: Tab lands on the chosen card and the arrows move the choice.
 */
export function ThemePicker({ choice, onChange }: { choice: Choice; onChange: (choice: Choice) => void }) {
  const cards = useRef<Array<HTMLButtonElement | null>>([])
  const at = THEME_CHOICES.findIndex((option) => option.value === choice)

  const move = (event: KeyboardEvent<HTMLButtonElement>) => {
    const last = THEME_CHOICES.length - 1
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (at + 1) % THEME_CHOICES.length
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (at - 1 + THEME_CHOICES.length) % THEME_CHOICES.length
          : event.key === 'Home' ? 0
            : event.key === 'End' ? last
              : undefined
    const option = next === undefined ? undefined : THEME_CHOICES[next]
    if (next === undefined || option === undefined) return
    event.preventDefault()
    onChange(option.value)
    cards.current[next]?.focus()
  }

  return (
    <div role="radiogroup" aria-label="Theme" className="grid w-full grid-cols-3 gap-3">
      {THEME_CHOICES.map((option, index) => {
        const selected = option.value === choice
        return (
          <button
            key={option.value}
            ref={(node) => {
              cards.current[index] = node
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className="group flex min-w-0 cursor-pointer flex-col items-center gap-1.5 border-0 bg-transparent p-0 outline-none"
            onClick={() => onChange(option.value)}
            onKeyDown={move}
          >
            <span
              className={`block w-full rounded-xl border-2 p-[3px] transition-colors duration-150 group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-primary motion-reduce:transition-none ${
                selected ? 'border-text' : 'border-transparent group-hover:border-text/25'
              }`}
            >
              <span className="relative block aspect-[10/7] w-full overflow-hidden rounded-lg">
                <Preview choice={option.value} />
              </span>
            </span>
            <span className={`text-[14px] leading-snug ${selected ? 'font-medium text-text' : 'text-muted group-hover:text-text'}`}>
              {option.label}
            </span>
          </button>
        )
      })}
    </div>
  )
}
