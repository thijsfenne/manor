import { useRef } from 'react'
import { Cancel01Icon, LoaderCircleIcon, Mic01Icon, Tick02Icon } from '@hugeicons/core-free-icons'
import type { DesktopDictationBridge, DictationModelId, DictationModelStatus } from '@manor/contracts'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { DICTATION_MODELS, formatModelSize, modelStatus, useDictationModels } from '../dictation/models'
import { useDictation, type DictationNotice, type DictationSettings } from '../dictation/useDictation'
import { ICON_SWAP, ICON_SWAP_GONE, ICON_SWAP_REST, TEXT_SWAP, TEXT_SWAP_ABOVE, TEXT_SWAP_BELOW, TEXT_SWAP_REST } from '../motion'
import { openSettingsAt } from '../settingsIntent'
import { Icon } from './Icon'
import { Button } from './ui/Button'
import { Popover } from './ui/Popover'
import { useDismiss } from './ui/useDismiss'

/** The pill grows out of the microphone's place: the icon swap's curve, a gentler scale for its width. */
const PILL_GONE = { opacity: 0, scale: 0.85, filter: 'blur(2px)' }
/** How many of the oldest bars at the left fade and shrink away. */
const FADING_BARS = 5

interface ComposerDictationProps {
  bridge: DesktopDictationBridge
  settings: DictationSettings
  /** The composer's one round-control size, so the microphone and ✓ match send. */
  controlSize: string
  /** The side panel's smaller build: a shorter pill and smaller marks. */
  dense: boolean
  /** Puts the transcript into the draft at the caret and focuses the editor. */
  onInsert: (text: string) => void
}

/**
 * The microphone beside send, and what it becomes while recording: one pill with the
 * live waveform and ✕, then ✓. Send itself stays the composer's and never moves. The
 * Composer keys this by draft, so switching chats unmounts it and drops a recording.
 */
export function ComposerDictation({ bridge, settings, controlSize, dense, onInsert }: ComposerDictationProps) {
  const models = useDictationModels()
  const dictation = useDictation({ bridge, settings, models, onInsert })
  const { phase, notice, levels } = dictation
  const reduce = useReducedMotion() ?? false
  const rootRef = useRef<HTMLDivElement>(null)
  useDismiss(notice !== null, dictation.dismissNotice, { within: [rootRef], escape: true })
  const swap = (gone: typeof PILL_GONE) => (reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.1 } }
    : { initial: gone, animate: ICON_SWAP_REST, exit: gone, transition: ICON_SWAP })
  const height = dense ? 'h-7' : 'h-8'
  const markSize = dense ? 16 : 18

  return (
    <div ref={rootRef} className="relative flex flex-none items-center">
      <AnimatePresence initial={false} mode="popLayout">
        {phase === 'idle' ? (
          <motion.button
            key="microphone"
            type="button"
            className={`grid cursor-pointer place-items-center rounded-full border-0 bg-user-bg text-muted hover:bg-menu-selected hover:text-text ${controlSize}`}
            title="Dictate"
            aria-label="Dictate"
            aria-haspopup="dialog"
            aria-expanded={notice !== null}
            onClick={() => void dictation.start()}
            {...swap(ICON_SWAP_GONE)}
          >
            <Icon icon={Mic01Icon} size={markSize} />
          </motion.button>
        ) : (
          <motion.div key="recording" className="flex items-center gap-2" style={{ transformOrigin: 'right center' }} {...swap(PILL_GONE)}>
            <div className={`flex items-center gap-1.5 rounded-full bg-user-bg pr-0.5 pl-3 ${height}`}>
              <span className="grid" role="status">
                <AnimatePresence initial={false}>
                  <motion.span
                    key={phase === 'transcribing' ? 'transcribing' : 'wave'}
                    className="col-start-1 row-start-1 flex items-center"
                    initial={reduce ? { opacity: 0 } : TEXT_SWAP_BELOW}
                    animate={TEXT_SWAP_REST}
                    exit={reduce ? { opacity: 0 } : TEXT_SWAP_ABOVE}
                    transition={TEXT_SWAP}
                  >
                    {phase === 'transcribing' ? (
                      <span className="flex items-center gap-1.5 text-meta whitespace-nowrap text-muted">
                        <Icon icon={LoaderCircleIcon} size={14} className="motion-safe:animate-spin-calm" />
                        Transcribing…
                      </span>
                    ) : (
                      <Waveform levels={levels} dense={dense} />
                    )}
                  </motion.span>
                </AnimatePresence>
              </span>
              <button
                type="button"
                className={`grid cursor-pointer place-items-center rounded-full border-0 bg-transparent text-muted hover:bg-menu-selected hover:text-text ${dense ? 'h-6 w-6' : 'h-7 w-7'}`}
                title="Cancel dictation"
                aria-label="Cancel dictation"
                onClick={dictation.cancel}
              >
                <Icon icon={Cancel01Icon} size={dense ? 14 : 16} />
              </button>
            </div>
            <button
              type="button"
              className={`grid cursor-pointer place-items-center rounded-full border-0 bg-text/80 text-bg hover:bg-text/90 disabled:cursor-default disabled:opacity-[0.3] ${controlSize}`}
              title="Insert dictation"
              aria-label="Insert dictation"
              disabled={phase !== 'recording'}
              onClick={() => void dictation.confirm()}
            >
              <Icon icon={Tick02Icon} size={markSize} />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <Popover
        open={notice !== null}
        origin="bottom-right"
        className="absolute right-0 bottom-[calc(100%+8px)] z-[6] w-[288px] max-w-[calc(100vw-24px)] rounded-panel border border-line surface-floating p-3 shadow-popover"
        role="dialog"
        aria-label="Dictation"
      >
        {notice === null ? null : (
          <NoticeBody
            notice={notice}
            model={settings.dictationModel}
            status={modelStatus(models, settings.dictationModel)}
            bridge={bridge}
            onVoiceSettings={() => {
              dictation.dismissNotice()
              openSettingsAt('voice')
            }}
          />
        )}
      </Popover>
    </div>
  )
}

/**
 * About twenty thin bars, the newest level at the right. The oldest few at the left
 * fade and shrink, so the row reads as sound scrolling out of view rather than a meter
 * with a hard edge.
 */
function Waveform({ levels, dense }: { levels: readonly number[]; dense: boolean }) {
  const tallest = dense ? 14 : 16
  return (
    <span aria-hidden="true" className={`flex items-center gap-[3px] ${dense ? 'h-3.5' : 'h-4'}`}>
      {levels.map((level, index) => {
        const fade = Math.min((index + 1) / (FADING_BARS + 1), 1)
        return (
          <span
            key={index}
            className="w-[2px] flex-none rounded-full bg-text duration-150 ease-out motion-safe:transition-[height]"
            style={{ height: `${Math.max(2, level * tallest * fade)}px`, opacity: fade }}
          />
        )
      })}
    </span>
  )
}

/** A thin download bar; the percent beside the model name is the readable value. */
function ProgressBar({ value }: { value: number }) {
  return (
    <div
      role="progressbar"
      aria-label="Download progress"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      className="mt-2 h-1 w-full overflow-hidden rounded-full bg-line"
    >
      <div className="h-full origin-left bg-muted duration-300 ease-out motion-safe:transition-transform" style={{ transform: `scaleX(${value / 100})` }} />
    </div>
  )
}

/** Download and status calls report through the model status push, so their own errors say nothing new. */
const quietly = (work: Promise<void>) => void work.catch(() => {})

function NoticeBody({ notice, model, status, bridge, onVoiceSettings }: {
  notice: DictationNotice
  model: DictationModelId
  /** Undefined until the bridge's first push. */
  status: DictationModelStatus | undefined
  bridge: DesktopDictationBridge
  onVoiceSettings: () => void
}) {
  const sentence = 'text-label leading-snug text-text'
  if (notice.kind === 'mic-denied') {
    return (
      <>
        <p className={`m-0 ${sentence}`}>Manor may not use the microphone. Allow it in System Settings, under Privacy &amp; Security, Microphone.</p>
        <div className="mt-2.5 flex justify-end">
          <Button size="compact" onClick={() => quietly(bridge.openMicrophoneSettings())}>Open System Settings</Button>
        </div>
      </>
    )
  }
  if (notice.kind !== 'needs-model') {
    const said = notice.kind === 'failed' ? notice.message : notice.kind === 'no-speech' ? 'No speech heard.' : 'No microphone found.'
    return <p className={`m-0 ${sentence}`}>{said}</p>
  }

  const label = DICTATION_MODELS[model].label
  const state = status?.state ?? 'missing'
  const percent = Math.round((status?.progress ?? 0) * 100)
  const action = state === 'downloading'
    ? <Button size="compact" variant="ghost" onClick={() => quietly(bridge.cancelDownload(model))}>Cancel</Button>
    : state === 'failed'
      ? <Button size="compact" onClick={() => quietly(bridge.download(model))}>Retry</Button>
      : state === 'missing'
        ? <Button size="compact" variant="primary" onClick={() => quietly(bridge.download(model))}>Download</Button>
        : null
  return (
    <>
      {state === 'ready' ? (
        <p className={`m-0 ${sentence}`}>{label} is ready. Press the microphone to dictate.</p>
      ) : (
        <div className="flex items-baseline justify-between gap-3">
          <span className={`min-w-0 truncate font-medium ${sentence}`}>{label}</span>
          <span className="flex-none text-meta text-dim tabular-nums">
            {state === 'downloading' ? `${percent}%` : status === undefined || status.bytes === 0 ? '' : formatModelSize(status.bytes)}
          </span>
        </div>
      )}
      {state === 'downloading' ? <ProgressBar value={percent} /> : null}
      {state === 'failed' && status?.error !== undefined ? <p className="m-0 mt-1.5 text-label leading-snug text-muted">{status.error}</p> : null}
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <button
          type="button"
          className="cursor-pointer border-0 bg-transparent p-0 text-label text-muted underline-offset-2 hover:text-text hover:underline"
          onClick={onVoiceSettings}
        >
          Voice settings
        </button>
        {action}
      </div>
    </>
  )
}
