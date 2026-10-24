import { createContext } from 'react'
import type { RunBoardSnapshot } from '@foreman-code/contracts/run-snapshots'
import type { AgentNodeState, AgentNodeTransition } from '../../shared/ui/nocturne'
import type { EdgeSignal } from './signalEdge'

export type RunLiveNodeView = { state: AgentNodeState; label: string; transition?: AgentNodeTransition; transitionKey?: number }
export type RunLivePulse = { key: string; signal: EdgeSignal; reversed: boolean; startsAt: number; word?: string }
/** Live node words beside the Board's own node data, so a poll never rebuilds React Flow's nodes. */
export const RunLiveNodes = createContext<ReadonlyMap<string, RunLiveNodeView> | undefined>(undefined)
/** Pulses crossing each drawn line while Agents hand work to each other. */
export const RunLivePulses = createContext<ReadonlyMap<string, readonly RunLivePulse[]>>(new Map())

/** The validated snapshot displayed on the draft Board, for its existing Run readers. */
export const RunDisplayedSnapshot = createContext<Extract<RunBoardSnapshot, { kind: 'available' }> | undefined>(undefined)
