/**
 * What a persona's face shows about the turn behind it, shared by every client.
 *
 * Until now a face knew one thing about a turn: that it ran. The transcript already
 * knows more, and says it in words beside the face ("Reading…", "Writing…"). This
 * file reads the same turn and names the moment for the face itself, and says how
 * each moment looks: what the eyes do, which library pose they hold, and which body
 * gesture plays (see `faceGesture`).
 *
 * Every kind of work looks the same: the working loop of `busyFace`, which moves the
 * whole face. Writing has its own look, and so have the moments that are not work.
 */
import { isCompacting } from './compacting'
import type { EyePose } from './busyFace'
import type { GestureId } from './faceGesture'
import { isToolStep, liveWritten, type TurnRow } from './state'
import { activityKind, type ActivityKind } from './turnLabels'
import { backgroundWaitLabel, isWaiting } from './turnTrace'

/** What a running turn is doing, as far as a face can show it. */
export type FaceActivity = 'working' | 'thinking' | 'reading' | 'searching' | 'editing' | 'running' | 'snagged' | 'compacting' | 'typing' | 'waiting'
/** A moment that is not work: she needs the user, or her turn just ended. */
export type FaceMoment = 'needs' | 'done' | 'failed'
export type FaceState = FaceActivity | FaceMoment

export interface FaceLook {
  /**
   * `loop` is the working loop, body and eyes. `dots` is the melt into three dots, held.
   * `toward` is a small move added on top of where the eyes are. `still` leaves them to
   * the pose.
   */
  eyes: 'loop' | 'dots' | 'toward' | 'still'
  /** A pose of the face library, by its name there. */
  pose?: 'sleepy' | 'happy' | 'sad'
  gesture?: GestureId
  /**
   * How many times the gesture plays before the body is still again. Absent, it plays
   * for as long as the state holds. A moment that can last for hours, like an open
   * question, says its piece and then waits quietly.
   */
  passes?: number
}

/** Work of any kind. The loop is one continuous piece, so a turn that goes from reading to running does not restart it. */
const WORK: FaceLook = { eyes: 'loop' }

export const FACE_LOOK: Record<FaceState, FaceLook> = {
  working: WORK,
  thinking: WORK,
  reading: WORK,
  searching: WORK,
  editing: WORK,
  running: WORK,
  snagged: WORK,
  compacting: WORK,
  typing: { eyes: 'dots' },
  waiting: { eyes: 'still', pose: 'sleepy', gesture: 'sink' },
  needs: { eyes: 'toward', gesture: 'bounce', passes: 2 },
  done: { eyes: 'still', pose: 'happy', gesture: 'nod', passes: 1 },
  failed: { eyes: 'still', pose: 'sad', gesture: 'shake', passes: 1 },
}

const WORK_FACE: Record<ActivityKind, FaceActivity> = { read: 'reading', search: 'searching', edit: 'editing', shell: 'running', reasoning: 'thinking', other: 'working' }

/**
 * What a turn asks its face to show while it is live, or nothing for a turn that is
 * not. The newest call stands until she speaks again, as it does in the words beside
 * her, so a run of quick reads holds on reading instead of flickering.
 *
 * A running turn holding for the user's answer is not busy, whatever else it is: a
 * working face over "Waiting for you" lies. A turn that stopped with its question
 * still open is history, and asks nothing of its face.
 */
export function turnFace(turn: TurnRow, waitingOnAgent = false): FaceState | undefined {
  if (turn.live?.state !== 'running') return undefined
  if (isWaiting(turn)) return 'needs'
  if (waitingOnAgent || backgroundWaitLabel(turn) !== undefined) return 'waiting'
  if (isCompacting(turn)) return 'compacting'
  if (liveWritten(turn.live)) return 'typing'
  for (let index = turn.activities.length - 1; index >= 0; index -= 1) {
    const step = turn.activities[index]!
    if (step.kind === 'say') return 'thinking'
    if (!isToolStep(step)) return 'thinking'
    if (step.parentToolCallId !== undefined || step.background === true) continue
    if (step.status === 'error') return 'snagged'
    return WORK_FACE[activityKind(step)]
  }
  return 'thinking'
}

/**
 * How a turn that just stopped running is marked on its face, once. An error is a
 * failure. A turn the user stopped is neither: it was their call, and a sad face over
 * it would answer back.
 */
export function endFace(turn: TurnRow): FaceMoment | undefined {
  if (isWaiting(turn)) return undefined
  if (turn.note?.kind === 'error') return 'failed'
  if (turn.note?.kind === 'aborted') return undefined
  return 'done'
}

/** How long a state holds before another may replace it, so a 200 ms tool call cannot make a face twitch. */
export const FACE_HOLD_MS = 1200
/** How long the mark of a turn's end stays on a face. */
export const FACE_MOMENT_MS = 2400

export interface ShownFace {
  state: FaceState | undefined
  /** When it came on, in milliseconds. */
  since: number
}

const isMoment = (state: FaceState | undefined): state is FaceMoment => state === 'needs' || state === 'done' || state === 'failed'

/**
 * What a face shows now, given what is asked of it, and how long until it is worth
 * asking again. A moment replaces anything at once, and so does the first state on a
 * resting face. One kind of work replaces another only after the hold, and a turn's
 * end leaves the face after its moment.
 */
export function settleFace(shown: ShownFace, asked: FaceState | undefined, now: number): { shown: ShownFace; again?: number } {
  const age = now - shown.since
  const ended = shown.state === 'done' || shown.state === 'failed'
  if (asked === shown.state) {
    if (ended && age >= FACE_MOMENT_MS) return { shown: { state: undefined, since: now } }
    return ended ? { shown, again: FACE_MOMENT_MS - age } : { shown }
  }
  if (shown.state === undefined || isMoment(asked) || isMoment(shown.state) || age >= FACE_HOLD_MS) {
    const next = { state: asked, since: now }
    // The mark of an ending is the one state that leaves by itself, so it says when.
    return asked === 'done' || asked === 'failed' ? { shown: next, again: FACE_MOMENT_MS } : { shown: next }
  }
  return { shown, again: FACE_HOLD_MS - age }
}

/** One stop of an eye move that is added to wherever the eyes are. */
export interface EyeStop {
  offset: number
  x: number
  y: number
  /** The curve into the next stop. */
  ease: string
}

/** Needs you: the pair turns from its resting gaze to face the reader. */
export const towardStops = (toMiddle: number): EyeStop[] => [
  { offset: 0, x: toMiddle, y: 0, ease: 'linear' },
  { offset: 1, x: toMiddle, y: 0, ease: 'linear' },
]

/** One pass of the added eye move, in milliseconds. */
export const EYE_MOVE_MS = { toward: 1000 } as const

/** Where an added eye move has the eye at `progress` through its pass, for walking it home from there. */
export function eyeAt(stops: readonly EyeStop[], progress: number): Pick<EyePose, 'x' | 'y'> {
  const next = stops.findIndex((stop) => stop.offset >= progress)
  const b = stops[next < 0 ? stops.length - 1 : next]!
  const a = stops[Math.max((next < 0 ? stops.length : next) - 1, 0)]!
  const u = b.offset === a.offset ? 0 : (progress - a.offset) / (b.offset - a.offset)
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }
}
