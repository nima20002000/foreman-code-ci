import { InfoHint } from '../../../shared/ui/InfoHint'
import { useMemo } from 'react'
import { ExecutionBranch } from './ExecutionBranch'
import { useQueryClient } from '@tanstack/react-query'
import {
  readRunInspectionKey, runInspectionKey, type RepeatGraphScopeCurrent, type RunExecutionSummary, type WorkflowVersionCurrent, type WorkspaceBoardExecutionSelection,
} from '@foreman-code/contracts/current'
import { Alert, Button, Select } from '../../../shared/ui/nocturne'
import { useProtectedAccessError } from '../../../shared/api/useProtectedAccessError'
import { JobRunResult } from '../../jobs'
import { useBoardSelection } from '../../board-core'
import { assertExecutionVersion } from '../runDetailsClient'
import { useExecutionPages, useExecutionQuery, executionPagesKey, refreshFirstInspectionPage } from './queries'
import { JsonDisclosure } from './JsonValue'
import { useRunHandoffsQuery } from '../runHandoffsQuery'
import { ExecutionBindings, ExecutionEvidence, ExecutionRepetitionPicker } from './ExecutionEvidence'
import './inspection.css'

export function ExecutionInspector({ scope, version }: { scope: RepeatGraphScopeCurrent; version: WorkflowVersionCurrent }) {
  const board = useBoardSelection(), cache = useQueryClient()
  const inspection = board?.inspection ?? {}
  const selection = readRunInspectionKey(inspection.runExchangeKey)
  const relationship = version.definition.edges.find((edge) => edge.id === inspection.runRelationshipId)
  const nodeId = inspection.runNodeId ?? relationship?.target
  const node = version.definition.nodes.find((item) => item.id === nodeId)
  const unavailable = !!nodeId && !node || !!inspection.runRelationshipId && !relationship
    || !!selection.occurrenceId && !version.definition.repeat
  const filters = { workflowNodeId: nodeId, occurrenceId: selection.occurrenceId }
  const pages = useExecutionPages(scope, filters, !unavailable)
  const denied = useProtectedAccessError(pages)
  const verifiedPage = useMemo(() => {
    if (denied || unavailable) return { items: [], invalid: false }
    const unique = new Map<string, RunExecutionSummary>()
    try {
      for (const page of pages.data?.pages ?? []) for (const execution of page.items) {
        assertExecutionVersion(version, execution)
        unique.set(execution.executionId, execution)
      }
      return { items: [...unique.values()], invalid: false }
    } catch { return { items: [], invalid: true } }
  }, [pages.data, denied, unavailable, version])
  const listed = verifiedPage.items
  const select = (next: WorkspaceBoardExecutionSelection) => board?.selectInspection({
    ...(inspection.runNodeId ? { runNodeId: inspection.runNodeId } : {}),
    ...(inspection.runRelationshipId ? { runRelationshipId: inspection.runRelationshipId } : {}),
    ...(runInspectionKey(next) ? { runExchangeKey: runInspectionKey(next) } : {}),
  })
  return <section aria-label="Exact execution inputs and results" className="run-execution-inspector">
    <header><h3>Execution inputs and accepted results<InfoHint label="Execution history">History is a recorded read, not a live status feed. It changes only when you load or refresh it. Only the five most recently loaded pages are retained. Refresh returns to the first page.</InfoHint></h3>
      {(nodeId || inspection.runRelationshipId || inspection.runExchangeKey) ? <Button size="sm" onClick={() => board?.selectInspection({})}>Clear detail filter</Button> : null}
    </header>
    <Select label="Run node" value={inspection.runNodeId ?? ''} onChange={(event) =>
      board?.selectInspection(event.target.value ? { runNodeId: event.target.value } : {})} options={[
      { value: '', label: 'All nodes in this saved version' },
      ...(inspection.runNodeId && !node ? [{ value: inspection.runNodeId, label: `${inspection.runNodeId} — not in this Run` }] : []),
      ...version.definition.nodes.map((item) => ({ value: item.id, label: `${item.name ?? item.label ?? item.id} · ${item.id}` })),
    ]} />
    {unavailable ? <Alert tone="warning" title="This selection is not in the Run’s saved version.">
      A node or repetition in the current draft is not historical evidence. Clear the filter to inspect this exact version.
    </Alert> : <>
      {relationship ? <p>Relationship <code>{relationship.id}</code>: inspecting recipient <code>{relationship.target}</code>.</p> : null}
      {relationship ? <ConnectionEvidence scope={scope} relationshipId={relationship.id} /> : null}
      {node ? <JsonDisclosure disclosureKey={JSON.stringify([scope, node.id, 'saved-node'])}
        summary="Saved node configuration (this Run)" label={`Saved Run node ${node.id}`}
        value={node.kind==='job'?{node,jobDefinitionVersionId:node.jobDefinitionVersionId}:{node,agentConfigurationVersionId:version.agentConfigurationVersionIds[node.agentId]}} /> : null}
      {version.definition.repeat ? <div className="run-occurrence-picker">
        <ExecutionRepetitionPicker executions={listed} occurrenceId={selection.occurrenceId}
          onSelect={occurrenceId => select(occurrenceId ? { occurrenceId } : {})} />
      </div> : <p>This saved version has no repeat blocks.</p>}
      {denied ? <Alert tone="warning" title="Execution history access is unavailable." /> : pages.isError ? <Alert tone="warning" title="Execution history could not be refreshed.">
        Previously loaded executions stay listed. <Button size="sm" onClick={() => void refreshFirstInspectionPage(cache, executionPagesKey(scope, filters))}>Retry executions</Button>
      </Alert> : null}
      {verifiedPage.invalid ? <Alert tone="warning" title="Execution history does not match the immutable version.">No mismatched execution is displayed.</Alert> : null}
      {pages.isPaused ? <p role="status">Execution history refresh is paused. Loaded pages remain recorded history, not current state.</p>
        : pages.isPending && !denied ? <p role="status">Loading the first execution page…</p> : null}
      {!pages.isPending && !pages.isError && !denied && !verifiedPage.invalid && !listed.length ? <p>No execution is recorded for this selection.</p> : null}
      <ol className="run-execution-list">{listed.map((execution) => <li key={execution.executionId}>
        <Button size="sm" aria-pressed={selection.executionId === execution.executionId}
          onClick={() => select({ ...selection, executionId: execution.executionId })}>
          {execution.workflowNodeId} · technical attempt {execution.attempt} · {execution.executionId}
        </Button>
        <p>Recorded {execution.state}. {execution.acceptedResultAvailable ? 'An accepted result is available.' : 'No accepted result reported by this page.'}</p>
        {execution.occurrence ? <p>{execution.occurrence.blockId} · business occurrence {execution.occurrence.occurrenceIndex} · <code>{execution.occurrence.occurrenceId}</code></p> : null}
        <ExecutionBranch execution={execution} />
      </li>)}</ol>
      <div className="n-actions">
        {pages.hasNextPage && !pages.isError && !denied ? <Button size="sm" disabled={pages.isFetching && !pages.isRefetching}
          onClick={() => void pages.fetchNextPage()}>Load more executions</Button> : null}
        <Button size="sm" variant="ghost" disabled={pages.isFetching || !!denied}
          onClick={() => void refreshFirstInspectionPage(cache, executionPagesKey(scope, filters))}>Refresh executions</Button>
      </div>
      {selection.executionId && !denied ? <ExactExecution key={selection.executionId}
        scope={scope} version={version} executionId={selection.executionId} nodeId={nodeId}
        occurrenceId={selection.occurrenceId} relationshipId={inspection.runRelationshipId} /> : null}
    </>}
  </section>
}

function ConnectionEvidence({ scope, relationshipId }: { scope: RepeatGraphScopeCurrent; relationshipId: string }) {
  const query = useRunHandoffsQuery(scope, true)
  const denied = useProtectedAccessError(query)
  const connection = !denied && !query.isError ? query.data?.connections.find(item => item.relationshipId === relationshipId) : undefined
  return <section aria-label="Saved connection handoffs">
    {connection ? <p>Work handoffs: {connection.used} used · {connection.limit ?? 'unlimited'} maximum per Run · {connection.remaining ?? 'unlimited'} remaining.</p>
      : <p>{query.isPending ? 'Loading handoff usage…' : query.isError || denied ? 'Handoff usage unavailable.'
        : query.data?.policy === 'not_configured' ? 'This saved Run has no work handoff policy.' : 'No handoff usage recorded for this connection.'}</p>}
    {query.isError && !denied ? <Button size="sm" onClick={() => void query.refetch()}>Retry handoff usage</Button> : null}
  </section>
}

function ExactExecution({ scope, version, executionId, nodeId, occurrenceId, relationshipId }: {
  scope: RepeatGraphScopeCurrent; version: WorkflowVersionCurrent; executionId: string
  nodeId?: string; occurrenceId?: string; relationshipId?: string
}) {
  const board = useBoardSelection()
  const query = useExecutionQuery(scope, executionId)
  const denied = useProtectedAccessError(query)
  const checked = useMemo(() => {
    if (!query.data || denied) return undefined
    try {
      assertExecutionVersion(version, query.data.execution)
      if (nodeId && query.data.execution.workflowNodeId !== nodeId
        || occurrenceId && query.data.execution.occurrence?.occurrenceId !== occurrenceId) return undefined
      return query.data
    } catch { return undefined }
  }, [query.data, denied, version, nodeId, occurrenceId])
  if (query.isPending) return <p role="status">{query.isPaused ? 'Exact execution read is paused. No substitute result is shown.'
    : 'Reading this exact execution, accepted input and result…'}</p>
  if (!checked) return <Alert tone="warning" title="This exact execution is unavailable.">
    {denied ? 'Access was denied.' : 'The read failed or its node, occurrence, configuration or result identity did not match. No substitute result is displayed.'}
    {!denied ? <Button size="sm" onClick={() => void query.refetch()}>Retry exact execution</Button> : null}
  </Alert>
  const execution = checked.execution, occurrence = execution.occurrence
  return <article aria-label={`Execution ${executionId}`} className="run-exact-execution">
    <h4>{execution.workflowNodeId} · technical attempt {execution.attempt}</h4>
    {query.isPaused ? <p role="status">Refresh is paused. These are previously verified recorded execution facts.</p> : null}
    {execution.kind === 'job' ? <section aria-label={`Job result for execution ${executionId}`}>
      <JobRunResult key={executionId} definitionVersionId={execution.jobDefinitionVersionId} reference={{ kind: 'job',
        workspaceId: scope.workspaceId, workflowId: scope.workflowId, runId: scope.runId, workflowVersionId: scope.workflowVersionId,
        nodeId: execution.workflowNodeId, nodeExecutionId: execution.executionId,
        occurrenceId: occurrence?.occurrenceId ?? null, occurrenceIndex: occurrence?.occurrenceIndex ?? 0 }} />
    </section> : null}
    <ExecutionEvidence scope={scope} detail={checked} />
    <Button size="sm" variant="ghost" disabled={query.isFetching && !query.isRefetching} onClick={() => void query.refetch()}>Refresh exact execution</Button>
    <ExecutionBindings scope={scope} detail={checked} relationshipId={relationshipId} />
    {board?.selectSidePanel ? <Button size="sm" variant="ghost" onClick={() => board.selectSidePanel?.({
      kind: 'agent', nodeId: execution.workflowNodeId, executionId, tab: 'details',
    })}>Open node Details</Button> : null}
  </article>
}

