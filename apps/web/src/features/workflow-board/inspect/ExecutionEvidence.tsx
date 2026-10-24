import { useQueryClient } from '@tanstack/react-query'
import type { RepeatGraphScopeCurrent, RunExecutionDetail, RunExecutionSummary } from '@foreman-code/contracts/current'
import { InfoHint } from '../../../shared/ui/InfoHint'
import { Alert, Button, Select } from '../../../shared/ui/nocturne'
import { useProtectedAccessError } from '../../../shared/api/useProtectedAccessError'
import { JsonValue, JsonDisclosure } from './JsonValue'
import { useBindingPages, bindingsPagesKey, refreshFirstInspectionPage } from './queries'
import { useInspectionPresentation } from './presentation'

export function ExecutionRepetitionPicker({ executions, occurrenceId, onSelect }: {
  executions: readonly RunExecutionSummary[]; occurrenceId?: string; onSelect(occurrenceId?: string): void
}) {
  const occurrences = new Map(executions.flatMap(execution => execution.occurrence
    ? [[execution.occurrence.occurrenceId, execution.occurrence] as const] : []))
  return <Select label="Business repetition" labelHint={<InfoHint label="Business repetition">Options come from loaded execution pages only. Load more executions to discover older or later repetitions. An attempt is not a repetition.</InfoHint>}
    value={occurrenceId ?? ''} onChange={event => onSelect(event.target.value || undefined)} options={[
      { value: '', label: 'All recorded repetitions' },
      ...(occurrenceId && !occurrences.has(occurrenceId) ? [{ value: occurrenceId, label: `Requested occurrence ${occurrenceId}` }] : []),
      ...[...occurrences.values()].sort((x, y) => x.blockId.localeCompare(y.blockId) || x.occurrenceIndex - y.occurrenceIndex)
        .map(item => ({ value: item.occurrenceId, label: `${item.blockId} · repetition ${item.occurrenceIndex} · ${item.occurrenceId}` })),
    ]} />
}

/** Immutable execution evidence shared by live node Details and explicit history. */
export function ExecutionEvidence({ scope, detail }: { scope: RepeatGraphScopeCurrent; detail: RunExecutionDetail }) {
  const execution = detail.execution, occurrence = execution.occurrence, executionId = execution.executionId
  return <>
    <dl><dt>Execution identity</dt><dd><code>{execution.executionId}</code></dd>
      <dt>Immutable configuration</dt><dd><code>{execution.kind==='job'?execution.jobDefinitionVersionId:execution.agentConfigurationVersionId}</code></dd>
      <dt>Business occurrence</dt><dd>{occurrence
        ? <>{occurrence.blockId} · {occurrence.occurrenceIndex} · <code>{occurrence.occurrenceId}</code></> : 'None — ordinary execution outside a configured repeat block'}</dd>
      <dt>Recorded state</dt><dd>{execution.state}</dd></dl>
    <p>Accepted input digest <code>{detail.acceptedInput.digest}</code></p>
    <JsonValue label={`Input ${executionId}`} value={detail.acceptedInput.value} />
    {detail.acceptedResult.status === 'accepted' ? <>
      <p>Accepted result digest <code>{detail.acceptedResult.digest}</code></p>
      <JsonValue label={`Accepted result ${executionId}`} value={detail.acceptedResult.value} />
    </> : <p>No accepted result is recorded for this exact execution. <InfoHint label="Accepted result">A native terminal report is not an accepted predecessor result.</InfoHint></p>}
    {detail.reportedResult ? <JsonDisclosure disclosureKey={JSON.stringify([scope, executionId, 'native-report'])}
      summary="Recorded execution result (not proof of acceptance)" label={`Reported result ${executionId}`} value={detail.reportedResult} /> : null}
  </>
}

export function ExecutionBindings({ scope, detail, relationshipId }: { scope: RepeatGraphScopeCurrent; detail: RunExecutionDetail; relationshipId?: string }) {
  const cache = useQueryClient()
  const disclosure = JSON.stringify([scope, detail.execution.executionId, 'bindings'])
  const open = useInspectionPresentation((state) => !!state.open[disclosure])
  const query = useBindingPages(scope, detail, open)
  const denied = useProtectedAccessError(query)
  const bindings = denied ? [] : [...new Map(
    (query.data?.pages.flatMap((page) => page.items) ?? []).map((binding) => [binding.bindingId, binding]),
  ).values()]
  const visible = relationshipId ? bindings.filter((binding) => binding.kind !== 'carry' && binding.source.relationshipId === relationshipId) : bindings
  return <details open={open} onToggle={(event) => useInspectionPresentation.getState().setOpen(disclosure, event.currentTarget.open)}>
    <summary>Exact predecessor/result bindings</summary>
    {open ? <>
      {query.isPaused ? <p role="status">Input binding refresh is paused.</p> : query.isPending ? <p role="status">Loading input bindings…</p> : null}
      {query.isError || denied ? <Alert tone="warning" title="Input bindings are unavailable.">
        {bindings.length ? 'Previously loaded bindings stay listed. ' : 'No stale bindings are substituted. '}{!denied ? <Button size="sm" onClick={() => void refreshFirstInspectionPage(cache, bindingsPagesKey(scope, detail))}>Retry bindings</Button> : null}
      </Alert> : null}
      <ol>{visible.map((binding) => <li key={binding.bindingId}><p>{binding.kind} · ordinal {binding.ordinal} · <code>{binding.bindingId}</code></p>
        <JsonValue label={`Binding ${binding.bindingId}`} value={binding} /></li>)}</ol>
      {query.data && !query.isError && !denied && !visible.length ? <p>No matching bindings in the loaded pages.</p> : null}
      {query.hasNextPage && !query.isError && !denied ? <Button size="sm" disabled={query.isFetching && !query.isRefetching}
        onClick={() => void query.fetchNextPage()}>Load more bindings</Button> : null}
      <Button size="sm" variant="ghost" disabled={query.isFetching || !!denied}
        onClick={() => void refreshFirstInspectionPage(cache, bindingsPagesKey(scope, detail))}>Refresh bindings</Button>
    </> : null}
  </details>
}
