import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import { useLocalHumanAccessQuery } from '../../../shared/api/settingsExperience'
import { useProtectedAccessError } from '../../../shared/api/useProtectedAccessError'
import { Button } from '../../../shared/ui/nocturne'
import { canUseBoardAction } from '../permissions'
import { hierarchyKey } from '../../workflow-hierarchy/queries'
import { runActionsClient, type RunActionSelection } from './client'
import { actionKey } from './state'
import { needsRunRefresh, type ActionRun } from './policy'
import { useRunStop } from './useRunStop'
import './actions.css'

/** One plain Stop button in the Board toolbar while the selected Run runs. It sends the Board's exact Stop
 * command (journal, receipt, resend of the same stop); a finished Run with nothing to clean up shows nothing. */
export function SelectedRunControls({ scope, visible }: {
  scope: RunActionSelection & Partial<Pick<RepeatGraphScopeV3, 'workflowVersionId'>>
  visible: boolean
}) {
  const access = useLocalHumanAccessQuery(), cache = useQueryClient()
  const principal = access.isError ? undefined : access.data?.principal
  const live = !!principal && Date.parse(principal.expiresAt) > Date.now()
  const read = live && canUseBoardAction(principal.grants, 'runs:read', scope)
  const permitted = live && canUseBoardAction(principal.grants, 'runs:stop', scope)
  const status = useQuery({ queryKey: actionKey(scope, 'status', scope.workflowVersionId ?? null), enabled: read,
    queryFn: ({ signal }) => runActionsClient.status(scope, { signal }), staleTime: 1000, gcTime: 0,
    refetchOnWindowFocus: true, refetchOnReconnect: true,
    refetchInterval: query => query.state.error ? false : query.state.data && needsRunRefresh(query.state.data) ? 5000 : false,
    refetchIntervalInBackground: false })
  const capability = useQuery({ queryKey: actionKey(scope, 'capabilities'), enabled: read,
    queryFn: ({ signal }) => runActionsClient.capabilities({ signal }), staleTime: 30_000, gcTime: 0 })
  const denied = useProtectedAccessError(status)
  const refresh = () => {
    void status.refetch(); void capability.refetch()
    void cache.invalidateQueries({ queryKey: hierarchyKey({ workspaceId: scope.workspaceId,
      workflowId: scope.workflowId, runId: scope.runId }), exact: true })
  }
  const run = status.data
  if (run?.executionState === 'completed' && !run.cleanupPending) return null
  const reason = access.isError ? 'Couldn’t read your access. Try again in a moment.'
    : !access.isPending && (!read || denied) ? 'You can’t stop this run.'
      : status.isError || capability.isError ? 'Run status couldn’t be refreshed.'
        : !access.isPending && !permitted ? 'You can’t stop this run.'
          : capability.data && !capability.data.stopAvailable ? 'Stop isn’t available right now.' : undefined
  return <section className="selected-run-controls" aria-label="Selected Run controls" hidden={!visible} inert={!visible}>
    {run ? <StopButton scope={{ workspaceId: scope.workspaceId, workflowId: scope.workflowId, runId: scope.runId,
      workflowVersionId: run.workflowVersionId, executionSemanticsVersion: 3 }} run={run}
    reason={reason} ready={!!capability.data} refresh={refresh} />
      : <Button size="sm" variant="danger" disabled title={reason}>Stop</Button>}
  </section>
}

function StopButton({ scope, run, reason, ready, refresh }: {
  scope: RepeatGraphScopeV3; run: ActionRun; reason?: string; ready: boolean; refresh(): void
}) {
  const { stop, outbox } = useRunStop(scope, refresh)
  const receipt = outbox.journal?.receipt ?? stop.data
  // Sent and accepted: the Run is shutting down; the button waits for it instead of offering a second stop.
  const stopping = stop.isPending || !!receipt && receipt.status !== 'not_owner'
  const why = reason ?? outbox.error ?? (receipt?.status === 'not_owner' ? 'Another app instance runs this, so the stop isn’t confirmed.' : undefined)
  return <>
    <Button size="sm" variant="danger" disabled={!!reason || !!outbox.error || !ready || stopping} title={why}
      onClick={() => stop.mutate()}>{stopping ? 'Stopping…' : 'Stop'}</Button>
    {stop.isError ? <span role="alert" className="selected-run-stop-error">Stop is not confirmed: {stop.error.message} Press Stop to resend it.</span> : null}
    {run.cleanupPending ? <span role="status" className="selected-run-stop-error">Cleaning up…</span> : null}
  </>
}
