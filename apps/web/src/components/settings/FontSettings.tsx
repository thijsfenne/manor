import { forwardRef, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react'
import type { FileEdit, SkillConfig } from '@manor/contracts'
import { editStat } from '@manor/client-runtime/diff'
import { applyFont, defaultFont, fontOf, loadFonts, MONO, readFont, SANS, type FontKind, type MonoFont, type SansFont } from '../../fonts'
import { DiffBody } from '../FileDiff'
import { FileMark } from '../fileMark'
import { FileChip, SkillChip } from '../MentionText'
import { Select, type SelectOption } from '../ui/Select'
import { SettingsGroup, SettingsRow } from './SettingsLayout'

const optionsOf = <Id extends string>(kind: FontKind<Id>): readonly SelectOption<Id>[] =>
  kind.fonts.map((font) => ({ value: font.id, label: font.label, style: { fontFamily: font.stack } }))

const SANS_OPTIONS = optionsOf(SANS)
const MONO_OPTIONS = optionsOf(MONO)

const SAMPLE_SKILL: SkillConfig = { id: 'frontend-design', name: 'Frontend Design', description: '', instructions: 'Preview only.', sources: ['claude'] }

const SAMPLE_EDIT: FileEdit = {
  path: 'src/totals.ts',
  before: ['export function total(rows: Row[]) {', '  return rows.reduce((a, b) => a + b.price, 0)', '}'].join('\n'),
  after: [
    'export function total(rows: Row[]) {',
    '  const sum = rows.reduce((a, b) => a + b.price, 0)',
    '  return sum != 0 && sum <= LIMIT ? { sum } : null // 0O 1lI',
    '}',
  ].join('\n'),
}
const SAMPLE_STAT = editStat(SAMPLE_EDIT)

/** The frame both samples sit in. The font is set here only, so a hovered option shows in it alone. */
const Sample = forwardRef<HTMLDivElement, { style: CSSProperties; children: ReactNode }>(function Sample({ style, children }, ref) {
  return (
    <div ref={ref} aria-hidden="true" className="mb-4 rounded-xl border border-line bg-stage px-4 py-3" style={style}>
      {children}
    </div>
  )
})

/**
 * What one menu is previewing. While its list is open the sample keeps at least the
 * height it had at opening: a face that wraps shorter, at the foot of the page, would
 * clamp the scroll, and any page scroll closes the open list.
 */
function useFontPreview<Id extends string>(kind: FontKind<Id>) {
  const frame = useRef<HTMLDivElement>(null)
  const [preview, setPreview] = useState<Id | null>(null)
  const [minHeight, setMinHeight] = useState<number | undefined>(undefined)
  const onPreview = (id: Id | null) => {
    if (id !== null && preview === null) {
      loadFonts(kind)
      setMinHeight(frame.current?.offsetHeight)
    }
    if (id === null) setMinHeight(undefined)
    setPreview(id)
  }
  return { preview, frame, minHeight, onPreview }
}

type Held = { stack: string; frame: RefObject<HTMLDivElement>; minHeight: number | undefined }

/** A message as it reads in a chat: the transcript's 15px, with the real skill and file chips. */
function InterfaceSample({ stack, frame, minHeight }: Held) {
  return (
    <Sample ref={frame} style={{ fontFamily: stack, minHeight }}>
      <p className="m-0 text-[15px] leading-relaxed text-text">
        Use <SkillChip skill={SAMPLE_SKILL} /> to fix the flaky test in <FileChip path="src/surface.test.ts" /> and align the header with{' '}
        <FileChip path="src/SettingsPanels.tsx" /> before shipping.
      </p>
    </Sample>
  )
}

/** A change as the transcript draws it, through the same diff body a turn's edits use. */
function CodeSample({ stack, frame, minHeight }: Held) {
  return (
    <Sample ref={frame} style={{ '--font-mono': stack, minHeight } as CSSProperties}>
      <div className="mb-2 flex items-center gap-2 text-[13px]">
        <FileMark path={SAMPLE_EDIT.path} />
        <span className="min-w-0 flex-1 truncate text-text">{SAMPLE_EDIT.path}</span>
        <span className="text-danger">−{SAMPLE_STAT.removed}</span>
        <span className="text-ok">+{SAMPLE_STAT.added}</span>
      </div>
      <DiffBody edit={SAMPLE_EDIT} />
    </Sample>
  )
}

/**
 * The interface font and the code font. Each row names its fonts in their own face, and
 * the sample under it follows the option under the pointer, then the pick once the menu
 * closes. Kept per device, like the theme.
 */
export function FontGroup() {
  const [sans, setSans] = useState<SansFont>(() => readFont(SANS))
  const [mono, setMono] = useState<MonoFont>(() => readFont(MONO))
  const sansPreview = useFontPreview(SANS)
  const monoPreview = useFontPreview(MONO)

  const pickSans = (id: SansFont) => {
    setSans(id)
    applyFont(SANS, id)
  }
  const pickMono = (id: MonoFont) => {
    setMono(id)
    applyFont(MONO, id)
  }
  const atDefaults = sans === defaultFont(SANS).id && mono === defaultFont(MONO).id

  return (
    <SettingsGroup
      title="Fonts"
      onRestore={() => {
        pickSans(defaultFont(SANS).id)
        pickMono(defaultFont(MONO).id)
      }}
      restoreDisabled={atDefaults}
    >
      <div>
        <SettingsRow label="Interface font" description="Everything outside code.">
          <div className="w-[220px]">
            <Select
              label="Interface font"
              value={sans}
              options={SANS_OPTIONS}
              onChange={pickSans}
              onPreview={sansPreview.onPreview}
            />
          </div>
        </SettingsRow>
        <InterfaceSample stack={fontOf(SANS, sansPreview.preview ?? sans).stack} frame={sansPreview.frame} minHeight={sansPreview.minHeight} />
      </div>
      <div>
        <SettingsRow label="Code font" description="Code blocks, inline code, diffs and the file viewer. No ligatures.">
          <div className="w-[220px]">
            <Select
              label="Code font"
              value={mono}
              options={MONO_OPTIONS}
              onChange={pickMono}
              onPreview={monoPreview.onPreview}
            />
          </div>
        </SettingsRow>
        <CodeSample stack={fontOf(MONO, monoPreview.preview ?? mono).stack} frame={monoPreview.frame} minHeight={monoPreview.minHeight} />
      </div>
    </SettingsGroup>
  )
}
