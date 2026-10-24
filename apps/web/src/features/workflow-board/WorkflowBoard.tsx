import { MemoryBoardSurface } from './MemoryBoardSurface'
import { activeRunCandidates } from '@foreman-code/contracts/run-snapshots'
import { MasterOverview, createWorkflowExecutionChatSlot, resolveExecutionChat } from '../workflow-hierarchy'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import { useLocation, useRouter } from '@tanstack/react-router'
import { useMutation } from '@tanstack/react-query'
import { useGraphDraftStore } from '../graph'
import type { ExecutionRef, WorkflowRunSummary, WorkflowExecutionChatTarget } from '@foreman-code/contracts'
import type { BoardSidePanel, RepeatGraphScopeCurrent, WorkspaceBoardInspection } from '@foreman-code/contracts/current'
import { Alert, Button, Icon, IconButton } from '../../shared/ui/nocturne'
import { WorkspaceExecutionLocationSettings } from '../settings'
import { BoardRunOverlay, useBoardRunSnapshot, RunBoardSlot, useRunBoardShown } from '../run-board'
import { useRunSummaries, useSelectedRun, useSelectedRunSnapshot, isRunAccessError } from '../runs-selector'
import { useCurrentRunQuery } from './currentRunQuery'
import { BoardNavigationControls } from './BoardNavigationControls'
import {
  BoardAuthoringContext, BoardHostsContext, BoardSelectionContext,
  nextDraftKey, nextDraftDirty,
  type WorkflowAuthoringActions, type WorkflowBoardAuthoring, type WorkflowBoardSelection,
} from '../board-core'
import { ActivitiesPopover } from './ActivitiesPopover'
import { RunActivityPanel } from './RunActivityPanel'
import { useWorkflowSidePanel } from './useWorkflowSidePanel'
import { useBrowserSidebar } from './useBrowserSidebar'
import { WorkflowSidePanel, type WorkflowCollaborationSlots } from './WorkflowSidePanel'
import { useBrowserPanelRelease } from './useBrowserPanelRelease'
import { useBoardDrawers } from './useBoardDrawers'
import { useCollaborationUISlots } from '../../shared/ui/collaborationSlots'
import { PanelFooterSlotContext, PanelHeaderSlotContext } from '../../shared/ui/panelHeaderSlot'
import { SelectedRunControls } from './actions/SelectedRunControls'
import { appendExecutionChatDraft } from '../conversations'
import { DirectionWaitNotice } from './actions/directionWait'
import { acceptFindingsDirection, useRunDirectionWait } from './actions/directionWaitModel'
import './workflowBoard.css'

/** This component is keyed by workspace/workflow only, NEVER by selected Run. */
export function WorkflowBoard({ workspaceId, workflowId, run: requestedRun, selectRun, inspection, selectInspection, summaries, summariesReadAt, children, selectedAgentId, selectDraftAgent, collaborationSlots: suppliedSlots }: {
  workspaceId: string; workflowId: string; run?: RepeatGraphScopeCurrent
  selectedAgentId?: string; selectDraftAgent?(agentId?: string): void
  inspection: WorkspaceBoardInspection; selectInspection(inspection: WorkspaceBoardInspection, scope?: RepeatGraphScopeCurrent): void
  selectRun(scope?: RepeatGraphScopeCurrent): void; summaries: readonly WorkflowRunSummary[]; summariesReadAt?: number; children: ReactNode
  collaborationSlots?: WorkflowCollaborationSlots
}) {
  const location = useLocation()
  const router = useRouter()
  const sharedSlots = useCollaborationUISlots()
  const inheritedSlots = sharedSlots?.workflow?.({ workspaceId, workflowId })
  const executionChat = useMemo(() => sharedSlots?.executionChatViews
    ? createWorkflowExecutionChatSlot(sharedSlots.executionChatViews) : undefined, [sharedSlots?.executionChatViews])
  const collaborationSlots = useMemo<WorkflowCollaborationSlots | undefined>(() => sharedSlots || suppliedSlots
    ? { memoryAccess: sharedSlots?.memoryAccess, nodeBrowser: sharedSlots?.nodeBrowser, ...inheritedSlots, ...suppliedSlots,
      ...(executionChat ? { executionChat } : {}) }
    : undefined, [sharedSlots, inheritedSlots, suppliedSlots, executionChat])
  const browserRelease = useBrowserPanelRelease(collaborationSlots?.beforeBrowserHide)
  const side = useWorkflowSidePanel(workspaceId, workflowId, requestedRun, browserRelease.request)
  const { releaseBrowser, setMemoryOpen, selectChatTarget: selectHistoricalChatTarget, selectChatRun: selectHistoricalChatRun } = side
  const { open: openBrowsers, isOpen: browsersOpen } = useBrowserSidebar(workspaceId, workflowId)
  const { selectPanel: selectSidePanel, panel: sidePanel } = side, sideNodeId = side.agentSelection?.nodeId
  // An Agent's browser opens as a tab in the browser sidebar, not inside the floating panel.
  const selectPanel = useCallback((next: BoardSidePanel, replace?: boolean) => {
    if (next.kind === 'browser') openBrowsers(next.nodeId ?? sideNodeId)
    else selectSidePanel(next, replace)
  }, [openBrowsers, selectSidePanel, sideNodeId])
  useEffect(() => {
    if (sidePanel.kind === 'browser') openBrowsers(sidePanel.nodeId, { replace: true, leavePanel: true })
  }, [sidePanel, openBrowsers])
  const [sidePanelHost, setSidePanelHost] = useState<HTMLDivElement | null>(null)
  const [panelHeaderSlot, setPanelHeaderSlot] = useState<HTMLDivElement | null>(null)
  const [panelFooterSlot, setPanelFooterSlot] = useState<HTMLDivElement | null>(null)
  const [runCaptionHost, setRunCaptionHost] = useState<HTMLDivElement | null>(null)
  const [runActionHost, setRunActionHost] = useState<HTMLElement | null>(null)
  const [authoringToolbarHost, setAuthoringToolbarHost] = useState<HTMLElement | null>(null)
  const [authoringPanelHost, setAuthoringPanelHost] = useState<HTMLElement | null>(null)
  const draftDirty = useGraphDraftStore(state => {
    const edit = state.nextDrafts[nextDraftKey(workspaceId, workflowId)]
    return !!edit && nextDraftDirty(edit)
  })
  const [authoringActions, setAuthoringActions] = useState<WorkflowAuthoringActions>()
  const registerAuthoringActions = useCallback((actions?: WorkflowAuthoringActions) => setAuthoringActions(actions), [])
  const selection = useRef({ location: router.history.location, generation: 0 })
  const getSelectionToken = useCallback(() => {
    if (selection.current.location !== router.history.location) {
      selection.current.location = router.history.location
      selection.current.generation++
    }
    return selection.current.generation
  }, [router])
  const chooseRun = useCallback((scope?: RepeatGraphScopeCurrent) => {
    if (scope?.runId !== requestedRun?.runId) releaseBrowser()
    selection.current.generation++
    selectRun(scope)
  }, [selectRun, requestedRun?.runId, releaseBrowser])
  const selectedRun = useSelectedRun({ workspaceId, workflowId })
  // The Run painted on the draft's nodes is the Board itself: choosing it (Runs, Running) shows the Board, not a page.
  const [paintedRunId, setPaintedRunId] = useState<string>()
  const paintedRef = useRef(paintedRunId)
  paintedRef.current = paintedRunId
  const navigationSelection = useMemo(() => ({ ...selectedRun,
    selectRun: (chosen: string | null) => {
      const runId = chosen !== null && chosen === paintedRef.current ? null : chosen
      if (runId !== selectedRun.identity.runId) releaseBrowser()
      selection.current.generation++
      return selectedRun.selectRun(runId)
    },
  }), [selectedRun, releaseBrowser])
  // Canonical and legacy links both render the immutable RunBoardSlot.
  const legacyRun = requestedRun?.workspaceId === workspaceId && requestedRun.workflowId === workflowId
    && !location.search.selectedRunId ? requestedRun : undefined
  const pickedQuery = useSelectedRunSnapshot(selectedRun)
  const picked = pickedQuery.snapshot
  // A missing or forbidden Run has nothing to stop or inspect; the Run board explains it once.
  const runUnreadable = isRunAccessError(pickedQuery.error) && !picked
  const pickedRunId = location.search.selectedRunId
  // Background Run facts update the counter; only explicit navigation selects a Run.
  const listed = useRunSummaries({ workspaceId, workflowId }, !requestedRun && !pickedRunId)
  const candidates = activeRunCandidates(
    summaries.filter(item => item.workspaceId === workspaceId && item.workflowId === workflowId), listed.items,
  )
  const boardSelection = selectedRun
  const current = boardSelection.active && !boardSelection.invalid && boardSelection.identity.runId === null
  const currentRef = useRef(current)
  currentRef.current = current
  // The retained editor is hidden while a Run is shown, so its Activities button is unavailable;
  // the Run's own Activities and details open from the Board toolbar over this exact scope.
  const selectedRunId = boardSelection.active && !boardSelection.invalid ? boardSelection.identity.runId : null
  const detailsScope = useMemo<RepeatGraphScopeCurrent | undefined>(() => {
    if (!selectedRunId) return undefined
    if (legacyRun?.runId === selectedRunId) return legacyRun
    return picked?.kind === 'available' && picked.runId === selectedRunId
      ? { workspaceId, workflowId, runId: selectedRunId, workflowVersionId: picked.workflowVersionId, executionSemanticsVersion: 3 }
      : undefined
  }, [selectedRunId, legacyRun, picked, workspaceId, workflowId])
  const { toolbar, locationOpen, setLocationOpen, runsOpen, setRunsOpen, findActivitiesButton } = useBoardDrawers({
    workspaceId, workflowId, current, currentRef, detailsScope })
  const activeRuns = candidates.length
  // The newest live Run. Opening the Board while it runs shows it at once; a Run that starts later while the owner
  // edits only lights the Running control, so the editor is never pulled away.
  const liveRunId = [...candidates].sort((a, b) => (a.startedAt ?? '').localeCompare(b.startedAt ?? '')).at(-1)?.id
  // One Board: the draft shows its latest Run on the same nodes (live, then its final states). Only an explicitly
  // chosen older Run opens the saved Run view. A Run started here shows at once, before the Run list catches up.
  const [startedRunId, setStartedRunId] = useState<string>()
  const newest = listed.items[0]
  const startedListed = startedRunId ? listed.items.find(item => item.runId === startedRunId) : undefined
  const startedLive = !!startedRunId && (!startedListed || ['queued', 'running', 'waiting', 'interrupted'].includes(startedListed.status))
  const boardRunId = current ? liveRunId ?? (startedLive ? startedRunId : newest?.runId) : undefined
  const boardRunLive = !!boardRunId && (boardRunId === liveRunId || (boardRunId === startedRunId && startedLive))
  const boardRun = useMemo(() => boardRunId ? { workspaceId, workflowId, runId: boardRunId, live: boardRunLive } : undefined,
    [workspaceId, workflowId, boardRunId, boardRunLive])
  const displayedRun = useBoardRunSnapshot(boardRun, current && !side.memoryOpen)
  const boardSnapshot = !displayedRun.isError && displayedRun.data?.snapshot
  const boardVersionId = boardSnapshot && boardSnapshot.kind === 'available' && boardSnapshot.runId === boardRunId
    ? boardSnapshot.workflowVersionId : undefined
  const boardStatusScope: RepeatGraphScopeCurrent | undefined = boardRunId && boardVersionId
    ? { workspaceId, workflowId, runId: boardRunId, workflowVersionId: boardVersionId, executionSemanticsVersion: 3 } : undefined
  const boardCurrent = useCurrentRunQuery(current && !side.memoryOpen ? boardStatusScope : undefined, boardRunLive)
  const boardRunState = !boardCurrent.isError ? boardCurrent.data?.state.run : undefined
  const boardRunStopping = !!boardRunState && (boardRunState.stopRequested || boardRunState.cleanupPending)
  const previousBoardRunId = useRef(boardRunId)
  useEffect(() => {
    const previous = previousBoardRunId.current
    previousBoardRunId.current = boardRunId
    if (boardRunId && side.agentSelection && (previous && previous !== boardRunId
      || side.agentSelection.runId && side.agentSelection.runId !== boardRunId)) {
      selectPanel({ kind: 'agent', nodeId: side.agentSelection.nodeId, tab: side.agentSelection.tab })
    }
  }, [boardRunId, side.agentSelection, selectPanel])
  const selectChatTarget = useCallback((target: WorkflowExecutionChatTarget, versionId: string) => {
    const targetRunId = target.kind === 'workflow_execution' ? target.execution.runId : target.runId
    if (current && displayedRun.scope?.runId === targetRunId && displayedRun.scope.workflowVersionId === versionId
      && target.agent.workspaceId === workspaceId && target.agent.workflowId === workflowId) {
      selectPanel({ kind: 'agent', nodeId: target.agent.workflowNodeId, runId: targetRunId, tab: 'chat',
        ...(target.kind === 'workflow_execution' ? { executionId: target.execution.executionId }
          : { waitingActivationId: target.waitingActivationId }) })
    } else selectHistoricalChatTarget(target, versionId)
  }, [current, displayedRun.scope, workspaceId, workflowId, selectPanel, selectHistoricalChatTarget])
  const chatNodeId = side.agentSelection?.nodeId
  const selectChatRun = useCallback((target: { runId: string; workflowVersionId?: string } | undefined) => {
    if (current && target && target.runId === displayedRun.scope?.runId && chatNodeId) {
      selectPanel({ kind: 'agent', nodeId: chatNodeId, tab: 'chat' })
    } else selectHistoricalChatRun(target)
  }, [current, displayedRun.scope?.runId, chatNodeId, selectPanel, selectHistoricalChatRun])
  const boardRunControls = useMemo(() => boardRunId ? <SelectedRunControls key={boardRunId} visible={!side.memoryOpen}
    scope={{ workspaceId, workflowId, runId: boardRunId, ...(boardVersionId ? { workflowVersionId: boardVersionId } : {}) }} runActionRef={setRunActionHost} /> : undefined,
  [boardRunId, boardVersionId, side.memoryOpen, workspaceId, workflowId])
  const runControlsScope = boardSelection.active && !boardSelection.invalid && boardSelection.identity.runId && !runUnreadable
    ? { workspaceId, workflowId, runId: boardSelection.identity.runId,
      ...(picked?.kind === 'available' ? { workflowVersionId: picked.workflowVersionId } : {}) } : undefined
  const directionScope = runControlsScope ?? displayedRun.scope
  const direction = useRunDirectionWait(directionScope)
  const directionChat = useMutation({
    mutationFn: async ({ scope, waiting }: { scope: NonNullable<typeof directionScope>;
      waiting: NonNullable<typeof direction>; token: number; text?: string }) => {
      const selected = await resolveExecutionChat({ workspaceId: scope.workspaceId, workflowId: scope.workflowId,
        runId: scope.runId, workflowVersionId: scope.workflowVersionId, workflowNodeId: waiting.workflowNodeId, executionId: waiting.executionId })
      if (selected.kind !== 'selected') throw new Error('The waiting Agent chat is unavailable. Refresh this Run and try again.')
      return selected
    },
    onSuccess: (selected, request) => {
      if (request.token !== getSelectionToken()) return
      if (request.text) appendExecutionChatDraft(selected.target, request.text)
      selectChatTarget(selected.target, selected.workflowVersionId)
    },
  })
  const { mutate: resolveDirectionChat } = directionChat
  const openDirectionChat = useCallback((text?: string) => {
    if (direction && directionScope) resolveDirectionChat({ scope: directionScope, waiting: direction,
      token: getSelectionToken(), text })
  }, [direction, directionScope, resolveDirectionChat, getSelectionToken])
  const directionNotice = useMemo(() => <>
    {direction && !side.memoryOpen ? <DirectionWaitNotice direction={direction}
      onAnswer={() => openDirectionChat()} onAccept={() => openDirectionChat(acceptFindingsDirection)} /> : null}
    {directionChat.isError && directionChat.variables.token === getSelectionToken() ? <p role="alert">{directionChat.error.message}</p> : null}
  </>, [direction, side.memoryOpen, directionChat.isError, directionChat.variables, directionChat.error, getSelectionToken, openDirectionChat])
  // History is rendered only by RunBoardSlot. Do not feed legacy Run pins to the
  // hidden editor, or fabricate missing version/semantics pins.
  const inspectRun = useCallback((next: WorkspaceBoardInspection, scope?: RepeatGraphScopeCurrent) => selectInspection(next, scope ?? detailsScope), [selectInspection, detailsScope])
  const value = useMemo<WorkflowBoardSelection>(() => ({ workspaceId, workflowId, selectRun: chooseRun, getSelectionToken, inspection, selectInspection: inspectRun, selectedAgentId, selectDraftAgent,
    sidePanel: side.panel, selectedPanelNodeId: side.agentSelection?.nodeId, selectSidePanel: selectPanel, memoryOpen: side.memoryOpen,
    openMemoryCard: (cardId?: string) => setMemoryOpen(true, cardId),
    canvasVisible: side.view === 'graph', teamNodeId: side.teamNodeId, selectTeam: side.selectTeam,
    openLocation: () => setLocationOpen(true), openRuns: () => setRunsOpen(true), activeRuns, liveRunId, authoringActive: current,
    boardRunLive, boardRunControls, paintedRunId,
    // Starting from an older Run's view returns to the Board, where the new Run shows.
    showRunOnBoard: (runId: string) => { setStartedRunId(runId); if (!current) void navigationSelection.selectRun(null) },
    navigationControls: current ? <>{directionNotice}<BoardNavigationControls workspaceId={workspaceId} workflowId={workflowId} selection={navigationSelection} stopping={boardRunStopping} /></> : undefined,
  }), [workspaceId, workflowId, chooseRun, getSelectionToken, inspection, inspectRun, selectedAgentId, selectDraftAgent, activeRuns, liveRunId, boardRunLive, boardRunControls, paintedRunId, boardRunStopping, directionNotice, setRunsOpen, setLocationOpen, navigationSelection, current, side.view, side.panel, side.agentSelection?.nodeId, selectPanel, side.memoryOpen, setMemoryOpen, side.teamNodeId, side.selectTeam])
  const hosts = useMemo(() => ({ sidePanelHost, runCaptionHost, runActionHost,
    authoringToolbarHost: current ? authoringToolbarHost : null, authoringPanelHost: current ? authoringPanelHost : null }),
  [sidePanelHost, runCaptionHost, runActionHost, current, authoringToolbarHost, authoringPanelHost])
  const authoring = useMemo<WorkflowBoardAuthoring>(() => ({ registerAuthoringActions,
    openWorkflowSettings: () => { void navigationSelection.selectRun(null).then(() => authoringActions?.openWorkflowSettings()) },
    // A shown Run moves agents exactly as the draft Board does (owner rule: one Board, the same rules).
    moveDraftNodes: authoringActions?.moveNodes,
    executionChatMounted: !!collaborationSlots?.executionChat, collaborationFields: collaborationSlots,
    ...(current && authoringActions ? { saveChatAgent: authoringActions.saveChatAgent, draftNodeAgentId: authoringActions.draftNodeAgentId, draftNodeBrowser: authoringActions.draftNodeBrowser } : {}),
  }), [registerAuthoringActions, authoringActions, collaborationSlots, current, navigationSelection])
  const detailsValue = useMemo(() => detailsScope ? { ...value, run: detailsScope } : value, [value, detailsScope])
  const authoringEvent = (event: SyntheticEvent) => {
    if (event.target instanceof Element && event.target.closest('.workflow-floating-panel, .selected-run-controls')) return
    // React capture also covers descendants portalled outside the inert subtree.
    if (!currentRef.current) { event.preventDefault(); event.stopPropagation() }
  }
  const showExecution = (nodeId: string, execution: ExecutionRef) => {
    side.selectExecution({ ...execution, nodeId })
  }
  const suppliedOverview = collaborationSlots?.overview
  const overviewContent = side.memoryOpen ? null : suppliedOverview?.()
  // Over the Run's canvas it floats like the draft's own toolbar, so the canvas keeps the draft's exact box.
  const shownBoard = useRunBoardShown(boardSelection)
  const boardToolbar = current ? <header className="board-topbar" aria-label="Board toolbar" ref={setAuthoringToolbarHost}
    style={side.view === 'overview' ? { position: 'relative', inset: 'auto', flex: '0 0 auto', padding: 'var(--space-2)' } : undefined} />
    : shownBoard === 'run' || side.view === 'overview' ? <header className="board-topbar" aria-label="Board toolbar"
        style={side.view === 'graph' ? { flexWrap: 'wrap', justifyContent: 'flex-end', boxSizing: 'border-box', minWidth: 0 }
          : { position: 'relative', inset: 'auto', zIndex: 10, flex: '0 0 auto', flexWrap: 'wrap', justifyContent: 'flex-end', padding: 'var(--space-2)', boxSizing: 'border-box', minWidth: 0 }}>
        {side.view === 'graph' ? <div className="board-run-caption" ref={setRunCaptionHost} /> : null}
        {directionNotice}
        <BoardNavigationControls workspaceId={workspaceId} workflowId={workflowId} selection={navigationSelection}
          stopping={boardRunStopping} runsLabel={current && side.view === 'overview' ? 'Choose run' : undefined} />
        {(current || detailsScope && !runUnreadable) ? <IconButton label="Activities" onClick={() => setRunsOpen(true)}><Icon name="history" size={16} /></IconButton> : null}
        {runControlsScope ?
          <SelectedRunControls key={boardSelection.identity.runId} visible={!side.memoryOpen}
            scope={runControlsScope} runActionRef={setRunActionHost} /> : current && side.view === 'overview' ? boardRunControls : null}
      </header> : null
  return <BoardSelectionContext.Provider value={value}><BoardHostsContext.Provider value={hosts}><BoardAuthoringContext.Provider value={authoring}>
    <PanelHeaderSlotContext.Provider value={panelHeaderSlot}><PanelFooterSlotContext.Provider value={panelFooterSlot}>
    <div ref={toolbar} className="unified-workflow-board" data-testid="unified-workflow-board" style={{ flexDirection: 'column' }}>
      <nav className="workflow-collaboration-toolbar" aria-label="Workflow views">
        <span>{legacyRun || pickedRunId ? 'Selected Run' : boardRunLive ? 'Run in progress · editing locked' : 'Editing draft'}</span>
        <Button size="sm" variant="ghost" aria-pressed={side.view === 'graph'} onClick={() => side.selectView('graph')}>Graph</Button>
        <Button size="sm" variant="ghost" aria-pressed={side.view === 'overview'} onClick={() => side.selectView('overview')}>Overview</Button>
      </nav>
      {browserRelease.error ? <Alert tone="warning" title="Browser control release is unconfirmed.">
        {browserRelease.error} Use the retained browser recovery controls to reconcile the original release.</Alert> : null}
      {collaborationSlots?.browserRecovery?.()}

      <div className="workflow-collaboration-layout">
      {/* One parent for the toolbar in both views, so switching Graph/Overview never remounts it (or a Stop in flight). */}
      <div className="workflow-collaboration-main">
      {boardToolbar}
      <div ref={setAuthoringPanelHost} />
      <div className="workflow-collaboration-canvas" hidden={side.view !== 'graph'} inert={side.view !== 'graph'}>
      <RunBoardSlot selection={boardSelection} shown={shownBoard}>
        <BoardRunOverlay run={boardRun} read={displayedRun} visible={current && side.view === 'graph' && !side.memoryOpen} onPainted={setPaintedRunId}>
        <div className="workflow-board-authoring" onClickCapture={authoringEvent} onKeyDownCapture={authoringEvent} onSubmitCapture={authoringEvent}>
          {children}
          {current && locationOpen ? <WorkspaceExecutionLocationSettings workspaceId={workspaceId} presentation="dialog"
            open onOpenChange={setLocationOpen} onSaved={() => setLocationOpen(false)} /> : null}
        </div>
        </BoardRunOverlay>
      </RunBoardSlot>
      </div>
      {side.view === 'overview' ? <section className="workflow-overview-slot" aria-label="Workflow Overview"
        hidden={side.memoryOpen} inert={side.memoryOpen}>
        {current && draftDirty ? <Alert tone="warning" title="Overview shows the current saved workflow. Unsaved Board changes are not shown.">
          <Button size="sm" onClick={() => side.selectView('graph')}>Review draft changes</Button>
        </Alert> : null}
        {suppliedOverview ? overviewContent : <MasterOverview workspaceId={workspaceId} workflowId={workflowId}
          visible={!side.memoryOpen}
          runId={legacyRun?.runId ?? pickedRunId}
          teamNodeId={side.teamNodeId} onTeam={side.selectTeam}
          onChat={(nodeId, execution) => side.selectPanel({ kind: 'agent', nodeId, tab: 'chat',
            ...(execution ? { executionId: execution.executionId } : {}) })}
          onSettings={nodeId => side.selectPanel({ kind: 'agent', nodeId, tab: 'settings' })}
          onReport={report => showExecution(report.agent.workflowNodeId, report.execution)}
          onExecution={(agent, execution) => showExecution(agent.workflowNodeId, execution)}
          onChooseMaster={current && authoringActions ? () => { side.selectView('graph'); authoringActions.openWorkflowSettings() } : undefined}
          onCurrentWorkflow={() => { void navigationSelection.selectRun(null) }}
          onCard={collaborationSlots?.reportCard} />}
      </section> : null}
      </div>
      <BoardSelectionContext.Provider value={detailsValue}>
        <ActivitiesPopover open={(current || Boolean(detailsScope)) && runsOpen} onClose={() => setRunsOpen(false)} findAnchor={findActivitiesButton}>
          <RunActivityPanel summaries={summaries} summariesReadAt={summariesReadAt} />
        </ActivitiesPopover>
      </BoardSelectionContext.Provider>
      <WorkflowSidePanel scope={side.scope} workspaceId={workspaceId} workflowId={workflowId}
        savedNodeName={!current ? (picked?.kind === 'available' ? picked.nodes.find(node => node.id === side.agentSelection?.nodeId)?.name : undefined) ?? 'Agent' : undefined}
        workflowVersionId={displayedRun.scope?.workflowVersionId ?? legacyRun?.workflowVersionId ?? (picked?.kind === 'available' ? picked.workflowVersionId : undefined)}
        opener={side.opener} runId={displayedRun.scope?.runId ?? legacyRun?.runId ?? pickedRunId} selection={side.panel} agentSelection={side.agentSelection} onSelect={selectPanel} bodyRef={setSidePanelHost} headerSlotRef={setPanelHeaderSlot} footerSlotRef={setPanelFooterSlot}
        onSelectTarget={selectChatTarget} onSelectRun={selectChatRun}
        modalOpen={side.memoryOpen} slots={collaborationSlots} />
      {browsersOpen && !side.memoryOpen ? collaborationSlots?.browserSidebar?.({ workspaceId, workflowId, runId: legacyRun?.runId ?? pickedRunId,
        workflowVersionId: legacyRun?.workflowVersionId ?? (picked?.kind === 'available' ? picked.workflowVersionId : undefined) }) : null}
      </div>
      {side.memoryOpen && <MemoryBoardSurface scope={{ kind: 'workflow', workspaceId, workflowId }}
          scopeName="Workflow" dialog={{ open: true, onOpenChange: side.setMemoryOpen, historicalRun: Boolean(legacyRun || pickedRunId) }} />}
    </div>
  </PanelFooterSlotContext.Provider></PanelHeaderSlotContext.Provider>
  </BoardAuthoringContext.Provider></BoardHostsContext.Provider></BoardSelectionContext.Provider>
}
