import { useEffect, useMemo, useState } from 'react'
import type { CiRunJob } from '@foreman-code/contracts'
import type { RepeatGraphScopeCurrent } from '@foreman-code/contracts/current'
import { CiServerDialog } from './CiServer'
import { ciServerFlowNode, ciServerSummary } from './ciServer'
import { useCiPlacement } from '../dock/boardObjects'

/** The draft and saved-Run Boards show the same presentation-only CI server as live inspection.
 * Without a Run scope it is idle; with one, its jobs come from the caller's CI read. */
export function useBoardCiServer({ nodes, names, workflow, scope, jobs, truncated = false, error = false, loading = false, keepPlace = false }: {
  nodes: Parameters<typeof ciServerFlowNode>[0]; names: ReadonlyMap<string, string>
  /** Keep the server where it first appears, so adding or removing Agents never moves it (the editable Board). */
  keepPlace?: boolean
  workflow: { workspaceId: string; workflowId: string }; scope?: RepeatGraphScopeCurrent; jobs?: readonly CiRunJob[] | undefined
  truncated?: boolean; error?: boolean; loading?: boolean
}) {
  const [open, setOpen] = useState(false)
  const summary = useMemo(() => !scope || jobs ? ciServerSummary(jobs ?? []) : {
    ...ciServerSummary([]), state: 'unavailable' as const, label: error ? 'CI unavailable' : 'Loading CI',
  }, [scope, jobs, error])
  const place = useCiPlacement(workflow)
  const { position, size, closed, close } = place
  const node = useMemo(() => closed ? undefined : ciServerFlowNode(nodes, summary, () => setOpen(true), { position, size, close }),
    [nodes, summary, position, size, closed, close])
  const moved = place.moved, autoSpot = !position && node ? node.position : undefined
  useEffect(() => { if (keepPlace && autoSpot) moved(autoSpot) }, [keepPlace, autoSpot, moved])
  const dialog = <CiServerDialog open={open} onOpenChange={setOpen} scope={scope} workflow={workflow} jobs={jobs ?? []} names={names}
    truncated={truncated} error={error} loading={loading} />
  return { node, dialog, summary, place }
}
