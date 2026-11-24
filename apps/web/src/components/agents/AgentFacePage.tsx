import { useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { Cancel01Icon, ColorPickerIcon, Upload01Icon } from '@hugeicons/core-free-icons'
import { palette } from '@manor/blobatar'
import type { AgentDraft } from '@manor/contracts'
import { accentHue } from '../../accent'
import { AVATAR_ACCEPT, shrinkToAvatar } from '../../avatar'
import { BLOB_SHAPES, BLOB_TONES, DEFAULT_BLOB_TONE, blobShapeOf } from '../../blobShapes'
import { personaColorChoices, safeHex } from '../../persona'
import { Avatar } from '../Avatar'
import { Icon } from '../Icon'
import { Button } from '../ui/Button'
import { formLabelClass } from '../ui/FormField'

/** One shell for every face choice, so the ring that marks the picked one is the only difference. */
const tileClass =
  'grid cursor-pointer place-items-center rounded-full border p-0 leading-none outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary disabled:cursor-default disabled:opacity-45'
const pickedClass = 'border-[var(--color-text)] bg-user-bg'
const unpickedClass = 'border-transparent hover:border-dim'

/** One face choice: its label above, its tiles on a card of their own, as the rows of Agent settings sit. */
function FaceSection({ label, groupLabel, gap = 'gap-1', children }: { label: string; groupLabel: string; gap?: string; children: ReactNode }) {
  return (
    <div className="flex w-full flex-col gap-2">
      <span className={formLabelClass}>{label}</span>
      <div className={`flex flex-wrap justify-center ${gap} rounded-lg border border-line bg-surface-2 p-3`} role="group" aria-label={groupLabel}>
        {children}
      </div>
    </div>
  )
}

/**
 * The Face page of Agent settings: the face as it stands, then colour, shape and tone,
 * every tile this agent's own face. An own picture replaces all three and carries its
 * way out in the corner.
 */
export function AgentFacePage({ draft, onChange }: {
  draft: AgentDraft
  onChange: (patch: Partial<AgentDraft>) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [shrinking, setShrinking] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const accent = safeHex(draft.color)
  const worn = blobShapeOf(draft.name, draft.avatarShape)?.id
  const picture = Boolean(draft.avatar)

  const pickFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // Emptied so picking the same file twice fires again.
    event.target.value = ''
    if (!file) return
    setProblem(null)
    setShrinking(true)
    try {
      onChange({ avatar: await shrinkToAvatar(file) })
    } catch (failure) {
      setProblem(failure instanceof Error ? failure.message : 'That picture could not be used.')
    } finally {
      setShrinking(false)
    }
  }

  return (
    <div className="flex flex-col items-center gap-5">
      <div className="relative">
        <Avatar name={draft.name} color={accent} src={draft.avatar} shape={draft.avatarShape} tone={draft.avatarTone} size={88} />
        {picture ? (
          <button
            type="button"
            className="absolute -top-0.5 -right-0.5 grid size-[20px] cursor-pointer place-items-center rounded-full border border-line bg-surface-2 text-muted outline-none hover:border-dim hover:text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            aria-label="Remove picture"
            title="Remove picture"
            onClick={() => onChange({ avatar: undefined })}
          >
            <Icon icon={Cancel01Icon} size={11} />
          </button>
        ) : null}
      </div>

      <FaceSection label="Colour" groupLabel="Agent colour" gap="gap-1.5">
        {personaColorChoices(draft.color).map((option) => {
          const selected = option.value.toLowerCase() === accent.toLowerCase()
          return (
            <button
              key={option.value}
              type="button"
              className={`${tileClass} size-7 ${selected ? 'border-[var(--color-text)]' : unpickedClass}`}
              aria-label={option.label}
              aria-pressed={selected}
              title={option.label}
              onClick={() => onChange({ color: option.value })}
            >
              <span className="size-[22px] rounded-full" style={{ backgroundColor: option.value }} />
            </button>
          )
        })}
        <span
          className={`${tileClass} relative size-7 border-dashed border-dim text-muted hover:border-[var(--color-text)] hover:text-text focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-primary`}
          title="Custom colour"
        >
          <Icon icon={ColorPickerIcon} size={14} />
          <input className="absolute inset-0 cursor-pointer opacity-0" type="color" value={accent} aria-label="Custom colour" onChange={(event) => onChange({ color: event.target.value })} />
        </span>
      </FaceSection>

      <FaceSection label="Shape" groupLabel="Shape">
        {BLOB_SHAPES.map((option) => {
          const selected = worn === option.id
          return (
            <button
              key={option.id}
              type="button"
              className={`${tileClass} size-11 ${selected ? pickedClass : unpickedClass}`}
              aria-label={`Shape: ${option.label}`}
              aria-pressed={selected}
              title={option.label}
              disabled={picture}
              onClick={() => onChange({ avatarShape: option.id })}
            >
              <Avatar name={draft.name} color={accent} shape={option.id} tone={draft.avatarTone} size={30} center />
            </button>
          )
        })}
      </FaceSection>

      <FaceSection label="Tone" groupLabel="Avatar tone">
        {BLOB_TONES.map((option) => {
          const selected = (draft.avatarTone ?? DEFAULT_BLOB_TONE) === option.value
          return (
            <button
              key={option.value}
              type="button"
              className={`${tileClass} size-11 ${selected ? pickedClass : unpickedClass}`}
              aria-label={`Tone: ${option.label}`}
              aria-pressed={selected}
              title={option.label}
              disabled={picture}
              onClick={() => onChange({ avatarTone: option.value })}
            >
              <span className="size-[30px] rounded-full" style={{ backgroundColor: palette(accentHue(accent) ?? 0, true, option.value).head }} />
            </button>
          )
        })}
      </FaceSection>

      <Button size="compact" variant="ghost" disabled={shrinking} onClick={() => fileRef.current?.click()}>
        <span className="flex items-center gap-1.5">
          <Icon icon={Upload01Icon} size={13} />
          {shrinking ? 'Resizing…' : picture ? 'Upload another' : 'Upload a picture'}
        </span>
      </Button>
      <input ref={fileRef} className="hidden" type="file" aria-label="Choose a picture" accept={AVATAR_ACCEPT} tabIndex={-1} onChange={(event) => void pickFile(event)} />
      {problem === null ? null : <p className="m-0 text-label text-danger" role="alert">{problem}</p>}
    </div>
  )
}
