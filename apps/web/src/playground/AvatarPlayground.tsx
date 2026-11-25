import { PlayIcon, StopIcon } from '@hugeicons/core-free-icons'
import { palette, traits as seedTraits, type Expression } from '@manor/blobatar'
import { AVATAR_FINISHES, type AvatarFinish } from '@manor/contracts'
import * as poses from '@manor/blobatar/expression'
import { Blobatar } from '@manor/blobatar/react'
import { FACE_LOOK, type FaceState } from '@manor/client-runtime/face-activity'
import { GESTURES, type GestureId } from '@manor/client-runtime/face-gesture'
import { useEffect, useId, useRef, useState } from 'react'
import { accentHue } from '../accent'
import { BLOB_FACE_TRAITS, BLOB_SHAPES, BLOB_TONES, DEFAULT_BLOB_TONE, WORKING_GAZE } from '../blobShapes'
import { ThoughtDots } from '../components/Avatar'
import { Icon } from '../components/Icon'
import { Button } from '../components/ui/Button'
import { FormField, formFieldClass, formHintClass, formInputClass, formLabelClass } from '../components/ui/FormField'
import { Select } from '../components/ui/Select'
import { Switch } from '../components/ui/Switch'
import { BUSY_LOOK, MOVE_IDS, moveInfo, useBusyFace, type BusyLook, type BusyRun } from '../components/busyFace'
import { useFaceEyes, useFaceGesture } from '../components/faceMotion'

type Mode = 'resting' | 'working' | 'busy'

/**
 * Everything one face is drawn from. Plain data, because it is posted into the two
 * theme frames, and nothing in it is ever written back to a persona.
 */
interface Settings {
  name: string
  color: string
  tone: number
  finish: AvatarFinish
  /** A silhouette id, or empty to let the name pick one. */
  shape: string
  size: number
  mode: Mode
  animate: boolean
  /** An export name from `@manor/blobatar/expression`, or `AUTO` for what Manor wears. */
  expression: string
  /** Thought dots above the working face, as the transcript draws them today. */
  dots: boolean
  traits: Record<string, number>
  busy: BusyLook
  /** A body gesture id, or empty for a still body. */
  gesture: string
  /** A face state as a turn asks for it, or empty. It stands in for state, expression and gesture. */
  moment: string
}

const READY = 'avatar-playground:ready'
const AUTO = 'auto'
const SEED = 'Playground'

const EXPRESSIONS = Object.entries(poses).filter(
  (entry): entry is [string, Expression] => typeof entry[1] === 'object' && entry[1] !== null && 'bake' in entry[1],
)

const MODES = [
  { value: 'resting', label: 'Resting' },
  { value: 'working', label: 'Working, reduced motion' },
  { value: 'busy', label: 'Working' },
] as const

/** What the working face can be asked to play: the loop as a turn plays it, each of its moves, and the dots. */
const PLAYS: ReadonlyArray<{ play: BusyLook['play']; label: string; hint: string }> = [
  { play: 'loop', label: 'Loop', hint: 'All eight moves in a shuffled order, as a turn plays them. Another order on every play.' },
  ...MOVE_IDS.map((id) => ({ play: id, label: moveInfo(id).label, hint: `${moveInfo(id).label}, ${moveInfo(id).seconds.toFixed(1)} s.` })),
  { play: 'dots', label: 'Dots', hint: 'The melt into three dots, held while she writes.' },
]

const named = (id: string) => id.charAt(0).toUpperCase() + id.slice(1)
const GESTURE_OPTIONS = [{ value: '', label: 'None' }, ...Object.keys(GESTURES).map((id) => ({ value: id, label: named(id) }))]
const MOMENT_OPTIONS = [{ value: '', label: 'None' }, ...Object.keys(FACE_LOOK).map((id) => ({ value: id, label: named(id) }))]

const FINISHES = AVATAR_FINISHES.map((finish) => ({ value: finish, label: named(finish) }))

const SHAPES = [{ value: '', label: 'From name' }, ...BLOB_SHAPES.map((shape) => ({ value: shape.id, label: shape.label }))]

const EXPRESSION_OPTIONS = [
  { value: AUTO, label: 'Manor default' },
  ...EXPRESSIONS.map(([id]) => ({ value: id, label: id.charAt(0).toUpperCase() + id.slice(1) })),
]

const INITIAL: Settings = {
  name: SEED,
  color: palette(seedTraits(SEED)('hue') * 360, true, DEFAULT_BLOB_TONE).head ?? '',
  tone: DEFAULT_BLOB_TONE,
  finish: 'clay',
  shape: '',
  size: 96,
  mode: 'resting',
  animate: true,
  expression: AUTO,
  dots: true,
  traits: { ...BLOB_FACE_TRAITS },
  busy: BUSY_LOOK,
  gesture: '',
  moment: '',
}

export function AvatarPlayground() {
  const [settings, setSettings] = useState(INITIAL)
  const [copied, setCopied] = useState(false)
  const frames = useRef<Array<HTMLIFrameElement | null>>([])
  const set = <Key extends keyof Settings>(key: Key, value: Settings[Key]) =>
    setSettings((current) => ({ ...current, [key]: value }))
  const setBusy = (change: Partial<BusyLook>) => setSettings((current) => ({ ...current, busy: { ...current.busy, ...change } }))

  useEffect(() => {
    for (const frame of frames.current) frame?.contentWindow?.postMessage(settings, window.location.origin)
    // A frame that finished loading after the last change asks for the current face.
    const answer = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.data !== READY) return
      ;(event.source as Window | null)?.postMessage(settings, window.location.origin)
    }
    window.addEventListener('message', answer)
    return () => window.removeEventListener('message', answer)
  }, [settings])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1600)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    await navigator.clipboard.writeText(JSON.stringify(settings, null, 2))
    setCopied(true)
  }

  const busy = settings.mode === 'busy'
  const gazePinned = settings.mode === 'working'
  const single = settings.busy.play !== 'loop' && settings.busy.play !== 'dots'
  // A move played once leaves the face at rest, so there is nothing to stop: the button plays it again.
  const stops = busy && !(single && settings.busy.once)
  // Every play is a new start, in another order of moves, the way the next turn would be.
  const start = (change: Partial<BusyLook> = {}) =>
    setSettings((current) => ({ ...current, mode: 'busy', moment: '', busy: { ...current.busy, ...change, seed: (current.busy.seed ?? 0) + 1 } }))

  return (
    <div className="flex h-full bg-bg text-text">
      <aside aria-label="Face settings" className="flex w-80 flex-none flex-col gap-4 overflow-y-auto border-r border-line p-5">
        <header className="flex flex-col gap-1">
          <h1 className="text-[16px] font-medium">Avatar playground</h1>
          <p className={formHintClass}>Drawn by @manor/blobatar. Nothing here is saved or reaches a persona.</p>
        </header>

        <Button
          variant="primary"
          className="inline-flex items-center justify-center gap-2"
          aria-pressed={stops}
          disabled={!busy && !settings.animate}
          onClick={() => (stops ? setSettings((current) => ({ ...current, mode: 'resting', moment: '' })) : start())}
        >
          <Icon icon={stops ? StopIcon : PlayIcon} size={16} />
          {stops ? 'Stop' : `Play ${PLAYS.find((each) => each.play === settings.busy.play)?.label.toLowerCase() ?? ''}`}
        </Button>

        <FormField label="Name">
          <input className={formInputClass} value={settings.name} onChange={(event) => set('name', event.currentTarget.value)} />
        </FormField>
        <FormField label="Colour">
          <input
            type="color"
            className="h-8 w-full cursor-pointer rounded-lg border border-line bg-surface-2"
            value={settings.color}
            onChange={(event) => set('color', event.currentTarget.value)}
          />
        </FormField>
        <Range label="Tone" value={settings.tone} min={0} max={1} step={0.01} digits={2} ticks={BLOB_TONES.map((tone) => tone.value)} onChange={(value) => set('tone', value)} />
        <FormField label="Shape" custom>
          <Select label="Shape" value={settings.shape} options={SHAPES} onChange={(value) => set('shape', value)} />
        </FormField>
        <FormField label="Finish" custom>
          <Select label="Finish" value={settings.finish} options={FINISHES} onChange={(value) => set('finish', value)} />
        </FormField>
        <Range label="Size" value={settings.size} min={16} max={160} step={1} unit="px" onChange={(value) => set('size', value)} />
        <FormField label="State" custom>
          <Select label="State" value={settings.mode} options={MODES} onChange={(value) => set('mode', value)} />
        </FormField>
        <FormField label="Moment" custom hint={settings.moment === '' ? 'What a turn shows on a face in the transcript.' : 'Stands in for state, expression and gesture.'}>
          <Select label="Moment" value={settings.moment} options={MOMENT_OPTIONS} onChange={(value) => set('moment', value)} />
        </FormField>
        <FormField label="Body gesture" custom hint="Plays on top of the eyes, whatever they do.">
          <Select label="Body gesture" value={settings.gesture} options={GESTURE_OPTIONS} onChange={(value) => set('gesture', value)} />
        </FormField>
        {busy ? null : (
          <FormField label="Expression" custom hint={settings.expression === AUTO ? 'Idle at rest, unsure while working.' : undefined}>
            <Select label="Expression" value={settings.expression} options={EXPRESSION_OPTIONS} onChange={(value) => set('expression', value)} />
          </FormField>
        )}
        <div className="flex items-center justify-between">
          <span className={formLabelClass}>Animate</span>
          <Switch label="Animate" checked={settings.animate} onChange={(value) => set('animate', value)} />
        </div>
        {settings.mode !== 'working' ? null : (
          <div className="flex items-center justify-between">
            <span className={formLabelClass}>Thought dots</span>
            <Switch label="Thought dots" checked={settings.dots} onChange={(value) => set('dots', value)} />
          </div>
        )}

        <section aria-label="Working face" className="flex flex-col gap-3 border-t border-line pt-4">
          <h2 className="text-[14px] font-medium">Working face</h2>
          <div role="group" aria-label="Plays" className="grid grid-cols-2 gap-1.5">
            {PLAYS.map(({ play, label }) => (
              <Button
                key={play}
                size="compact"
                variant={settings.busy.play === play ? 'primary' : 'secondary'}
                aria-pressed={busy && settings.busy.play === play}
                disabled={!settings.animate}
                onClick={() => start({ play })}
              >
                {label}
              </Button>
            ))}
          </div>
          <p className={formHintClass}>{PLAYS.find((each) => each.play === settings.busy.play)?.hint}</p>
          <div className="flex items-center justify-between">
            <span className={formLabelClass}>Repeat a single move</span>
            <Switch label="Repeat a single move" checked={!settings.busy.once} onChange={(repeat) => setBusy({ once: !repeat })} />
          </div>
          <Range label="Speed" value={settings.busy.speed} min={0.25} max={2} step={0.05} digits={2} unit="×" onChange={(speed) => setBusy({ speed })} />
        </section>

        <section aria-label="Face traits" className="flex flex-col gap-3 border-t border-line pt-4">
          <p className={formHintClass}>Pinned for every persona in blob-shapes. Reduced-motion working pins the gaze again.</p>
          {Object.keys(BLOB_FACE_TRAITS).map((key) => (
            <Range
              key={key}
              label={key}
              value={settings.traits[key] ?? 0}
              min={0}
              max={0.999}
              step={0.001}
              digits={3}
              disabled={gazePinned && key.startsWith('gaze.')}
              onChange={(value) => set('traits', { ...settings.traits, [key]: value })}
            />
          ))}
        </section>

        <div className="mt-auto flex gap-2 pt-2">
          <Button size="small" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy settings'}
          </Button>
          <Button size="small" variant="ghost" onClick={() => setSettings(INITIAL)}>
            Reset
          </Button>
        </div>
      </aside>

      <div className="grid min-w-0 flex-1 grid-cols-2">
        {(['dark', 'light'] as const).map((theme, index) => (
          <iframe
            key={theme}
            ref={(frame) => {
              frames.current[index] = frame
            }}
            title={`${theme === 'dark' ? 'Dark' : 'Light'} theme`}
            src={`playground.html?theme=${theme}`}
            className="size-full border-0"
          />
        ))}
      </div>
    </div>
  )
}

/** One theme's frame: waits for the controls, then draws what they say. */
export function PlaygroundPane({ theme }: { theme: string }) {
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== window.parent) return
      if (typeof event.data === 'object' && event.data !== null) setSettings(event.data as Settings)
    }
    window.addEventListener('message', receive)
    window.parent.postMessage(READY, window.location.origin)
    return () => window.removeEventListener('message', receive)
  }, [])

  return (
    <main className="relative grid h-full place-items-center bg-bg">
      <span className="absolute top-4 left-5 text-label text-dim">{theme}</span>
      {settings === null ? <p className="text-label text-dim">Open /playground.html to drive this frame.</p> : <Face settings={settings} />}
    </main>
  )
}

/**
 * Composed the way `Avatar` composes a persona's face, with the playground's traits in
 * place of the house ones. Busy wears the resting face and traits, so starting and
 * stopping it moves the same face rather than drawing a new one.
 */
function Face({ settings }: { settings: Settings }) {
  const { name, color, tone, finish, shape, size, mode, animate } = settings
  const hue = accentHue(color)
  // A moment is composed the way `Avatar` composes it: eyes, pose and gesture from one look.
  const look = settings.moment === '' || !animate ? undefined : FACE_LOOK[settings.moment as FaceState]
  const working = look === undefined && mode === 'working'
  const traits = { ...settings.traits, ...(working ? WORKING_GAZE : {}) }
  const expression =
    look !== undefined
      ? look.pose === undefined ? undefined : poses[look.pose]
      : mode === 'busy'
      ? undefined
      : settings.expression === AUTO
        ? working
          ? poses.unsure
          : undefined
        : EXPRESSIONS.find(([id]) => id === settings.expression)?.[1]
  const dot = palette(hue ?? seedTraits(name)('hue') * 360, true, tone).head ?? 'var(--accent-fg)'
  const slot = useRef<HTMLSpanElement>(null)
  const busy = animate && (look === undefined ? mode === 'busy' : look.eyes === 'loop' || look.eyes === 'dots')
  const drawn = JSON.stringify([name, color, tone, finish, traits, shape, size])
  // A moment plays what a turn would: the loop for work, the dots for writing. Going from one to the other is handed over.
  const run = useBusyFace(slot, busy, look === undefined ? settings.busy : { speed: settings.busy.speed, play: look.eyes === 'dots' ? 'dots' : 'loop' }, drawn)
  const gesture = look === undefined ? settings.gesture : (look.gesture ?? '')
  useFaceGesture(slot, animate && gesture !== '' ? (gesture as GestureId) : undefined, drawn, look?.passes)
  useFaceEyes(slot, look?.eyes === 'toward' ? look.eyes : undefined, drawn)
  const [now, setNow] = useState<ReturnType<BusyRun['playing']>>()
  useEffect(() => {
    if (!busy) return
    const timer = window.setInterval(() => setNow(run.current?.playing()), 100)
    return () => window.clearInterval(timer)
  }, [run, busy])
  const playing = busy ? now : undefined

  return (
    <>
      {playing === undefined ? null : (
        <span className="absolute top-4 right-5 text-label text-dim">{playing === 'dots' ? 'Dots' : moveInfo(playing).label}</span>
      )}
      <span
        ref={slot}
        role="img"
        aria-label={`${name}, ${MODES.find((option) => option.value === mode)?.label ?? mode}`}
        className="relative grid flex-none place-items-center"
        style={{ width: size, height: size }}
        data-avatar="blobatar"
        data-working={working ? 'true' : undefined}
      >
        <Blobatar
          name={name}
          size={size}
          tone={tone}
          {...(finish === 'flat' ? {} : { shading: finish })}
          traits={traits}
          {...(shape === '' ? {} : { shape })}
          {...(animate ? { animate: 'always' as const } : {})}
          {...(hue === undefined ? {} : { hue })}
          {...(expression === undefined ? {} : { expression })}
        />
        {working && animate && settings.dots ? <ThoughtDots color={dot} size={size} /> : null}
      </span>
    </>
  )
}

function Range({
  label,
  value,
  min,
  max,
  step,
  digits = 0,
  unit = '',
  ticks,
  disabled = false,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  digits?: number
  unit?: string
  /** Stops worth landing on, drawn as tick marks under the track. */
  ticks?: readonly number[]
  disabled?: boolean
  onChange: (value: number) => void
}) {
  const listId = useId()
  return (
    <label className={`${formFieldClass} ${disabled ? 'opacity-45' : ''}`}>
      <span className={`${formLabelClass} justify-between`}>
        {label}
        <span className="font-mono text-label text-dim tabular-nums">
          {value.toFixed(digits)}
          {unit}
        </span>
      </span>
      <input
        type="range"
        className="w-full accent-text"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        list={ticks === undefined ? undefined : listId}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
      {ticks === undefined ? null : (
        <datalist id={listId}>
          {ticks.map((tick) => (
            <option key={tick} value={tick} />
          ))}
        </datalist>
      )}
    </label>
  )
}
