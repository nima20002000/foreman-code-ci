import { InfoHint } from '../../shared/ui/InfoHint'
import {
  BugReportSeveritySchema,
  BugReportStatusSchema,
  BugReportViewSchema,
  type BugReport,
  type BugsSettingsSearch,
} from '@foreman-code/contracts/management'
import { useRef } from 'react'
import { useAccessFailureLatch } from '../../shared/api/useAccessFailureLatch'
import { LoadMore } from '../../shared/ui/LoadMore'
import { Alert, Button, EmptyState, Select } from '../../shared/ui/nocturne'
import { BugReportDialog } from './BugReportDialog'
import { useBugReports } from './bugReportQueries'
import {
  activeStatusOptions, closedStatusOptions, severityLabels, severityOptions, statusLabels,
} from './bugReportPresentation'
import '../settings/settingsExperience.css'
import './bugsSettings.css'

function relativeDay(iso: string) {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  return days <= 0 ? 'Today' : days === 1 ? 'Yesterday' : `${days} days ago`
}

/** One row per report: what broke, where, how bad, and when. */
function ReportRow({ report, onSelect }: { report: BugReport; onSelect(): void }) {
  return <li>
    <button className="bug-row" type="button" onClick={onSelect} aria-label={`Read ${report.title}`}>
      <span className="bug-row-title"><strong>{report.title}</strong><small>{report.tried.feature}</small></span>
      <span className="bug-row-severity" data-severity={report.severity}>{severityLabels[report.severity]}</span>
      <span className="bug-row-status">{statusLabels[report.status]}</span>
      <time className="bug-row-date" dateTime={report.createdAt} title={new Date(report.createdAt).toLocaleString()}>
        {relativeDay(report.resolution?.closedAt ?? report.createdAt)}</time>
    </button>
  </li>
}

export function BugsSettings({ search, onSearchChange }: {
  search: BugsSettingsSearch
  onSearchChange(search: BugsSettingsSearch): void
}) {
  const heading = useRef<HTMLHeadingElement>(null)
  const reports = useBugReports(search)
  const denied = useAccessFailureLatch(reports)
  const items = denied ? [] : reports.data?.pages.flatMap(page => page.items) ?? []
  const filters = { ...search }
  delete filters.reportId
  const history = search.view === 'history'
  return <section className="settings-editor-page" aria-label="Bug reports">
    <header className="settings-experience-heading"><h1 ref={heading} tabIndex={-1}>Bugs</h1><InfoHint label="Bugs">Reports submitted by Agents appear here. Closed reports are in history.</InfoHint></header>
    <div className="bug-report-filters">
      <Select label="Show reports" value={search.view ?? 'active'}
        options={[{ value: 'active', label: 'Active' }, { value: 'history', label: 'History' }]}
        onChange={event => {
          const next = { ...filters }
          delete next.status
          if (event.target.value === 'history') next.view = BugReportViewSchema.parse(event.target.value)
          else delete next.view
          onSearchChange(next)
        }} />
      <Select label="Filter by status" value={search.status ?? ''}
        options={[{ value: '', label: 'All statuses' }, ...(history ? closedStatusOptions : activeStatusOptions)]}
        onChange={event => {
          const next = { ...filters }
          if (event.target.value) next.status = BugReportStatusSchema.parse(event.target.value)
          else delete next.status
          onSearchChange(next)
        }} />
      <Select label="Filter by severity" value={search.severity ?? ''}
        options={[{ value: '', label: 'All severities' }, ...severityOptions]}
        onChange={event => {
          const next = { ...filters }
          if (event.target.value) next.severity = BugReportSeveritySchema.parse(event.target.value)
          else delete next.severity
          onSearchChange(next)
        }} />
    </div>
    {reports.isPending && <ul className="bug-list" aria-busy="true" aria-label="Loading bug reports">
      {[0, 1, 2, 3].map(index => <li key={index} className="bug-row-skeleton" />)}</ul>}
    {reports.isError && <Alert live tone="danger" title={reports.error.message}
      action={<Button disabled={reports.isFetching && !reports.isRefetching} onClick={() => void reports.refetch()}>Refresh bug reports</Button>} />}
    {!reports.isPending && !reports.isError && !items.length && <EmptyState
      title={history ? 'No closed bug reports' : 'No active bug reports'} />}
    {items.length > 0 && <ul className="bug-list" aria-label="Bug reports, newest first">
      {items.map(report => <ReportRow key={report.id} report={report}
        onSelect={() => onSearchChange({ ...filters, reportId: report.id })} />)}
    </ul>}
    {!denied && <LoadMore label="bug reports" query={reports} />}
    {search.reportId && <BugReportDialog key={search.reportId} reportId={search.reportId}
      returnFocusRef={heading}
      onClose={() => onSearchChange(filters)} />}
  </section>
}
