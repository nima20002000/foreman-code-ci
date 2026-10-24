import { useEffect, useMemo, useRef, useState } from 'react'
import type { CiRunJob } from '@foreman-code/contracts'
import type { EdgePulse } from '../../graph'
import { ciGroupStates, ciTransfers, type CiGroupStates } from './ciServer'

const FLIGHT_MS = 1400, RESULT_DELAY_MS = 1700, SETTLE_MS = 2200
/** Lights for CI requests leaving an Agent and results returning to it, keyed by the Agent's node. The first read
 * replays nothing, and nothing travels under reduced motion. */
export function useCiTransfers(jobs: readonly CiRunJob[] | undefined, reduced: boolean, scopeKey?: string) {
  const previous = useRef<{ scopeKey?: string; groups?: CiGroupStates }>({ scopeKey })
  const [shown, setShown] = useState<{ scopeKey?: string; flights: { nodeId: string; pulse: EdgePulse }[] }>({ scopeKey, flights: [] })
  const flights = useMemo(() => shown.scopeKey === scopeKey ? shown.flights : [], [shown, scopeKey])
  useEffect(() => {
    if (previous.current.scopeKey !== scopeKey) {
      previous.current = { scopeKey }
      setShown({ scopeKey, flights: [] })
    }
    if (!jobs) return
    const next = ciGroupStates(jobs)
    const transfers = ciTransfers(previous.current.groups, next)
    previous.current = { scopeKey, groups: next }
    if (reduced || !transfers.length) return
    const now = performance.now()
    const requested = new Set(transfers.filter((transfer) => transfer.direction === 'request').map((transfer) => transfer.key.split(':')[0]))
    setShown((current) => ({ scopeKey, flights: [...(current.scopeKey === scopeKey ? current.flights : []), ...transfers.map((transfer) => ({ nodeId: transfer.nodeId, pulse: {
      key: transfer.key, reversed: transfer.direction === 'result',
      signal: transfer.direction === 'request' ? 'task' as const : transfer.outcome === 'passed' ? 'grant' as const : 'error' as const,
      word: transfer.direction === 'request' ? 'CI request' : `CI ${transfer.outcome}`,
      startsAt: now + (transfer.direction === 'result' && requested.has(transfer.key.split(':')[0]) ? RESULT_DELAY_MS : 0) } }))] }))
  }, [jobs, reduced, scopeKey])
  useEffect(() => {
    if (!flights.length) return
    const ends = flights.map((flight) => flight.pulse.startsAt + FLIGHT_MS + SETTLE_MS)
    const timer = setTimeout(() => {
      const now = performance.now()
      setShown((current) => ({ ...current, flights: current.flights.filter((flight) => flight.pulse.startsAt + FLIGHT_MS + SETTLE_MS > now) }))
    }, Math.max(0, Math.min(...ends) - performance.now()))
    return () => clearTimeout(timer)
  }, [flights])
  const byNode = new Map<string, EdgePulse[]>()
  for (const flight of flights) byNode.set(flight.nodeId, [...byNode.get(flight.nodeId) ?? [], flight.pulse])
  return byNode
}
