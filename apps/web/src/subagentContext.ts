import { createContext, useContext } from 'react'
import type { SubagentSummary } from '@manor/contracts'
import type { ChatSubagent } from './turnTrace'

/**
 * The directory's word on Manor's children, for the rows deep inside a memoised
 * transcript. A child outlives the turn that launched it, so a settled turn still
 * learns from here that its helper works on. ChatPane provides it; outside a chat
 * pane the launch rows speak for themselves.
 */
export const SubagentDirectory = createContext<((childId: string) => SubagentSummary | undefined) | undefined>(undefined)
export const useSubagentDirectory = () => useContext(SubagentDirectory)

/**
 * The helpers a transcript launched, by launch call id, and how to open one. A wake's
 * notice is a message, not a turn, so it finds the helper it reports on here.
 */
export interface SubagentLaunches {
  byCallId: ReadonlyMap<string, ChatSubagent>
  open?: ((toolCallId: string) => void) | undefined
}
export const SubagentLaunchesContext = createContext<SubagentLaunches | undefined>(undefined)
export const useSubagentLaunches = () => useContext(SubagentLaunchesContext)
