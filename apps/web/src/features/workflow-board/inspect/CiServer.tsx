import { raiseFloating, useFloatingZ } from '../../../shared/ui/floatingStack'
import { InfoHint } from '../../../shared/ui/InfoHint'
import { memo, useId, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import './inspection.css'
import '../dock/boardDock.css'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Handle, NodeResizer, Position, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react'
import { ciActivityFromRecord, type CiRunJob, type CiTestStatus } from '@foreman-code/contracts'
import type { RepeatGraphScopeCurrent } from '@foreman-code/contracts/current'
import { Alert, Badge, Button, EmptyState, Icon, IconButton, Spinner, Tabs, type Tone } from '../../../shared/ui/nocturne'
import { PulseFlight, type EdgePulse } from '../../graph/SignalEdgeShape'
import { useFloatingCurve } from '../../board-core'
import { formatClock, formatDuration } from '../../run-subagents'
import { ciComputerLabel, ciJobLabel } from './runLiveStatus'
import { runInspectionQueryKey } from './queries'
import { WorkflowJobs } from './WorkflowJobs'
import { CI_PLACEMENT_LABELS, ciJobDuration, ciJobRefreshing, isActiveCiJob, runCiApi, type CiServerSummary } from './ciServer'
import { useProtectedAccessError } from '../../../shared/api/useProtectedAccessError'
import { isApiAccessError } from '../../../shared/api/accessError'

const SHORT_PLACEMENTS = { host: 'Host CI', github: 'GitHub', circleci: 'CircleCI' } as const

export type CiServerFlowNode = Node<{ summary: CiServerSummary; open(): void; rim: 'box'; close?(): void; resizable?: boolean }, 'ciServer'>
/** A presentation-only component of the Board, never a workflow node: no edges, no saved geometry, no execution.
 * Drawn as a server tower (drive bays, status LEDs, vents) so it never reads as an Agent. */
export const CiServerNode = memo(function CiServerNode({ data }: NodeProps<CiServerFlowNode>) {
  const { summary } = data
  // The tower drags by its body; a press that moved it is a drag, not a click that opens it.
  const pressed = useRef<{ x: number; y: number }>(undefined)
  const where = summary.placements.length ? summary.placements.map((placement) => SHORT_PLACEMENTS[placement]).join(' · ')
    : 'Host CI · GitHub · CircleCI'
  return <div className="ci-server-node" data-state={summary.state}>
    {data.resizable ? <NodeResizer minWidth={150} minHeight={170} handleClassName="board-kanban-resize" lineClassName="ci-server-resize-line" /> : null}
    <button type="button" className="ci-server-chassis" onPointerDown={(event) => { pressed.current = { x: event.clientX, y: event.clientY } }}
      onClick={(event) => { const from = pressed.current
        if (!from || Math.hypot(event.clientX - from.x, event.clientY - from.y) < 4) data.open() }}
      aria-label={`CI server, ${summary.label}. Open CI jobs and test results`}>
      <span className="ci-server-bays" aria-hidden="true">{[0, 1, 2].map((bay) => <span key={bay} className="ci-server-bay">
        <i className="ci-server-led" /><i className="ci-server-slot" /></span>)}</span>
      <span key={summary.label} className="ci-server-status"><i aria-hidden="true" />{summary.label}</span>
      <strong className="ci-server-name"><Icon name="server" size={14} />CI server</strong>
      <span className="ci-server-where">{where}</span>
      <span className="ci-server-meta"><span><small>Jobs</small><b>{summary.total}</b></span>
        <span><small>Failed</small><b>{summary.failed}</b></span></span>
      <span className="ci-server-vents" aria-hidden="true" />
    </button>
    {data.close ? <button type="button" className="board-object-close nodrag nopan" aria-label="Close CI server to the dock"
      title="Close to the dock" onClick={data.close}><Icon name="close" size={12} /></button> : null}
    {/* Only for the passing lights; nothing connects to the server. */}
    <Handle id="left" type="target" position={Position.Left} isConnectable={false} className="ci-server-target" />
  </div>
})

export type CiTransferFlowEdge = Edge<{ pulses: EdgePulse[] }, 'ciTransfer'>
/** A light in flight between an Agent and the CI server; the edge exists only while it travels. */
export const CiTransferEdge = memo(function CiTransferEdge({ source, target, data }: EdgeProps<CiTransferFlowEdge>) {
  const curve = useFloatingCurve(source, target, 0)
  if (!curve || !data) return null
  return <g className="ci-transfer" aria-hidden="true">
    {data.pulses.map((pulse) => <PulseFlight key={pulse.key} path={curve.path} pulse={pulse} />)}
  </g>
})

const stateTone: Record<CiRunJob['ci']['state'], Tone> = { queued: 'neutral', starting: 'info', running: 'info',
  passed: 'success', failed: 'danger', canceled: 'neutral', lost: 'danger' }
const testTone: Record<CiTestStatus, Tone> = { passed: 'success', failed: 'danger', skipped: 'neutral' }
const STATUSES: readonly CiTestStatus[] = ['failed', 'skipped', 'passed']
const label = (value: string) => value[0]!.toUpperCase() + value.slice(1)

type Tab = 'jobs' | 'tests' | 'log' | 'workflow-jobs'
/** The CI server's jobs for this Run; a job opens its test results and log tail. */
export function CiServerDialog({ open, onOpenChange, scope, workflow, jobs: listedJobs, names, truncated, error, loading, ticketId, onRefresh, readError }: {
  open: boolean; onOpenChange(open: boolean): void; scope?: RepeatGraphScopeCurrent | undefined; jobs: readonly CiRunJob[]
  workflow?: { workspaceId: string; workflowId: string } | undefined
  names: ReadonlyMap<string, string>; truncated: boolean; error: boolean; loading: boolean
  ticketId?: string | undefined
  onRefresh?(): void
  readError?: unknown
}) {
  const stackId = useId()
  const zIndex = useFloatingZ(stackId, open)
  const cache = useQueryClient()
  const cancel = useMutation({ mutationFn: runCiApi.cancel, onSuccess: () => {
    if (scope) void cache.invalidateQueries({ queryKey: [...runInspectionQueryKey(scope), 'ci-jobs'] })
    onRefresh?.()
  } })
  const jobs = listedJobs.map(job => cancel.data?.run.id === job.ticketId && !cancel.data.detached
    ? { ...job, ci: ciActivityFromRecord(cancel.data.run), message: cancel.data.run.message } : job)
  const cancelJob = (job: CiRunJob) => {
    if (scope) cancel.mutate({ workspaceId: scope.workspaceId, ticketId: job.ticketId, commandId: crypto.randomUUID() })
  }
  const [tab, setTab] = useState<Tab>('jobs')
  const [selectedId, setSelectedId] = useState<string>()
  // Kept here so the status filter survives a visit to another tab.
  const [statuses, setStatuses] = useState<CiTestStatus[]>([...STATUSES])
  useEffect(() => {
    if (open && ticketId) {
      setSelectedId(ticketId)
      setTab('tests')
    }
  }, [open, ticketId])
  const selected = jobs.find((job) => job.ticketId === selectedId)
  const agent = (job: CiRunJob) => names.get(job.requester.nodeId) ?? job.requester.nodeName
  const show = (job: CiRunJob) => { setSelectedId(job.ticketId); setTab('tests') }
  const panelRef = useRef<HTMLElement>(null)
  const close = useRef(onOpenChange)
  close.current = onOpenChange
  // Open next to the item that opened it (the focused control), like the Board's floating windows.
  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!open || !panel) return
    const focused = document.activeElement
    const opener = focused instanceof HTMLElement && focused !== document.body && !panel.contains(focused) ? focused : null
    const anchor = opener?.getBoundingClientRect()
    const { offsetWidth: w, offsetHeight: h } = panel
    const right = anchor ? anchor.right + 12 : window.innerWidth - w - 24
    const left = right + w <= window.innerWidth - 12 ? right : (anchor?.left ?? 0) - w - 12
    panel.style.left = `${Math.max(12, Math.min(left, window.innerWidth - w - 12))}px`
    panel.style.top = `${Math.max(12, Math.min(anchor?.top ?? 80, window.innerHeight - h - 12))}px`
    panel.focus({ preventScroll: true })
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !panel.contains(document.activeElement)) return
      event.preventDefault()
      close.current(false)
    }
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('keydown', escape)
      if (opener?.isConnected) opener.focus()
    }
  }, [open])
  const drag = (event: ReactPointerEvent<HTMLElement>) => {
    const panel = panelRef.current
    if (!panel || event.button !== 0 || (event.target as Element).closest('button')) return
    const startX = event.clientX - panel.offsetLeft, startY = event.clientY - panel.offsetTop
    const move = (e: PointerEvent) => {
      panel.style.left = `${Math.max(0, Math.min(e.clientX - startX, window.innerWidth - 80))}px`
      panel.style.top = `${Math.max(0, Math.min(e.clientY - startY, window.innerHeight - 40))}px`
    }
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    event.preventDefault()
  }
  if (!open) return null
  return <aside ref={panelRef} tabIndex={-1} className="ci-server-window" aria-label="CI server" style={{ zIndex }}
    onPointerDownCapture={() => raiseFloating(stackId)} onFocusCapture={() => raiseFloating(stackId)}>
    <header onPointerDown={drag}>
      <h2><Icon name="server" size={14} />CI server</h2>
      <InfoHint label="CI server">{scope
        ? 'CI jobs the Agents of this Run requested, on Host CI, GitHub Actions or CircleCI.'
        : 'CI jobs that Agents request during a Run appear here, on Host CI, GitHub Actions or CircleCI.'}</InfoHint>
      <IconButton label="Close CI server" variant="ghost" onClick={() => onOpenChange(false)}><Icon name="close" size={16} /></IconButton>
    </header>
    <div className="ci-server-window-body">{error ? <Alert tone="warning" title="CI jobs could not be read.">
      {isApiAccessError(readError) ? 'CI access is unavailable for this workspace.'
        : jobs.length ? 'The list shows the last jobs read. Try reading them again.' : 'Try reading the jobs again when the connection is available.'}
      {onRefresh ? <Button size="sm" onClick={onRefresh}>Retry CI jobs</Button> : null}</Alert> : null}
    {cancel.error ? <Alert tone="warning" title="CI cancellation failed.">{cancel.error.message}</Alert> : null}
    {cancel.data?.detached ? <p role="status">You left this shared CI request. It continues for {cancel.data.detached.remainingRequesters} other requesters.</p> : null}
    {cancel.data?.run.cancellation && ['queued', 'starting', 'running'].includes(cancel.data.run.state) ? <p role="status">Cancellation requested; waiting for the executor.</p> : null}
    {selected && tab !== 'jobs' && isActiveCiJob(selected) ? <Button size="sm" disabled={cancel.isPending}
      onClick={() => cancelJob(selected)}>Cancel CI job</Button> : null}
    <Tabs label="CI server" value={tab} onValueChange={(value) => setTab(value as Tab)} keepMounted={false} items={[
      { value: 'jobs', label: 'Jobs', badge: jobs.length, content: loading ? <Spinner label="Loading CI jobs" />
        : <CiJobsTable jobs={jobs} agent={agent} selectedId={selected?.ticketId} truncated={truncated} onShow={show} run={Boolean(scope)} onCancel={scope ? cancelJob : undefined} cancelPending={cancel.isPending} /> },
      { value: 'tests', label: 'Tests', disabled: !selected || !scope,
        content: selected && scope ? <CiJobTests scope={scope} job={selected} agent={agent(selected)}
        statuses={statuses} onStatusesChange={setStatuses} /> : null },
      { value: 'log', label: 'Log', disabled: !selected || !scope, content: selected && scope ? <CiJobLog scope={scope} job={selected} /> : null },
      ...(workflow ? [{ value: 'workflow-jobs', label: 'Workflow jobs',
        content: <WorkflowJobs key={JSON.stringify(workflow)} {...workflow} /> }] : []),
    ]} /></div>
  </aside>
}

export function CiJobsTable({ jobs, agent, selectedId, truncated, onShow, run, onCancel, cancelPending }: { jobs: readonly CiRunJob[]; agent(job: CiRunJob): string
  selectedId?: string | undefined; truncated: boolean; onShow(job: CiRunJob): void; run: boolean; onCancel?(job: CiRunJob): void; cancelPending?: boolean }) {
  if (!jobs.length) return <EmptyState icon="terminal" title={run ? 'No CI jobs in this Run yet' : 'No Run selected'}
    description={run ? undefined : 'Start or select a Run.'} />
  return <div className="n-table-scroll" role="region" aria-label="CI jobs" tabIndex={0}>
    <table className="n-table ci-jobs-table"><thead><tr>
      {['Job', 'Scope', 'Placement', 'State', 'Agent', 'Started', 'Duration'].map((name) => <th key={name} scope="col">{name}</th>)}{onCancel ? <th scope="col">Actions</th> : null}
    </tr></thead><tbody>{jobs.map((job) => <tr key={job.ticketId} aria-selected={job.ticketId === selectedId}>
      <td><button type="button" className="ci-job-open" onClick={() => onShow(job)}
        aria-label={`Show tests of ${ciJobLabel(job.ci)} requested by ${agent(job)}`}>{ciJobLabel(job.ci)}</button></td>
      <td>{label(job.scope)}</td>
      <td>{job.placement ? CI_PLACEMENT_LABELS[job.placement] : 'Waiting for a computer'}
        {job.ci.computer ? <small>{job.ci.computer.label}</small> : null}</td>
      <td><Badge tone={job.message && isActiveCiJob(job) ? 'warning' : stateTone[job.ci.state]} dot>
        {label(job.ci.state)}</Badge>
        {job.message ? <small>{job.message}</small> : null}
        {job.ci.step ? <small>Step {job.ci.step}</small> : null}
        {job.tests ? <small>{job.tests.passed} passed · {job.tests.failed} failed · {job.tests.skipped} skipped</small> : null}</td>
      <td>{agent(job)}</td>
      <td>{job.ci.startedAt ? <time dateTime={job.ci.startedAt}>{formatClock(job.ci.startedAt)}</time>
        : <>Queued <time dateTime={job.ci.queuedAt}>{formatClock(job.ci.queuedAt)}</time></>}</td>
      <td>{ciJobDuration(job) === null ? '—' : formatDuration(ciJobDuration(job)!)}</td>
      {onCancel ? <td>{isActiveCiJob(job) ? <Button size="sm" disabled={cancelPending} onClick={() => onCancel(job)}>Cancel CI job</Button> : null}</td> : null}
    </tr>)}</tbody></table>
    {truncated ? <p className="ci-server-note">Showing the newest 500 jobs.</p> : null}
  </div>
}

function CiJobHeader({ job, agent }: { job: CiRunJob; agent?: string }) {
  const duration = ciJobDuration(job)
  return <p className="ci-server-job">
    <strong>{ciJobLabel(job.ci)}</strong>
    <Badge tone={job.message && isActiveCiJob(job) ? 'warning' : stateTone[job.ci.state]} dot>{label(job.ci.state)}</Badge>
    {job.message ? <span>{job.message}</span> : null}
    {agent ? <span>Requested by {agent}</span> : null}
    <span>{ciComputerLabel(job.ci)}</span>
    {job.ci.startedAt ? <span>Started <time dateTime={job.ci.startedAt}>{formatClock(job.ci.startedAt)}</time></span> : null}
    {duration !== null ? <span>{isActiveCiJob(job) ? `${formatDuration(duration)} so far` : `Ran ${formatDuration(duration)}`}</span> : null}
  </p>
}

function CiJobTests({ scope, job, agent, statuses, onStatusesChange }: { scope: RepeatGraphScopeCurrent; job: CiRunJob; agent: string
  statuses: readonly CiTestStatus[]; onStatusesChange(statuses: CiTestStatus[]): void }) {
  const selected = STATUSES.filter((status) => statuses.includes(status))
  const query = useQuery({
    queryKey: [...runInspectionQueryKey(scope), 'ci-tests', job.ticketId, selected.join(','), job.ci.state, job.tests],
    queryFn: ({ signal }) => runCiApi.tests({ workspaceId: scope.workspaceId, ticketId: job.ticketId,
      ...(selected.length < STATUSES.length ? { status: selected } : {}) }, { signal }),
    enabled: selected.length > 0,
  })
  const denied = useProtectedAccessError(query)
  const results = !denied && query.data?.ticketId === job.ticketId ? query.data.tests : undefined
  const counts = denied ? undefined : results?.summary ?? job.tests
  const toggle = (status: CiTestStatus) => onStatusesChange(statuses.includes(status)
    ? statuses.filter((value) => value !== status) : [...statuses, status])
  return <div className="ci-server-tests">
    <CiJobHeader job={job} agent={agent} />
    <h3>Tests<InfoHint label="Tests">Vitest unit and integration jobs report their tests when they finish; other jobs have only a log.</InfoHint></h3>
    <div className="ci-test-filters" role="group" aria-label="Show tests by status">
      {STATUSES.map((status) => <Button key={status} size="sm" variant={statuses.includes(status) ? 'secondary' : 'ghost'}
        aria-pressed={statuses.includes(status)} data-status={status} onClick={() => toggle(status)}>
        {label(status)}{counts ? ` ${counts[status]}` : ''}</Button>)}
    </div>
    {!selected.length ? <p className="ci-server-note">Choose at least one status.</p>
      : query.isPending ? <Spinner label="Loading test results" />
      : query.isError && !results ? <Alert tone="warning" title="Test results are unavailable.">
        <Button size="sm" onClick={() => void query.refetch()}>Retry</Button></Alert>
      : !results ? <EmptyState icon="terminal" title="No test results for this job"
        description={isActiveCiJob(job) ? 'Results arrive when the job finishes.'
          : job.collection === 'pending' ? 'Collecting the finished job\'s results.'
          : undefined} />
      : <CiTestFiles files={results.files} truncated={results.truncated} />}
    {query.isError && results ? <Alert tone="warning" title="Test results could not be refreshed.">
      Showing the last test results read.</Alert> : null}
  </div>
}

function CiTestFiles({ files, truncated }: { files: NonNullable<Awaited<ReturnType<typeof runCiApi.tests>>['tests']>['files']; truncated: boolean }) {
  if (!files.length) return <p className="ci-server-note">No tests with these statuses.</p>
  return <>
    <ul className="ci-test-files" aria-label="Test results">{files.map((file) => <li key={file.file} data-status={file.status}>
      <div className="ci-test-file"><Badge tone={testTone[file.status]} dot>{label(file.status)}</Badge>
        <code>{file.file}</code>{file.durationMs !== null ? <span>{formatDuration(file.durationMs)}</span> : null}</div>
      {file.tests.length ? <ul>{file.tests.map((test, index) => <li key={`${test.name}:${index}`} data-status={test.status}>
        <Badge tone={testTone[test.status]}>{label(test.status)}</Badge><span className="ci-test-name">{test.name}</span>
        {test.durationMs !== null ? <span>{formatDuration(test.durationMs)}</span> : null}
        {test.message ? <pre className="ci-test-message">{test.message}</pre> : null}
      </li>)}</ul> : null}
    </li>)}</ul>
    {truncated ? <p className="ci-server-note">Large runs keep failed tests first; the counts include every test.</p> : null}
  </>
}

function CiJobLog({ scope, job }: { scope: RepeatGraphScopeCurrent; job: CiRunJob }) {
  const started = job.ci.state !== 'queued'
  const query = useQuery({
    queryKey: [...runInspectionQueryKey(scope), 'ci-log', job.ticketId, job.ci.state],
    queryFn: ({ signal }) => runCiApi.logTail({ workspaceId: scope.workspaceId, ticketId: job.ticketId }, { signal }),
    enabled: started,
    refetchInterval: state => {
      if (isApiAccessError(state.state.error)) return false
      return ciJobRefreshing(job) ? 3000 : false
    },
  })
  const denied = useProtectedAccessError(query)
  const log = denied ? undefined : query.data
  return <div className="ci-server-log">
    <CiJobHeader job={job} />
    {!started ? <p className="ci-server-note">The job has not started; its log appears once a computer takes it.</p>
      : query.isPending ? <Spinner label="Loading log" />
      : (denied || query.isError) && !log ? <Alert tone="warning" title="The log is unavailable right now.">
        {denied ? 'CI log access is unavailable for this workspace.' : 'The computer that ran this job may be offline.'}
        <Button size="sm" onClick={() => void query.refetch()}>Retry log</Button></Alert>
      : <pre className="ci-log" tabIndex={0} aria-label="Log tail">{log?.text || 'The log is empty.'}</pre>}
    {query.isError && log ? <Alert tone="warning" title="The log could not be refreshed.">
      Showing the last log read.<Button size="sm" onClick={() => void query.refetch()}>Retry log</Button></Alert> : null}
  </div>
}
