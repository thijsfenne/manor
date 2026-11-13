import type { AgentConfig } from '@manor/contracts'
import { knownAgentIds, personaOf } from '../../state'
import { Avatar } from '../Avatar'

/** Past this the stack stops being a glance and starts being a list. */
const MAX_SHOWN = 3

/** A compact square has room for one face in every corner. */
const MAX_PLACED = 4

interface AgentStackProps {
  agentIds: string[]
  agents: AgentConfig[]
  size: number
  /**
   * Fixed square footprint for a compact cluster. Without it the existing horizontal
   * stack is kept, which is what the inbox uses where several faces may take space.
   */
  footprint?: number
}

/**
 * Who is in a thread, at a glance: their faces overlapping, most recent speaker
 * first and therefore on top. The row stops at three; a fixed footprint uses every
 * corner for four and adds a small count badge without displacing a face.
 *
 * No ring around a face. A ring is how overlapping circular portraits stay apart,
 * and these are not circles: it drew a hoop around a creature that does not fill
 * one, which read as a frame the face was sitting inside. The silhouettes are
 * distinct enough to overlap bare, and they overlap less far for the same reason.
 */
export function AgentStack({ agentIds: requested, agents, size, footprint }: AgentStackProps) {
  const agentIds = knownAgentIds(agents, requested)
  // An empty footprint still holds its square, so the text beside it keeps its x.
  if (agentIds.length === 0) {
    return footprint === undefined ? null : <span className="block flex-none" style={{ width: footprint, height: footprint }} />
  }

  if (footprint !== undefined) {
    const visibleIds = agentIds.slice(0, MAX_PLACED)
    const hidden = agentIds.length - visibleIds.length
    const offset = footprint - size
    const positions =
      visibleIds.length === 1
        ? [{ left: offset / 2, top: offset / 2 }]
        : visibleIds.length === 2
          ? [{ left: 0, top: 0 }, { left: offset, top: offset }]
          : visibleIds.length === 3
            ? [
                { left: 0, top: 0 },
                { left: offset, top: 0 },
                { left: offset / 2, top: offset },
              ]
            : [
                { left: 0, top: 0 },
                { left: offset, top: 0 },
                { left: 0, top: offset },
                { left: offset, top: offset },
              ]
    const badge = Math.round(size * 0.55)
    const names = agentIds.map((agentId) => personaOf(agents, agentId).name).join(', ')

    return (
      <span
        className="relative block flex-none"
        data-agent-layout="cluster"
        style={{ width: footprint, height: footprint }}
        title={names}
      >
        {visibleIds.map((agentId, index) => {
          const persona = personaOf(agents, agentId)
          return (
            <span
              key={agentId}
              className="absolute"
              style={{ ...positions[index], zIndex: visibleIds.length - index }}
            >
              <Avatar name={persona.name} color={persona.color} src={persona.avatar} shape={persona.avatarShape} tone={persona.avatarTone} size={size} />
            </span>
          )
        })}
        {hidden > 0 ? (
          <span
            className="absolute grid place-items-center rounded-full bg-surface-2 leading-none font-medium text-muted"
            style={{ right: 0, bottom: 0, zIndex: visibleIds.length + 1, width: badge, height: badge, fontSize: Math.round(badge * 0.52) }}
          >
            +{hidden}
          </span>
        ) : null}
      </span>
    )
  }

  const shown = agentIds.slice(0, MAX_SHOWN)
  const hidden = agentIds.length - shown.length
  const names = agentIds.map((agentId) => personaOf(agents, agentId).name).join(', ')

  return (
    // Reversed in the DOM and again in the flex direction, so the first persona
    // paints over the second rather than under it, with no z-index per face.
    // `isolate` keeps the count's one z-index below from meaning anything outside
    // this cluster: the row it sits in is not a stacking context of its own.
    <span className="isolate flex flex-none flex-row-reverse items-center" title={names}>
      {hidden > 0 ? (
        // The count joins the stack rather than trailing it: a quarter of a face over
        // the last one, so the row reads as one cluster instead of faces plus a chip.
        // A quarter and not the faces' own overlap, because this is a filled disc and
        // they are not — it hides whatever it covers, where a silhouette only nests.
        //
        // `relative z-10` is what puts it on top. It is the first child in a reversed
        // row and every face is positioned too (they carry the working dots), so plain
        // paint order has all of them above it, and a face crossing the count would cut
        // into the digits rather than the other way round.
        <span
          className="relative z-10 grid flex-none place-items-center rounded-full bg-surface-2 leading-none font-medium text-muted"
          style={{
            width: size,
            height: size,
            fontSize: Math.round(size * 0.42),
            marginLeft: -Math.round(size / 4),
          }}
        >
          +{hidden}
        </span>
      ) : null}
      {[...shown].reverse().map((agentId, index) => {
        const persona = personaOf(agents, agentId)
        return (
          <span
            key={agentId}
            // Every face but the last one drawn (which is the first in the list)
            // slides under the one before it.
            className={`flex-none ${index === shown.length - 1 ? '' : '-ml-2.5'}`}
          >
            <Avatar name={persona.name} color={persona.color} src={persona.avatar} shape={persona.avatarShape} tone={persona.avatarTone} size={size} />
          </span>
        )
      })}
    </span>
  )
}
