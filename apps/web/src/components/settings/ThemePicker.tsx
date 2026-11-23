import { useRef, type CSSProperties, type KeyboardEvent } from 'react'
import { Moon02Icon, Sun03Icon } from '@hugeicons/core-free-icons'
import type { ColorTheme } from '@manor/contracts'
import { COLOR_THEME_IDS, COLOR_THEMES, type Mode, type ThemePair } from '../../colorThemes'
import type { ThemeChoice as Choice } from '../../useTheme'
import { Icon } from '../Icon'
import { THEME_CHOICES } from '../ui/ThemeChoice'

/** The mode cards in the order the design shows them: the deferral first. */
const MODE_CARDS = [...THEME_CHOICES.filter((option) => option.value === 'system'), ...THEME_CHOICES.filter((option) => option.value !== 'system')]

/**
 * Manor in miniature, in one theme's side: the sidebar on the left, a few clouds and
 * the composer on the canvas. A card shows its own theme whichever is on screen, so it
 * reads the palette rather than the tokens. Proportions only, so it scales with the card.
 */
function Miniature({ theme, mode }: { theme: ColorTheme; mode: Mode }) {
  const p = COLOR_THEMES[theme][mode]
  const colours = {
    '--preview-sidebar': p.sidebar,
    '--preview-canvas': p.surface,
    '--preview-bubble': p.bubble,
    '--preview-own': p.userBubble,
    '--preview-composer': p.composer,
    '--preview-line': p.line,
  } as CSSProperties
  return (
    <div aria-hidden="true" style={colours} className="absolute inset-0 rounded-[inherit] border border-(--preview-line) bg-(--preview-sidebar)">
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

/** System is both: the light theme on the left half, the dark one on the right. */
function Preview({ choice, themes }: { choice: Choice; themes: ThemePair }) {
  if (choice !== 'system') return <Miniature theme={themes[choice]} mode={choice} />
  return (
    <>
      <Miniature theme={themes.light} mode="light" />
      <div className="absolute inset-0 rounded-[inherit] [clip-path:inset(0_0_0_50%)]">
        <Miniature theme={themes.dark} mode="dark" />
      </div>
    </>
  )
}

/**
 * The mode as three cards, each a small Manor in the themes picked below.
 * One radio group: Tab lands on the chosen card and the arrows move the choice.
 */
export function ModePicker({ choice, themes, onChange }: { choice: Choice; themes: ThemePair; onChange: (choice: Choice) => void }) {
  const cards = useRef<Array<HTMLButtonElement | null>>([])
  const at = MODE_CARDS.findIndex((option) => option.value === choice)

  const move = (event: KeyboardEvent<HTMLButtonElement>) => {
    const last = MODE_CARDS.length - 1
    const next =
      event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (at + 1) % MODE_CARDS.length
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (at - 1 + MODE_CARDS.length) % MODE_CARDS.length
          : event.key === 'Home' ? 0
            : event.key === 'End' ? last
              : undefined
    const option = next === undefined ? undefined : MODE_CARDS[next]
    if (next === undefined || option === undefined) return
    event.preventDefault()
    onChange(option.value)
    cards.current[next]?.focus()
  }

  return (
    <div role="radiogroup" aria-label="Mode" className="grid w-full grid-cols-3 gap-3">
      {MODE_CARDS.map((option, index) => {
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
                <Preview choice={option.value} themes={themes} />
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

const MODE_ICON = { light: Sun03Icon, dark: Moon02Icon } as const

/** One side of a theme as a round swatch: its own bubble fading into its accent. */
function Orb({ theme, mode, selected, onPick }: { theme: ColorTheme; mode: Mode; selected: boolean; onPick: () => void }) {
  const { userBubble: from, accent: to } = COLOR_THEMES[theme][mode]
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={`${COLOR_THEMES[theme].label} for ${mode} mode`}
      title={`${COLOR_THEMES[theme].label} ${mode}`}
      style={{ backgroundImage: `radial-gradient(circle at 32% 30%, ${from} 0%, ${from} 30%, ${to} 100%)` }}
      className={`relative size-13 shrink-0 cursor-pointer rounded-full border-0 p-0 outline-none transition-shadow duration-150 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary motion-reduce:transition-none ${
        selected ? 'ring-2 ring-text ring-offset-2 ring-offset-bg' : 'ring-1 ring-line hover:ring-text/25 hover:ring-2'
      }`}
      onClick={onPick}
    >
      {selected ? (
        <span className="absolute -right-1 -bottom-1 grid size-[18px] place-items-center rounded-full bg-raised text-text ring-1 ring-line">
          <Icon icon={MODE_ICON[mode]} size={11} />
        </span>
      ) : null}
    </button>
  )
}

/**
 * Every theme as a card with its two sides. The left orb picks the theme for light
 * mode, the right one for dark, so the two may come from different themes.
 */
export function ThemeGrid({ themes, onChange }: { themes: ThemePair; onChange: (themes: ThemePair) => void }) {
  return (
    <div className="grid w-full grid-cols-[repeat(auto-fill,minmax(max(9.5rem,calc((100%-1.5rem)/3)),1fr))] gap-3">
      {COLOR_THEME_IDS.map((theme) => (
        <div key={theme} className="flex min-w-0 flex-col items-center gap-2.5 rounded-xl border border-line px-3 pt-3.5 pb-2.5">
          <div className="flex justify-center gap-4">
            {(['light', 'dark'] as const).map((mode) => (
              <Orb
                key={mode}
                theme={theme}
                mode={mode}
                selected={themes[mode] === theme}
                onPick={() => {
                  if (themes[mode] !== theme) onChange({ ...themes, [mode]: theme })
                }}
              />
            ))}
          </div>
          <div className="flex min-w-0 flex-col items-center text-center">
            <span className="text-[14px] leading-snug font-medium text-text">{COLOR_THEMES[theme].label}</span>
            <span className="text-label text-muted">{COLOR_THEMES[theme].description}</span>
          </div>
        </div>
      ))}
    </div>
  )
}
