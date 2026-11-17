/**
 * One orb, four states. Idle stays a hollow ring so the slot never jumps. A run in
 * flight fills it busy blue, an unread run fills it green, or danger red when the
 * caller marks that run failed. The fill runs once per change, it never pulses.
 */
export function RoutineDot({ running, waiting, failed }: { running: boolean; waiting: boolean; failed: 'Failed' | null }) {
  const label = running ? 'Running' : failed ?? (waiting ? 'New result' : 'Nothing new')
  const shown = running || failed !== null || waiting
  return (
    <span
      aria-label={label}
      title={shown ? label : undefined}
      role={shown ? 'img' : undefined}
      className={`h-1.5 w-1.5 flex-none rounded-full border duration-200 ease-fade motion-safe:transition-[background-color,border-color] ${
        running
          ? 'border-busy bg-busy'
          : failed !== null
            ? 'border-danger bg-danger'
            : waiting
              ? 'border-ok bg-ok'
              : 'border-dim/70 bg-transparent'
      }`}
    />
  )
}
