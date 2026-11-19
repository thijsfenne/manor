import { useSyncExternalStore } from 'react'
import type { SidebarSubagent, SubagentGroup } from './state'

/** One sidebar subagent row, with how deep it hangs and how many rows hang below it. */
export interface SubagentLine {
  child: SidebarSubagent
  depth: number
  descendants: number
}

/** The group's rows in order, each with the count of rows its own collapse would hide. */
export function subagentLines(group: SubagentGroup): SubagentLine[] {
  const depths = group.children.map((child) => group.depth[child.id] ?? 0)
  return group.children.map((child, index) => {
    let end = index + 1
    while (end < depths.length && depths[end]! > depths[index]!) end++
    return { child, depth: depths[index]!, descendants: end - index - 1 }
  })
}

/** The rows still shown: a collapsed row stays, everything below it goes. */
export function visibleSubagentLines(lines: readonly SubagentLine[], collapsed: ReadonlySet<string>): SubagentLine[] {
  const shown: SubagentLine[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    shown.push(line)
    if (collapsed.has(line.child.id)) index += line.descendants
  }
  return shown
}

/**
 * Every row that must stand open for the active child to be seen: the row the group
 * hangs off (`rowKey`) and each listed ancestor of that child. Empty when it is not here.
 */
export function rowsHidingActive(rowKey: string, lines: readonly SubagentLine[], activeId: string | undefined): string[] {
  const at = lines.findIndex((line) => line.child.id === activeId)
  if (at === -1) return []
  const keys = [rowKey]
  let depth = lines[at]!.depth
  for (let index = at - 1; index >= 0 && depth > 0; index--) {
    if (lines[index]!.depth < depth) {
      keys.push(lines[index]!.child.id)
      depth = lines[index]!.depth
    }
  }
  return keys
}

/**
 * The child row that carries the light for the open view: the active child, or the
 * outermost folded row that hides it. Undefined leaves the light on the row the group
 * hangs off, which is also where it stays for a helper the sidebar no longer lists.
 */
export function litSubagentId(
  rowKey: string,
  group: SubagentGroup | undefined,
  collapsed: ReadonlySet<string>,
  activeId: string | undefined,
): string | undefined {
  if (group === undefined || activeId === undefined || collapsed.has(rowKey)) return undefined
  if (!group.children.some((child) => child.id === activeId)) return undefined
  const ancestors = rowsHidingActive(rowKey, subagentLines(group), activeId).slice(1).reverse()
  return ancestors.find((id) => collapsed.has(id)) ?? activeId
}

// Which sidebar rows the user folded, for this run of the app. A Session row's key is
// its chat id, a subagent row's its child id. Nothing is written to storage.
let collapsed: ReadonlySet<string> = new Set()
const listeners = new Set<() => void>()

const publish = (next: ReadonlySet<string>) => {
  collapsed = next
  listeners.forEach((listener) => listener())
}

export function toggleSubagentRow(rowKey: string) {
  const next = new Set(collapsed)
  if (!next.delete(rowKey)) next.add(rowKey)
  publish(next)
}

/** Opens these rows; a no-op, and no render, when none of them is folded. */
export function expandSubagentRows(rowKeys: readonly string[]) {
  if (!rowKeys.some((key) => collapsed.has(key))) return
  publish(new Set([...collapsed].filter((key) => !rowKeys.includes(key))))
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
const snapshot = () => collapsed

export const useCollapsedSubagentRows = (): ReadonlySet<string> => useSyncExternalStore(subscribe, snapshot, snapshot)
