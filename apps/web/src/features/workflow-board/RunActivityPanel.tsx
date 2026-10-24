import { preferRunSummary } from '@foreman-code/contracts/run-snapshots'
import { RunActions } from './actions'
import { useEffect, useRef } from 'react'
import { useInfiniteQuery, useMutation, useQueryClient, type InfiniteData, type QueryClient } from '@tanstack/react-query'
import type { WorkflowRunSummary } from '@foreman-code/contracts'
import { sameCanonicalGraphScope } from '@foreman-code/contracts/current'
import { Button, EmptyState, Icon, IconButton, LoadingState, StatusBadge } from '../../shared/ui/nocturne'
import { Activities } from './Activities'
import { isActiveRun, runLabel, runTone, shortRunId, when } from './runFacts'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { CurrentRunDetails } from './RunDetails'
import { readBoardRun, readBoardRuns, scopeForBoardRun } from './client'
import { useBoardSelection, boardRunListKey } from '../board-core'
import { boardScope, useBoardUndo } from './boardUndo'

import { refreshFirstInspectionPage } from './inspect/queries'

async function refreshBoardRuns(client: QueryClient, workspaceId: string, workflowId: string) {
  const key = boardRunListKey(workspaceId, workflowId)
  const cached = client.getQueryData<InfiniteData<Awaited<ReturnType<typeof readBoardRuns>>, string | null>>(key)
  if (cached?.pageParams[0] === null) {
    await client.invalidateQueries({ queryKey: key, exact: true })
  } else {
    // A capped history may have evicted the initial page and its cursor.
    await refreshFirstInspectionPage(client, key)
  }
}

export function RunActivityPanel({ summaries, summariesReadAt = 0 }: {
  summaries: readonly WorkflowRunSummary[]; summariesReadAt?: number
}) {
  const board = useBoardSelection()!
  const { workspaceId, workflowId, run: selected, selectRun } = board
  const details = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    if ((board.inspection.runRelationshipId || board.inspection.runExchangeKey) && details.current && !details.current.open) {
      details.current.open = true
      details.current.focus()
    }
  }, [selected?.runId, board.inspection.runRelationshipId, board.inspection.runExchangeKey])
  const client = useQueryClient()
  const request = useRef(0)
  const mounted = useRef({ workspaceId, workflowId })
  mounted.current = { workspaceId, workflowId }
  const discovery = useMutation({ retry: false,
    mutationFn: async ({ runId, generation }: { runId: string; generation: number; ticket: number }) => {
      const result = await client.fetchQuery({ queryKey: ['workbench', 'board-run-discovery', generation, workspaceId, workflowId, runId],
        queryFn: ({ signal }) => readBoardRun(workspaceId, workflowId, runId, { signal }), staleTime: 0 })
      assertSession(generation)
      return scopeForBoardRun(result.run)
    },
    onSuccess: (scope, variables) => {
      if (variables.ticket !== request.current || variables.generation !== sessionGeneration()
        || mounted.current.workspaceId !== workspaceId || mounted.current.workflowId !== workflowId) return
      selectRun(scope)
    },
  })
  const resetDiscovery = discovery.reset
  // URL/back navigation invalidates discovery, without mirroring request state.
  useEffect(() => { ++request.current; resetDiscovery() },
    [selected?.runId, selected?.workflowVersionId, selected?.executionSemanticsVersion, resetDiscovery])
  useEffect(() => () => { ++request.current }, [])
  const latestDiscovery = discovery.variables?.ticket === request.current
  const reading = latestDiscovery && discovery.isPending ? discovery.variables?.runId : undefined
  const error = latestDiscovery && discovery.isError ? discovery.error.message : undefined
  const runs = useInfiniteQuery({ queryKey: boardRunListKey(workspaceId, workflowId),
    meta: { refetchOnApiReconnect: false },
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => readBoardRuns(workspaceId, workflowId, pageParam, { signal }),
    getNextPageParam: (page, _pages, _param, params) => page.pageInfo.nextCursor && !params.includes(page.pageInfo.nextCursor) ? page.pageInfo.nextCursor : undefined,
    maxPages: 5, staleTime: Infinity, refetchOnMount: false,
    refetchOnWindowFocus: false, refetchOnReconnect: false,
  })
  useEffect(() => {
    const key = boardRunListKey(workspaceId, workflowId)
    if (client.getQueryData(key)) void refreshBoardRuns(client, workspaceId, workflowId)
  }, [client, workspaceId, workflowId])
  const denied = useProtectedAccessError(runs)
  const listed = denied || runs.isError ? [] : [...new Map(runs.data?.pages.flatMap((page) => page.items.map((run) => [run.id, run] as const)) ?? []).values()]
  const workspaceSummaries = denied ? [] : summaries.filter((run) => run.workspaceId === workspaceId && run.workflowId === workflowId)
  const summariesById = new Map(workspaceSummaries.map((run) => [run.id, run]))
  const summaryRuns = JSON.stringify([workspaceId, workflowId,
    workspaceSummaries.map((run) => `${run.id}:${isActiveRun(run)}`).sort()])
  const previousSummaryRuns = useRef(summaryRuns)
  useEffect(() => {
    if (previousSummaryRuns.current === summaryRuns) return
    previousSummaryRuns.current = summaryRuns
    if (!denied) void refreshBoardRuns(client, workspaceId, workflowId)
  }, [summaryRuns, client, denied, workspaceId, workflowId])
  const inspect = (runId: string) => discovery.mutate({ runId, generation: sessionGeneration(), ticket: ++request.current })
  const listedIds = new Set(listed.map((item) => item.id))
  const refreshing = runs.isFetching && !runs.isRefetching
  const refreshRuns = () => void refreshFirstInspectionPage(client, boardRunListKey(workspaceId, workflowId))
  const pendingSummaries = workspaceSummaries.filter((run) => !listedIds.has(run.id))
  const empty = !runs.isPending && !listed.length && !workspaceSummaries.length && !denied && !runs.isError
  const runParts = <>
    <header className="board-run-list-header"><h3>Runs</h3>
      {!denied ? <IconButton size="sm" variant="ghost" label="Refresh runs" disabled={refreshing} onClick={refreshRuns}>
        <Icon name="refresh" size={14} /></IconButton> : null}</header>
    {error ? <p className="board-run-note" role="alert">Couldn’t open that run. {error}</p> : null}
    {denied ? <p className="board-run-note">You can’t see this workflow’s runs.</p> : runs.isError && !listed.length
      ? <p className="board-run-note" role="alert">Couldn’t load runs.<Button size="sm" variant="ghost" onClick={refreshRuns}>Try again</Button></p> : null}
    {runs.isPending && !denied ? <LoadingState label="Loading runs…" rows={3} /> : null}
    {empty ? <EmptyState icon="history" title="No runs yet" description="Runs show up here after you start one." /> : null}
    {listed.length || pendingSummaries.length ? <ul className="board-run-list">
      {pendingSummaries.map((run) => <li key={run.id}>
        <button type="button" className="board-run-row" disabled={reading === run.id} onClick={() => void inspect(run.id)} aria-label={`Inspect ${run.id}`}>
          <StatusBadge label={runLabel(run.executionState, run.outcome)} tone={runTone(run.executionState, run.outcome)} busy={run.executionState === 'running'} />
          <span>Run {shortRunId(run.id)}</span><span>{run.cleanupPending ? 'Cleaning up' : when(run.startedAt)}</span>
        </button></li>)}
      {listed.map((run) => {
        const facts = preferRunSummary(summariesById.get(run.id), run, summariesReadAt, runs.dataUpdatedAt)
        let scope: ReturnType<typeof scopeForBoardRun>
        try { scope = scopeForBoardRun(run) } catch (cause) {
          console.warn('Run cannot be shown on this board', cause)
          return <li key={run.id}><p className="board-run-note">Run {shortRunId(run.id)} can’t be shown on this board.</p></li>
        }
        const current = !!selected && sameCanonicalGraphScope(scope, selected)
        return <li key={run.id}><button type="button" className="board-run-row" aria-pressed={current}
          aria-label={`Open Run ${run.id} · ${facts.executionState} · ${facts.outcome}`}
          onClick={() => { ++request.current; resetDiscovery(); selectRun(current ? undefined : scope) }}>
          <StatusBadge label={runLabel(facts.executionState, facts.outcome)} tone={runTone(facts.executionState, facts.outcome)} busy={facts.executionState === 'running'} />
          <span>Run {shortRunId(run.id)}</span><span>{when(facts.startedAt)}</span>
        </button></li>
      })}
    </ul> : null}
    {listed.length && !selected ? <p className="board-run-note">Open a run to see its activity.</p> : null}
    {runs.hasNextPage && !denied && !runs.isError ? <Button size="sm" variant="ghost" disabled={refreshing} onClick={() => void runs.fetchNextPage()}>Show older runs</Button> : null}
    {selected ? <section className="board-run-detail" aria-label="Selected run">
      <header><h3>Run {shortRunId(selected.runId)}</h3>
        <Button size="sm" variant="ghost" onClick={() => { ++request.current; resetDiscovery(); selectRun() }}>Back to draft</Button></header>
      <CurrentRunDetails key={selected.runId} scope={selected}
        runActions={<RunActions workspaceId={selected.workspaceId} workflowId={selected.workflowId} runId={selected.runId} />} />
    </section> : null}
  </>
  return <div className="workflow-board-run-panel" aria-label="Run activity" data-testid="board-run-activity">
    <BoardChanges scope={boardScope(workspaceId, workflowId)} />
    {selected ? <>
      <Activities key={selected.runId} scope={selected} />
      <details ref={details} tabIndex={-1} className="board-run-more"><summary>Run details and other runs</summary>{runParts}</details>
    </> : runParts}
  </div>
}

/** Undo and redo steps taken on this Board in this session, newest first. */
function BoardChanges({ scope }: { scope: string }) {
  const changes = useBoardUndo((state) => state.changes[scope])
  if (!changes?.length) return null
  return <section className="board-activities board-changes" aria-label="Board changes"><header><h3>Board changes</h3></header>
    <ol className="board-activities-list">{changes.map((change) => <li key={change.id} data-status="recorded">
      <span className="board-activity-dot" aria-hidden="true" />
      <time dateTime={change.at}>{new Date(change.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}</time>
      <div><p>{change.text}</p></div></li>)}</ol>
  </section>
}
