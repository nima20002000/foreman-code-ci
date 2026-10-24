import { createContext } from 'react'
import type { CiRunJob } from '@foreman-code/contracts'
import type { RepeatGraphScopeCurrent } from '@foreman-code/contracts/current'
import type { AgentNodeState, AgentNodeTransition } from '../../shared/ui/nocturne'
import type { EdgeSignal } from './signalEdge'

export type RunLiveNodeView = { state: AgentNodeState; label: string; transition?: AgentNodeTransition; transitionKey?: number }
export type RunLivePulse = { key: string; signal: EdgeSignal; reversed: boolean; startsAt: number; word?: string }
/** Live node words beside the Board's own node data, so a poll never rebuilds React Flow's nodes. */
export const RunLiveNodes = createContext<ReadonlyMap<string, RunLiveNodeView> | undefined>(undefined)
/** Pulses crossing each drawn line while Agents hand work to each other. */
export const RunLivePulses = createContext<ReadonlyMap<string, readonly RunLivePulse[]>>(new Map())

/** The displayed Run's CI read, shared with the retained draft's server and transfer lights. */
export const RunLiveCi = createContext<{
  scope: RepeatGraphScopeCurrent; names: ReadonlyMap<string, string>; jobs?: readonly CiRunJob[] | undefined
  truncated: boolean; error: boolean; loading: boolean; readError: unknown; onRefresh(): void
} | undefined>(undefined)
