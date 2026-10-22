import {
  BugReportActiveStatusSchema,
  BugReportClosedStatusSchema,
  type BugReport,
  type BugReportClosedStatus,
} from '@foreman-code/contracts/management'
import { useState, type RefObject } from 'react'
import { isAccessFailure } from '../../shared/api/accessErrors'
import { ApiError } from '../../shared/api/client'
import { sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { Link } from '@tanstack/react-router'
import { useWorkspaceDetailsQuery } from '../../shared/api/query'
import { Alert, Button, Dialog, LoadingState, Select, TextField } from '../../shared/ui/nocturne'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { useBugReport, type BugReportChange } from './bugReportQueries'
import {
  activeStatusOptions, closedStatusOptions, severityLabels, statusLabels,
} from './bugReportPresentation'

const reporterLabel = (reporter: BugReport['reporter']) => reporter.audience === 'worker' ? 'Workflow agent'
  : reporter.audience === 'operator' ? 'Operator' : reporter.name
const when = (value: string) => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

function ReportContent({ report }: { report: BugReport }) {
  const details = useWorkspaceDetailsQuery(report.workspaceId)
  const workspace = details.data?.workspace.name
  const workflow = report.workflowId ? details.data?.workflows.find(item => item.id === report.workflowId)?.name : undefined
  return <div className="bug-report-content">
    <div className="bug-report-meta">
      <span className="bug-row-severity" data-severity={report.severity}>{severityLabels[report.severity]}</span>
      <span>{statusLabels[report.status]}</span>
      <span>{report.occurrenceCount === 1 ? 'Reported once' : `Reported ${report.occurrenceCount} times`}</span>
      <span>Last <time dateTime={report.lastReportedAt}>{when(report.lastReportedAt)}</time></span>
    </div>
    <section><h3>Tried</h3><p><strong>{report.tried.feature}.</strong> {report.tried.inputsSummary}</p></section>
    <section><h3>Happened</h3><p>{report.happened.message}</p>
      {report.happened.errorCode ? <small className="bug-report-code">{report.happened.errorCode}</small> : null}</section>
    <section><h3>Expected</h3><p>{report.expected}</p></section>
    <dl className="bug-report-facts">
      <div><dt>From</dt><dd>{reporterLabel(report.reporter)}{report.harness ? ` · ${report.harness === 'codex' ? 'Codex' : report.harness === 'claude' ? 'Claude' : report.harness}` : ''}</dd></div>
      <div><dt>Workspace</dt><dd>{workspace ?? (details.isPending ? '…' : 'Removed workspace')}</dd></div>
      {report.workflowId ? <div><dt>Workflow</dt><dd><Link to="/workspaces/$workspaceId" params={{ workspaceId: report.workspaceId }}
        search={{ workflowId: report.workflowId, ...(report.runId ? { selectedRunId: report.runId } : {}) }}>
        {workflow ?? 'Open workflow'}{report.runId ? ' · open run' : ''}</Link></dd></div> : null}
      <div><dt>First seen</dt><dd><time dateTime={report.createdAt}>{when(report.createdAt)}</time></dd></div>
      {report.resolution ? <div><dt>{report.status === report.resolution.status ? 'Closed' : 'Was closed'}</dt>
        <dd>{statusLabels[report.resolution.status]}, <time dateTime={report.resolution.closedAt}>{when(report.resolution.closedAt)}</time>
</dd></div> : null}
      {report.resolution?.note ? <div><dt>Note</dt><dd>{report.resolution.note}</dd></div> : null}
    </dl>
  </div>
}

export function BugReportDialog({ reportId, returnFocusRef, onClose }: {
  reportId: string
  returnFocusRef: RefObject<HTMLElement | null>
  onClose(): void
}) {
  const { report, update, denied, uncertain, refresh, retry } = useBugReport(reportId)
  const value = denied ? undefined : report.data
  const updateDenied = isAccessFailure(update.error)
  const [closeAs, setCloseAs] = useState<BugReportClosedStatus>('fixed')
  const [note, setNote] = useState('')
  const [duplicateOfId, setDuplicateOfId] = useState('')
  const active = value?.status === 'open' || value?.status === 'triaged'
  const locked = update.isPending || uncertain
  const invalidDuplicate = closeAs === 'duplicate' && !duplicateOfId.trim()
  const clearCloseDraft = () => {
    setCloseAs('fixed')
    setNote('')
    setDuplicateOfId('')
  }
  const closingChange = (current: BugReport): BugReportChange => ({ kind: 'close', input: {
    commandId: crypto.randomUUID(),
    reports: [{ reportId, expectedRevision: current.revision }],
    status: closeAs,
    ...(note.trim() ? { note: note.trim() } : {}),
    ...(closeAs === 'duplicate' ? { duplicateOfId: duplicateOfId.trim() } : {}),
  } })
  const leave = useUnsavedChanges({
    label: 'Bug report status',
    dirty: Boolean(active && (closeAs !== 'fixed' || note || duplicateOfId)),
    busy: update.isPending,
    uncertain,
    saveDisabled: denied || updateDenied || !value || (!uncertain && invalidDuplicate),
    error: update.isError ? update.error.message : undefined,
    save: async () => {
      if (uncertain) {
        await retry()
        if (update.variables?.kind === 'close') clearCloseDraft()
      } else if (value) {
        await update.mutateAsync(closingChange(value))
        clearCloseDraft()
      }
    },
    discard: clearCloseDraft,
  })
  const requestClose = () => { if (!locked) void leave(onClose) }
  const editDisabled = report.isError || update.isPending || update.isError || sessionIsSwitching()
  const change = (next: BugReportChange) => update.mutate(next, {
    onSuccess: () => { if (next.kind === 'close') clearCloseDraft() },
  })
  return <Dialog open title={value?.title ?? 'Bug report'} size="lg" busy={update.isPending}
    returnFocusRef={returnFocusRef} className="bug-report-dialog"
    dismissible={!uncertain} onOpenChange={open => { if (!open) requestClose() }}
    footer={value ? <form className="bug-report-actions" aria-label="Report status" onSubmit={event => {
      event.preventDefault()
      if (active) change(closingChange(value))
    }}>
      <Select label="Status" value={value.status}
        options={active ? activeStatusOptions
          : [{ value: value.status, label: statusLabels[value.status], disabled: true }, ...activeStatusOptions]}
        disabled={editDisabled}
        onChange={event => change({ kind: 'status', input: {
          commandId: crypto.randomUUID(),
          reportId,
          expectedRevision: value.revision,
          status: BugReportActiveStatusSchema.parse(event.target.value),
        } })} />
      {active ? <>
        <Select label="Close as" value={closeAs} options={closedStatusOptions} disabled={editDisabled}
          onChange={event => setCloseAs(BugReportClosedStatusSchema.parse(event.target.value))} />
        {closeAs === 'duplicate' ? <TextField label="Duplicate of" placeholder="Report ID" required value={duplicateOfId}
          disabled={editDisabled} onChange={event => setDuplicateOfId(event.target.value)} /> : null}
        <TextField label="Note" placeholder="Optional, e.g. the release" maxLength={1000}
          value={note} disabled={editDisabled} onChange={event => setNote(event.target.value)} />
        <Button type="submit" variant="primary" disabled={editDisabled || invalidDuplicate} loading={update.isPending && update.variables?.kind === 'close'}>Mark closed</Button>
      </> : null}
    </form> : undefined}>
    {report.isPending ? <LoadingState label="Loading report…" rows={3} /> : null}
    {report.isError ? <Alert live tone="danger" title={ApiError.is(report.error) && report.error.status === 404 ? 'This report no longer exists.' : 'Couldn\u2019t load this report.'}
      action={<Button size="sm" disabled={update.isPending} onClick={() => void refresh()}>Retry</Button>} /> : null}
    {value ? <ReportContent report={value} /> : null}
    {update.isSuccess && !report.isError ? <p role="status" className="bug-report-saved">
      {update.variables?.kind === 'close' ? 'Report closed.' : 'Status saved.'}</p> : null}
    {update.isError ? <Alert live tone="danger" title={updateDenied ? 'You can\u2019t change this report.' : uncertain ? 'Not confirmed yet.' : 'Couldn\u2019t save.'}
      action={uncertain ? <Button size="sm" disabled={denied || updateDenied} onClick={() => update.variables && change(update.variables)}>Retry</Button>
        : <Button size="sm" disabled={report.isFetching && !report.isRefetching} onClick={() => void refresh()}>Refresh</Button>} /> : null}
  </Dialog>
}
