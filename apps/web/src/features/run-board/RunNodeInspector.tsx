import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query'
import type { RunBoardNodeSnapshot } from '@foreman-code/contracts/run-snapshots'
import { readRunInspectionKey, runInspectionKey, type RepeatGraphScopeCurrent, type RunExecutionSummary } from '@foreman-code/contracts/current'
import { agentProductRoleLabel, type WorkflowHierarchyReadResult } from '@foreman-code/contracts'
import { useHarnessSessionEpoch } from '../../shared/api/harnessSettings'
import { sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { ApiError } from '../../shared/api/client'
import { useBlockingReadError } from '../../shared/api/readFailure'
import { Button, Icon, IconButton } from '../../shared/ui/nocturne'
import { type SelectedRunState, isRunAccessError, runReadErrorLabel } from '../runs-selector'
import { PinnedProviderAccount } from '../provider-accounts'
import { SelectedNodePlacement } from '../node-placement'
import { readRunExecution, readRunExecutions, ExecutionBranch, ExecutionBindings, ExecutionEvidence, ExecutionRepetitionPicker, refreshFirstInspectionPage } from '../workflow-board'
import { useBoardSelection } from '../board-core'
import { JobRunResult } from '../jobs'
import type { AvailableRunBoardSnapshot } from './model'
import { readForRunVisit, runNodeInspectionKey, useRunNodeRead } from './inspectionQuery'
import { AgentExecutionResults } from './AgentExecutionResults'
import '../workflow-board/inspect/inspection.css'

function matchesNode(node: RunBoardNodeSnapshot, execution: RunExecutionSummary) {
  if (node.id !== execution.workflowNodeId) return false
  if (node.kind === 'job') return execution.kind === 'job'
    && node.jobDefinitionId === execution.jobDefinitionId
    && node.jobDefinitionVersionId === execution.jobDefinitionVersionId
  return execution.kind !== 'job' && node.agentId === execution.agentId
    && node.agentConfigurationVersionId === execution.agentConfigurationVersionId
}

export function RunNodeInspector({ selection, snapshot, nodeId, executionId, onInspect, hierarchy, repeat = false, closable = true }: {
  selection: SelectedRunState; snapshot: AvailableRunBoardSnapshot; nodeId: string;
  executionId?: string; onInspect(nodeId?: string, executionId?: string): void
  hierarchy?: WorkflowHierarchyReadResult
  repeat?: boolean
  /** False inside a panel that has its own close. */
  closable?: boolean
}) {
  useHarnessSessionEpoch()
  const board = useBoardSelection()
  const exchange = board?.inspection.runNodeId === nodeId ? readRunInspectionKey(board.inspection.runExchangeKey) : undefined
  const occurrenceId = exchange?.occurrenceId
  const selectedExecutionId = exchange ? exchange.executionId : executionId
  const client = useQueryClient()
  const node = snapshot.nodes.find(item => item.id === nodeId)
  const saved = hierarchy?.workflowVersionId === snapshot.workflowVersionId && hierarchy.run?.runId === snapshot.runId
    && hierarchy.workspaceId === snapshot.workspaceId && hierarchy.workflowId === snapshot.workflowId ? hierarchy : undefined
  const identity = node?.kind !== 'job' && node ? saved?.agents.find(agent => agent.workflowNodeId === nodeId
    && agent.agentId === node.agentId && agent.configurationVersionId === node.agentConfigurationVersionId) : undefined
  const parentId = saved?.hierarchy?.parents.find(member => member.workflowNodeId === nodeId)?.parentNodeId
  const parent = parentId ? snapshot.nodes.find(item => item.id === parentId) : undefined
  const scope: RepeatGraphScopeCurrent = { workspaceId: snapshot.workspaceId, workflowId: snapshot.workflowId,
    runId: snapshot.runId, workflowVersionId: snapshot.workflowVersionId, executionSemanticsVersion: 3 }
  const queryKey = [...runNodeInspectionKey(selection), nodeId, 'executions']
  const pages = useInfiniteQuery({
    queryKey,
    queryFn: ({ signal, pageParam }) => readForRunVisit(selection, signal,
      () => readRunExecutions(scope, { workflowNodeId: nodeId }, pageParam, { signal })),
    initialPageParam: null as string | null,
    getNextPageParam: (page, _pages, _param, params) => page.pageInfo.nextCursor
      && !params.includes(page.pageInfo.nextCursor) ? page.pageInfo.nextCursor : undefined,
    enabled: Boolean(node) && !sessionIsSwitching(), staleTime: 0, gcTime: 0, maxPages: 5,
    refetchInterval: query => isRunAccessError(query.state.error) ? false : 3000,
  })
  const blocked = useBlockingReadError(pages)
  if (!selection.isCurrent(selection.generation) || sessionIsSwitching()) return null
  const items = pages.data?.pages.flatMap(page => page.items) ?? []
  const listed = occurrenceId ? items.filter(item => item.occurrence?.occurrenceId === occurrenceId) : items
  const invalid = node && items.some(item => !matchesNode(node, item))
  const unavailable = Boolean(blocked) || invalid || pages.isError && !pages.data
  const runFailure = pages.data?.pages[0]?.run.failure
  const reportsTo = !saved?.hierarchy || saved.hierarchy.masterNodeId === nodeId ? undefined : parent?.name ?? 'Unavailable'
  return <section className="run-execution-inspector" aria-label={`Run node inspector: ${node?.name ?? nodeId}`}>
    <header className="run-node-inspector-head"><h2 className="n-sr-only">{node?.name ?? nodeId}</h2>
      {node && node.kind !== 'job' ? <p className="run-node-facts" aria-label="Saved Agent identity">
        {identity ? agentProductRoleLabel(identity.productRole) : 'Agent'}{reportsTo ? <> · Reports to <strong>{reportsTo}</strong></> : null}
      </p> : <span />}
      {node ? <IconButton size="sm" variant="ghost" label="Refresh node executions" disabled={pages.isFetching && !pages.isRefetching}
        onClick={() => void refreshFirstInspectionPage(client, queryKey)}><Icon name="refresh" size={14} /></IconButton> : null}
      {closable ? <IconButton size="sm" variant="ghost" label="Close inspector" onClick={() => onInspect()}><Icon name="close" size={14} /></IconButton> : null}
    </header>
    {!node ? <p role="status">This node is not in the saved Run.</p> : <>
      {node.kind !== 'job' ? <PinnedProviderAccount binding={snapshot.providerAccountBindings?.[node.id]} label="Saved Run account" /> : null}
      <SelectedNodePlacement selection={selection} nodeId={node.id} />
      {pages.isError && !unavailable ? <p role="status" className="run-node-note">Couldn’t refresh. Showing the last read.</p> : null}
      {unavailable ? <p role="status">{invalid ? 'Execution does not match this saved node.' : runReadErrorLabel(pages.error)}</p> : <>
        {pages.isPending ? <p role="status" className="run-node-note">Reading node executions…</p> : null}
        {runFailure ? <p role="status" className="run-node-error">Run failed: {runFailure.message}</p> : null}
        {!pages.isPending && !items.length ? <p className="run-node-note">No execution recorded for this node yet.</p> : null}
        {pages.data?.pageParams[0] ? <p className="run-node-note">Earlier executions are hidden. Refresh to return to the first page.</p> : null}
        {board && (repeat || items.some(item => item.occurrence)) ? <ExecutionRepetitionPicker executions={items} occurrenceId={occurrenceId}
          onSelect={occurrenceId => board.selectInspection({ runNodeId: node.id,
            runExchangeKey: runInspectionKey(occurrenceId ? { occurrenceId } : {}) })} /> : null}
        {listed.length ? <ol className="run-node-attempts">{listed.map(execution => <li key={execution.executionId}>
          <button type="button" className="run-node-attempt" aria-pressed={selectedExecutionId === execution.executionId}
            aria-label={`Attempt ${execution.attempt} · ${execution.executionId}`} title={execution.executionId}
            onClick={() => board ? board.selectInspection({ runNodeId: node.id,
              runExchangeKey: runInspectionKey({ executionId: execution.executionId, occurrenceId: execution.occurrence?.occurrenceId }) })
              : onInspect(node.id, execution.executionId)}>
            <span>Attempt {execution.attempt}</span>
            <span className="run-node-attempt-state" data-state={execution.failure ? 'failed' : execution.state}>
              {execution.failure ? 'Failed' : stateLabel(execution.state)}</span>
          </button>
          {execution.failure ? <p role="status" className="run-node-error">Agent failed: {execution.failure.message}</p> : null}
          <ExecutionBranch execution={execution} />
        </li>)}</ol> : null}
        {pages.hasNextPage ? <Button size="sm" variant="ghost" disabled={pages.isFetching && !pages.isRefetching}
          onClick={() => void pages.fetchNextPage()}>Load more executions</Button> : null}
        {selectedExecutionId ? <NodeExecutionResult key={selectedExecutionId} selection={selection} scope={scope}
          node={node} executionId={selectedExecutionId} occurrenceId={occurrenceId} /> : null}
      </>}
    </>}
  </section>
}

/** "waiting_for_ci" → "Waiting for ci"; states are plain words, never codes. */
function stateLabel(state: string) {
  const words = state.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function NodeExecutionResult({ selection, scope, node, executionId, occurrenceId }: {
  selection: SelectedRunState; scope: RepeatGraphScopeCurrent; node: RunBoardNodeSnapshot; executionId: string
  occurrenceId?: string
}) {
  const board = useBoardSelection()
  const query = useRunNodeRead(selection, [node.id, executionId], signal => readRunExecution(scope, executionId, { signal }))
  const blocked = useBlockingReadError(query)
  if (!selection.isCurrent(selection.generation) || sessionIsSwitching()) return null
  if (blocked || query.isError && !query.data) return <p role="status">
    Execution result unavailable. {ApiError.is(query.error) ? query.error.message : runReadErrorLabel(query.error)}
  </p>
  if (query.data && (!matchesNode(node, query.data.execution)
    || occurrenceId && query.data.execution.occurrence?.occurrenceId !== occurrenceId)) return <p role="status">
    Execution result unavailable. Execution does not match this saved node.
  </p>
  if (!query.data) return <p role="status">Reading execution result…</p>
  const detail = query.data
  const execution = detail.execution
  const occurrence = execution.occurrence
  return <article aria-label={`Execution ${executionId}`}>
    {query.isError ? <p role="status">Result refresh failed. Showing the last successful read.</p> : null}
    <ExecutionBranch execution={execution} />
    {execution.kind === 'job' ? <JobRunResult definitionVersionId={execution.jobDefinitionVersionId}
      reference={{ kind: 'job', workspaceId: scope.workspaceId, workflowId: scope.workflowId,
        runId: scope.runId, workflowVersionId: scope.workflowVersionId, nodeId: node.id,
        nodeExecutionId: execution.executionId, occurrenceId: occurrence?.occurrenceId ?? null,
        occurrenceIndex: occurrence?.occurrenceIndex ?? 0 }} />
      : <AgentExecutionResults selection={selection} scope={scope} execution={execution} name={node.name}
        acceptedResult={detail.acceptedResult} />}
    <details><summary>Accepted input and results</summary>
      <ExecutionEvidence scope={scope} detail={detail} />
    </details>
    <ExecutionBindings scope={scope} detail={detail} />
    {board ? <Button size="sm" variant="ghost" onClick={() => {
      board.selectInspection({ runNodeId: node.id, runExchangeKey: runInspectionKey({ executionId, occurrenceId: occurrence?.occurrenceId }) })
      board.openRuns()
    }}>Inspect in Activities</Button> : null}
  </article>
}
