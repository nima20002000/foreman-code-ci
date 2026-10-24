import type { MouseEvent } from 'react'
import type { ScheduleGetInput, ScheduleOccurrence } from '@foreman-code/contracts/schedules'
import { Button, Skeleton } from '../../shared/ui/nocturne'
import { useLatestScheduleOccurrence, useScheduleOccurrenceHistory } from './queries'

const rejectionMessages = new Map([
  ['schedule_authorization_denied', 'Permission to run this schedule was lost. Restore access, then save the schedule.'],
  ['schedule_authority_missing', 'Save or enable the schedule to authorize future runs.'],
  ['workflow_not_saved', 'Save the workflow before scheduling it.'],
  ['workflow_not_executable', 'Check the saved workflow and agent settings, then save the workflow.'],
])
const outcomeLabels: Record<ScheduleOccurrence['status'], string> = {
  accepted: 'Accepted', rejected: 'Rejected', missed: 'Missed', skipped: 'Skipped',
}

function outcomeReason(occurrence: ScheduleOccurrence): string | null {
  switch (occurrence.status) {
    case 'accepted': return null
    case 'rejected': return rejectionMessages.get(occurrence.reason)
      ?? 'The saved workflow could not start. Check its settings, then save the schedule again.'
    case 'missed': return occurrence.reason === 'outside_grace'
      ? 'The scheduling window passed before this attempt could start.'
      : 'A newer scheduled time replaced this attempt.'
    case 'skipped': return occurrence.reason === 'overlap'
      ? 'A previous scheduled Run was still active.'
      : 'The schedule was disabled before this attempt could start.'
  }
}

type AttemptActions = { onSelectRun?(runId: string): void; onReviewWorkflow?(): void }

function Attempt({ scope, occurrence, onSelectRun, onReviewWorkflow }: { scope: ScheduleGetInput; occurrence: ScheduleOccurrence } & AttemptActions) {
  const runHref = occurrence.status === 'accepted'
    ? `/workspaces/${encodeURIComponent(scope.workspaceId)}?${new URLSearchParams({ workflowId: scope.workflowId, selectedRunId: occurrence.runId })}` : undefined
  function selectRun(event: MouseEvent<HTMLAnchorElement>) {
    if (!onSelectRun || occurrence.status !== 'accepted' || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    onSelectRun(occurrence.runId)
  }
  return <>
    <p>Scheduled for <time dateTime={occurrence.dueAt}>{new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium', timeStyle: 'medium',
    }).format(new Date(occurrence.dueAt))}</time></p>
    <p><strong>{outcomeLabels[occurrence.status]}</strong>
      {occurrence.status !== 'accepted' && <> — {outcomeReason(occurrence)}</>}</p>
    {occurrence.status === 'accepted' ? <a href={runHref} onClick={selectRun}>View Run</a> : null}
    {occurrence.status === 'rejected' && ['workflow_not_saved', 'workflow_not_executable'].includes(occurrence.reason) && onReviewWorkflow
      ? <Button size="sm" variant="ghost" onClick={onReviewWorkflow}>Review workflow</Button> : null}
  </>
}

export function ScheduleLastAttempt({ scope, open, historyOpen, toggleHistory, ...actions }: {
  scope: ScheduleGetInput; open: boolean; historyOpen: boolean; toggleHistory(): void
} & AttemptActions) {
  const query = useLatestScheduleOccurrence(scope, open)
  const history = useScheduleOccurrenceHistory(scope, open && historyOpen)
  const occurrence = !query.isError ? query.data?.items[0] : undefined
  const attempts = history.isError ? [] : [...new Map(history.data?.pages.flatMap(page => page.items).map(item => [item.id, item])).values()]
  return <section className="schedule-last-attempt" aria-label="Last attempt" aria-live="polite">
    <h3>Last attempt</h3>
    {query.isError ? <>
      <p>Couldn’t load the last attempt.</p>
      <Button size="sm" variant="ghost" onClick={() => void query.refetch()}>Try again</Button>
    </> : occurrence ? <Attempt scope={scope} occurrence={occurrence} {...actions} />
      : query.isPending ? <Skeleton width="60%" /> : <p>No attempts yet.</p>}
    <Button size="sm" variant="ghost" aria-expanded={historyOpen} onClick={toggleHistory}>Attempt history</Button>
    {historyOpen ? <section aria-label="Schedule attempt history">
      <h3>Attempt history</h3>
      {history.isPending ? <p role="status">Loading attempts…</p> : null}
      {history.isError ? <p role="status">Couldn’t load attempt history. <Button size="sm" onClick={() => void history.refetch()}>Retry history</Button></p> : null}
      {!history.isPending && !history.isError && !attempts.length ? <p>No attempts yet.</p> : null}
      <ol>{attempts.map(item => <li key={item.id}><Attempt scope={scope} occurrence={item} {...actions} /></li>)}</ol>
      {history.hasNextPage && !history.isError ? <Button size="sm" variant="ghost" disabled={history.isFetching}
        onClick={() => void history.fetchNextPage()}>Older attempts</Button> : null}
    </section> : null}
  </section>
}
