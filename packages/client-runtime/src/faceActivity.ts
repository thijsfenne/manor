/**
 * What a persona's face shows about the turn behind it, shared by every client.
 *
 * Until now a face knew one thing about a turn: that it ran. The transcript already
 * knows more, and says it in words beside the face ("Reading…", "Writing…"). This
 * file reads the same turn and names the moment for the face itself, and says how
 * each moment looks: what the eyes do, which library pose they hold, and which body
 * gesture plays (see `faceGesture`).
 *
 * The current busy loop stays what a working face does. Only the moments that have a
 * better answer than "busy" get one of their own.
 */
import { isCompacting } from './compacting'
import type { EyePose } from './busyFace'
import type { GestureId } from './faceGesture'
import { isToolStep, liveWritten, type Row, type TurnRow } from './state'
import { activityKind, type ActivityKind } from './turnLabels'
import { backgroundWaitLabel, isWaiting } from './turnTrace'

/** What a running turn is doing, as far as a face can show it. */
export type FaceActivity = 'working' | 'thinking' | 'reading' | 'searching' | 'editing' | 'running' | 'snagged' | 'compacting' | 'typing' | 'waiting'
/** A moment that is not work: she needs the user, or her turn just ended. */
export type FaceMoment = 'needs' | 'done' | 'failed'
export type FaceState = FaceActivity | FaceMoment

export interface FaceLook {
  /**
   * `loop` is the current busy loop, whole. `dots` is its melt into three dots, held.
   * `scan`, `toward` and `seesaw` are small moves added on top of where the eyes are.
   * `still` leaves them to the pose.
   */
  eyes: 'loop' | 'dots' | 'scan' | 'toward' | 'seesaw' | 'still'
  /** A pose of the face library, by its name there. */
  pose?: 'thinking' | 'sleepy' | 'happy' | 'sad'
  gesture?: GestureId
  /**
   * How many times the gesture plays before the body is still again. Absent, it plays
   * for as long as the state holds. A moment that can last for hours, like an open
   * question, says its piece and then waits quietly.
   */
  passes?: number
}

export const FACE_LOOK: Record<FaceState, FaceLook> = {
  working: { eyes: 'loop' },
  thinking: { eyes: 'seesaw', pose: 'thinking', gesture: 'tilt' },
  reading: { eyes: 'scan', gesture: 'follow' },
  // The kinds of work below keep the busy loop and add a body move of their own. One
  // that would read as fidgeting if it held says its piece and stops.
  searching: { eyes: 'loop', gesture: 'rock', passes: 2 },
  editing: { eyes: 'loop', gesture: 'lean' },
  running: { eyes: 'loop', gesture: 'jelly', passes: 1 },
  /** The newest call failed and the turn carries on: a small start, not the shake of a failed turn. */
  snagged: { eyes: 'loop', gesture: 'shiver', passes: 1 },
  compacting: { eyes: 'loop', gesture: 'roll', passes: 1 },
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

/**
 * The last row of a DM turn that has just stopped, when it ended well, so the working
 * indicator can stay a moment for her nod under the reply. Only a written result counts:
 * a live turn can also vanish because a reconnect found it gone. A stop, a failure or an
 * open question gets nothing: in a DM a broken turn just ends.
 */
export function endedWell(rows: readonly Row[], turnId: string): TurnRow | undefined {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!
    if (row.kind !== 'turn' || row.turnId !== turnId) continue
    return row.completed === true && endFace(row) === 'done' ? row : undefined
  }
  return undefined
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

/** How far the reading scan runs to each side, and how far apart its three lines are. */
const SCAN = { reach: 5.5, line: 2.4, read: 0.27 }

/**
 * Reading: three lines from left to right, with a quick return between them. Both eyes
 * take the same stops. `toMiddle` moves the pair from where the resting gaze leaves it
 * to the middle of the face, so the lines run evenly to both sides. One pass takes as
 * long as the `follow` gesture, whose dips fall on the returns.
 */
export function scanStops(toMiddle: number): EyeStop[] {
  const lines = [-SCAN.line, 0, SCAN.line]
  return [
    ...lines.flatMap((y, index): EyeStop[] => [
      { offset: index / lines.length, x: toMiddle - SCAN.reach, y, ease: 'linear' },
      { offset: index / lines.length + SCAN.read, x: toMiddle + SCAN.reach, y, ease: 'cubic-bezier(0.4, 0, 0.2, 1)' },
    ]),
    { offset: 1, x: toMiddle - SCAN.reach, y: lines[0]!, ease: 'linear' },
  ]
}

/** Needs you: the pair turns from its resting gaze to face the reader. */
export const towardStops = (toMiddle: number): EyeStop[] => [
  { offset: 0, x: toMiddle, y: 0, ease: 'linear' },
  { offset: 1, x: toMiddle, y: 0, ease: 'linear' },
]

/**
 * Thinking: the library's pose sets the eyes at two heights, `drop` apart, and this
 * trades those heights back and forth. `side` is -1 for the left eye and 1 for the
 * right, which starts where the pose put it.
 */
export const seesawStops = (drop: number, side: -1 | 1): EyeStop[] => {
  const far = side === 1 ? -drop : drop
  return [
    { offset: 0, x: 0, y: 0, ease: 'ease-in-out' },
    { offset: 0.5, x: 0, y: far, ease: 'ease-in-out' },
    { offset: 1, x: 0, y: 0, ease: 'ease-in-out' },
  ]
}

/** One pass of each added eye move, in milliseconds. */
export const EYE_MOVE_MS = { scan: 3900, toward: 1000, seesaw: 3000 } as const

/** Where an added eye move has the eye at `progress` through its pass, for walking it home from there. */
export function eyeAt(stops: readonly EyeStop[], progress: number): Pick<EyePose, 'x' | 'y'> {
  const next = stops.findIndex((stop) => stop.offset >= progress)
  const b = stops[next < 0 ? stops.length - 1 : next]!
  const a = stops[Math.max((next < 0 ? stops.length : next) - 1, 0)]!
  const u = b.offset === a.offset ? 0 : (progress - a.offset) / (b.offset - a.offset)
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }
}
