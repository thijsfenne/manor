/**
 * What a persona is in the house, worn next to her name. The tool pill's shape,
 * static: a quieter fill than `bg-picked` so a row of roles does not shout like a
 * set of toggles. The label is muted, as it is on the phone: it names the person
 * beside it and is not the line being read.
 *
 * Sized for the sidebar, where the name it sits beside is 14px and the row is a
 * list item rather than a card. Deliberately one step under the 12px metadata
 * floor, by decision: at that name's size the chip read as a second label
 * rather than a mark.
 */
export function RoleBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex max-w-full min-w-0 items-center rounded-md bg-role-badge px-1 py-px text-[11px] leading-4 font-medium text-muted">
      <span className="min-w-0 truncate">{label}</span>
    </span>
  )
}
