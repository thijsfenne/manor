import { settleFace, type FaceMoment, type FaceState, type ShownFace } from '@manor/client-runtime/face-activity'
import { useEffect, useRef, useState } from 'react'

/**
 * What a face shows about its turn right now.
 *
 * `asked` is what the turn asks for while it is live. Two things are added here,
 * because they are about time and a row model has none. One kind of work gives way to
 * the next only after a hold, so a run of quick calls cannot make the face twitch.
 * And a turn that stops running is marked once, with `ended`, for a moment: nothing
 * else records that it just happened, so the edge is caught here. A turn that was
 * already over when this mounted is history and gets no mark.
 */
export function useFaceState(asked: FaceState | undefined, ended: FaceMoment | undefined, running: boolean): FaceState | undefined {
  const [shown, setShown] = useState<ShownFace>({ state: undefined, since: 0 })
  const held = useRef(shown)
  const [mark, setMark] = useState<FaceMoment>()
  // Caught while rendering, so the mark lands in the commit the turn stops in. An
  // effect would show one frame of a resting face between the work and its ending.
  // `ended` is read at the edge; a note that lands later is not a second ending.
  const [wasRunning, setWasRunning] = useState(running)
  if (wasRunning !== running) {
    setWasRunning(running)
    setMark(running ? undefined : ended)
  }

  const want = asked ?? mark
  useEffect(() => {
    let timer: number | undefined
    const look = () => {
      const next = settleFace(held.current, want, Date.now())
      if (next.shown !== held.current) {
        held.current = next.shown
        setShown(next.shown)
        // The mark has had its moment; left standing it would come straight back on.
        if (next.shown.state === undefined && want !== undefined) setMark(undefined)
      }
      if (next.again !== undefined) timer = window.setTimeout(look, next.again)
    }
    look()
    return () => window.clearTimeout(timer)
  }, [want])

  return shown.state
}
