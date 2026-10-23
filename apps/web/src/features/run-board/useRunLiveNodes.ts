import { createContext, useEffect, useMemo, useState } from 'react'
import type { CiActivity } from '@foreman-code/contracts'
import type { RunBoardEdgeSnapshot } from '@foreman-code/contracts/run-snapshots'
import type { RepeatGraphScopeCurrent } from '@foreman-code/contracts/current'
import type { AgentNodeState, AgentNodeTransition } from '../../shared/ui/nocturne'
import { relationshipLines } from '../board-core'
import type { EdgePulse } from '../graph'
import { useInteractionsQuery } from '../../shared/api/query'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import {
  useCurrentRunQuery, useRunHandoffsQuery, useRunChoreography, runningIntervalChecks, interactionWaits,
  isActiveCi, liveNodeView, useRunDirectionWait, withDirectionWait,
} from '../workflow-board'
import { ciNodePresentation } from './ciPresentation'

export type RunLiveNodeView = { state: AgentNodeState; label: string; transition?: AgentNodeTransition; transitionKey?: number }
/** Live node words beside the saved Board's immutable node data, so a poll never rebuilds React Flow's nodes. */
export const RunLiveNodes = createContext<ReadonlyMap<string, RunLiveNodeView> | undefined>(undefined)
/** Pulses crossing each drawn line while Agents hand work to each other, the same lights the draft Board's Run shows. */
export const RunLivePulses = createContext<ReadonlyMap<string, readonly EdgePulse[]>>(new Map())

/** Each node's turn, queue, CI and pending-decision state from the Run's canonical current cut.
 * Reads only while the Board is shown; a denied or failed read leaves the saved presentation. */
export function useRunLiveNodes(scope: RepeatGraphScopeCurrent, names: ReadonlyMap<string, string>,
  cis: ReadonlyMap<string, CiActivity>, visible: boolean, edges: readonly RunBoardEdgeSnapshot[]) {
  const current = useCurrentRunQuery(visible ? scope : undefined, visible)
  const denied = useProtectedAccessError(current)
  const record = denied || current.isError ? undefined : current.data
  const live = Boolean(visible && record && record.state.run.executionState !== 'completed')
  // The same pending-request read as the approval inbox; this Run's requests name why its Agents wait.
  const pending = useInteractionsQuery({ workspaceId: scope.workspaceId, workflowId: scope.workflowId, status: 'pending', limit: 100 }, live)
  const direction = useRunDirectionWait(live ? scope : undefined)
  const waits = useMemo(() => withDirectionWait(interactionWaits(record, pending.isError ? [] : pending.data?.items ?? [], names), direction),
    [record, pending.data, pending.isError, names, direction])
  const checking = useMemo(() => live ? runningIntervalChecks(record) : new Map<string, { check: number; queued: boolean }>(), [record, live])
  // Work hand-offs are read beside the cut. A new cut is shown once the hand-offs read has caught up with it,
  // so a receiver never starts its work before the light carrying that work has left.
  const working = Boolean(visible && record?.state.executions.some((execution) => execution.workActivationId))
  const handoffs = useRunHandoffsQuery(scope, working)
  const { refetch } = handoffs
  const [caughtUp, setCaughtUp] = useState(record)
  useEffect(() => {
    if (!working) return
    let current = true
    void refetch().then(() => { if (current) setCaughtUp(record) })
    return () => { current = false }
  }, [working, record, refetch])
  const shown = working ? caughtUp : record
  const choreography = useRunChoreography(shown, edges, working ? handoffs.data?.transfers : undefined)
  // One line per agent pair: an approval beside a handoff travels on the handoff's line.
  const lines = useMemo(() => relationshipLines(edges), [edges])
  const flights: [string, EdgePulse[]][] = []
  for (const [id, items] of choreography.pulses) {
    const line = lines.alias.get(id)
    if (line) flights.push([line.lineId, items.map(({ key, signal, reversed, startsAt, word }) => ({ key, signal, startsAt,
      reversed: reversed !== line.flipped, ...(word ? { word } : {}) }))])
  }
  const flightKey = JSON.stringify(flights)
  const pulses = useMemo(() => {
    const merged = new Map<string, EdgePulse[]>()
    for (const [lineId, items] of JSON.parse(flightKey) as [string, EdgePulse[]][]) merged.set(lineId, [...merged.get(lineId) ?? [], ...items])
    for (const items of merged.values()) items.sort((a, b) => a.startsAt - b.startsAt)
    return merged
  }, [flightKey])
  const views: [string, RunLiveNodeView][] = []
  for (const nodeId of names.keys()) {
    const ci = cis.get(nodeId)
    const base = shown ? choreography.nodes.get(nodeId) ?? { state: 'idle' as const, label: 'Not started' } : undefined
    // Without the current cut a node still says it waits on its CI, or shows that CI's result.
    if (!base) { if (ci) views.push([nodeId, isActiveCi(ci) ? liveNodeView(ciNodePresentation(ci), undefined, ci) : ciNodePresentation(ci)]); continue }
    const view = liveNodeView(base, waits.get(nodeId), ci, undefined, checking.get(nodeId))
    views.push([nodeId, { state: view.state, label: view.label,
      ...(base.transition && view.state === base.state ? { transition: base.transition, transitionKey: base.transitionKey } : {}) }])
  }
  const key = views.length ? JSON.stringify(views) : undefined
  const nodes = useMemo(() => key ? new Map(JSON.parse(key) as [string, RunLiveNodeView][]) : undefined, [key])
  return { nodes, pulses }
}
