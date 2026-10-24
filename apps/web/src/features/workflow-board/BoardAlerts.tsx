import { useEffect, useRef } from 'react'
import { ZodError } from 'zod'
import { WorkflowSaveIssuesSchema, workflowSaveIssues, type WorkflowSaveIssue } from '@foreman-code/contracts/current'
import { ApiError } from '../../shared/api/client'
import { Button, Dialog, Icon } from '../../shared/ui/nocturne'
import type { AuthoringIssue, NextDraftEdit } from '../board-core'
import { useInspectionPresentation } from './inspect/presentation'

/** The saved-workflow field each local authoring hint is about. */
const hintField: Record<string, string> = {
  EXECUTION_LIMITS_REQUIRED: 'executionPolicy', EXECUTION_LIMIT_TOO_LOW: 'executionPolicy',
  ENTRY_REQUIRED: 'entryNodeId', APPROVAL_MODE_REQUIRED: 'approval',
}

export type BoardUpdateFailure = { id: string; message: string; pending: boolean; retry(): void }

export function BoardAlerts({ scope, hints, validation, error, pending, updateFailures = [], fixes = {}, openIssue, openField }: {
  scope: string; hints: readonly AuthoringIssue[]; validation: NextDraftEdit['validation']; error?: Error; pending: boolean
  updateFailures?: readonly BoardUpdateFailure[]
  /** One-click fixes for alerts, by alert code. */
  fixes?: Partial<Record<string, { label: string; disabled?: boolean; run(): void }>>
  openIssue(issue: AuthoringIssue): void; openField(path: WorkflowSaveIssue['path']): void
}) {
  const key = `board-alerts:${scope}`
  const open = useInspectionPresentation((state) => !!state.open[key])
  const trigger = useRef<HTMLButtonElement>(null)
  const setOpen = (value: boolean) => useInspectionPresentation.getState().setOpen(key, value)
  useEffect(() => () => useInspectionPresentation.getState().setOpen(key, false), [key])
  const parsed = WorkflowSaveIssuesSchema.safeParse(ApiError.is(error) ? error.details : undefined)
  const saveIssues = parsed.success ? parsed.data.issues : error instanceof ZodError ? workflowSaveIssues(error.issues) : []
  const rows: { issue: AuthoringIssue | WorkflowSaveIssue; tone: 'warning' | 'danger'; path?: WorkflowSaveIssue['path']; recovery?: BoardUpdateFailure }[] = [
    ...hints.map((issue) => ({ issue, tone: 'warning' as const, path: undefined as WorkflowSaveIssue['path'] | undefined })),
    ...(validation?.issues ?? []).map((issue) => ({ issue, tone: 'warning' as const, path: undefined as WorkflowSaveIssue['path'] | undefined })),
    ...saveIssues.map((issue) => ({ issue, tone: 'danger' as const, path: issue.path })),
    ...(error && !saveIssues.length ? [{ issue: { code: 'SAVE_ERROR', message: error.message }, tone: 'danger' as const, path: undefined }] : []),
    ...updateFailures.map((recovery) => ({ issue: { code: recovery.id, message: recovery.message }, tone: 'warning' as const, recovery })),
  ]
  // A save issue on a field replaces the local hint for that same field.
  const savedFields = new Set(saveIssues.map((issue) => String(issue.path[0])))
  const shadowed = (row: (typeof rows)[number]) => row.tone === 'warning' && !row.recovery
    && savedFields.has(hintField[row.issue.code] ?? '')
  // Local hints and the last validation can report the same finding.
  const alerts = [...new Map(rows.filter((row) => !shadowed(row)).map((row) => [JSON.stringify([row.issue.code, row.issue.message,
    'nodeId' in row.issue ? row.issue.nodeId : undefined, 'relationshipId' in row.issue ? row.issue.relationshipId : undefined,
    row.path?.length ? row.path : undefined]), row])).values()]
  useEffect(() => {
    if (!alerts.length) useInspectionPresentation.getState().setOpen(key, false)
  }, [key, alerts.length])
  if (!alerts.length) return null
  return <div className="board-alerts">
    {updateFailures.length ? <span className="n-sr-only" role="status">{updateFailures.map((failure) => failure.message).join(' ')}</span> : null}
    <Button ref={trigger} className="board-alert-trigger" leading={<Icon name="warning" size={16} />} aria-label={`Workflow alerts, ${alerts.length}`}
      title="Workflow alerts" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      {alerts.length}
    </Button>
    <Dialog open={open} onOpenChange={setOpen} title="Workflow alerts" closeLabel="Close workflow alerts"
      className="board-alert-dialog" size="sm" busy={pending} anchorRef={trigger} anchorAlign="start" returnFocusRef={trigger}>
      {pending ? <p role="status">Checking the submitted workflow…</p> : null}
      <ul className="board-alert-rows">{alerts.map(({ issue, tone, path, recovery }, index) => <li key={index} data-tone={tone}>
        <Icon name="warning" size={15} /><div><span className="n-sr-only">{tone === 'danger' ? 'Error: ' : 'Warning: '}</span>{issue.message}
          {recovery ? <Button size="sm" variant="ghost" disabled={pending || recovery.pending} aria-label={`Retry ${recovery.id === 'WORKSPACE_UPDATES_UNAVAILABLE' ? 'workspace' : 'draft'} updates`}
            onClick={recovery.retry}>{recovery.pending ? 'Retrying…' : 'Retry'}</Button> : fixes[issue.code] ? <Button size="sm" variant="ghost" disabled={pending || fixes[issue.code]!.disabled}
            onClick={fixes[issue.code]!.run}>{fixes[issue.code]!.label}</Button> : issue.code !== 'SAVE_ERROR' && !(issue.code === 'ENTRY_REQUIRED' && issue.message.startsWith('Add an agent')) && (!path || ['approval', 'executionPolicy', 'entryNodeId'].includes(String(path[0]))) ? <Button size="sm" variant="ghost" disabled={pending} onClick={() => {
            setOpen(false)
            if (path && ['approval', 'executionPolicy', 'entryNodeId'].includes(String(path[0]))) openField(path)
            else openIssue(issue)
          }}>Review setting</Button> : null}
        </div>
      </li>)}</ul>
    </Dialog>
  </div>
}
