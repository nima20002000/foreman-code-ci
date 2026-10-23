import { MemoryBoardSurface } from './MemoryBoardSurface'
import { activeRunCandidates } from '@foreman-code/contracts/run-snapshots'
import { MasterOverview } from '../workflow-hierarchy/MasterOverview'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import { useLocation, useRouter } from '@tanstack/react-router'
import type { ExecutionRef, WorkflowRunSummary } from '@foreman-code/contracts'
import type { BoardSidePanel, RepeatGraphScopeV3, WorkspaceBoardInspection } from '@foreman-code/contracts/wave25'
import { Alert, Button, Icon, IconButton } from '../../shared/ui/nocturne'
import { WorkspaceExecutionLocationSettings } from '../settings/WorkspaceExecutionLocationSettings'
import { RunBoardSlot, useRunBoardShown } from '../run-board'
import { useRunSummaries, useSelectedRun, useSelectedRunSnapshot } from '../runs-selector'
import { isRunAccessError } from '../runs-selector/query'
import { BoardNavigationControls } from './BoardNavigationControls'
import { WorkflowBoardContext, type WorkflowAuthoringActions } from './context'
import { ActivitiesPopover } from './ActivitiesPopover'
import { RunActivityPanel } from './RunActivityPanel'
import { useWorkflowSidePanel } from './useWorkflowSidePanel'
import { useBrowserSidebar } from './useBrowserSidebar'
import { WorkflowSidePanel, type WorkflowCollaborationSlots } from './WorkflowSidePanel'
import { useBrowserPanelRelease } from './useBrowserPanelRelease'
import { useBoardDrawers } from './useBoardDrawers'
import { useCollaborationUISlots } from '../../shared/ui/collaborationSlots'
import { PanelFooterSlotContext, PanelHeaderSlotContext } from '../../shared/ui/panelHeaderSlot'
import { createWorkflowExecutionChatSlot } from '../workflow-hierarchy/execution-chat/createWorkflowExecutionChatSlot'
import { SelectedRunControls } from './actions/SelectedRunControls'
import { GroupChatPanel } from './GroupChatPanel'
import { DirectionWaitNotice } from './actions/directionWait'
import { acceptFindingsDirection, mentionInGroupChat, useRunDirectionWait } from './actions/directionWaitModel'
import './workflowBoard.css'

/** This component is keyed by workspace/workflow only, NEVER by selected Run. */
export function WorkflowBoard({ workspaceId, workflowId, run: requestedRun, selectRun, inspection, selectInspection, summaries, summariesReadAt, children, selectedAgentId, selectDraftAgent, collaborationSlots: suppliedSlots }: {
  workspaceId: string; workflowId: string; run?: RepeatGraphScopeV3
  selectedAgentId?: string; selectDraftAgent?(agentId?: string): void
  inspection: WorkspaceBoardInspection; selectInspection(inspection: WorkspaceBoardInspection): void
  selectRun(scope?: RepeatGraphScopeV3): void; summaries: readonly WorkflowRunSummary[]; summariesReadAt?: number; children: ReactNode
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
  const { releaseBrowser, setMemoryOpen } = side
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
  const chooseRun = useCallback((scope?: RepeatGraphScopeV3) => {
    if (scope?.runId !== requestedRun?.runId) releaseBrowser()
    selection.current.generation++
    selectRun(scope)
  }, [selectRun, requestedRun?.runId, releaseBrowser])
  const selectedRun = useSelectedRun({ workspaceId, workflowId })
  const navigationSelection = useMemo(() => ({ ...selectedRun,
    selectRun: (runId: string | null) => {
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
  const detailsScope = useMemo<RepeatGraphScopeV3 | undefined>(() => {
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
  const followOnOpen = useRef(true)
  const selectLiveRun = navigationSelection.selectRun
  useEffect(() => {
    if (!current) followOnOpen.current = false
    if (!followOnOpen.current || !listed.isSuccess) return
    followOnOpen.current = false
    if (liveRunId) void selectLiveRun(liveRunId)
  }, [current, listed.isSuccess, liveRunId, selectLiveRun])
  // History is rendered only by RunBoardSlot. Do not feed legacy Run pins to the
  // hidden editor, or fabricate missing version/semantics pins.
  const value = useMemo(() => ({ workspaceId, workflowId, selectRun: chooseRun, getSelectionToken, inspection, selectInspection, selectedAgentId, selectDraftAgent,
    sidePanel: side.panel, selectedPanelNodeId: side.agentSelection?.nodeId, selectSidePanel: selectPanel, sidePanelHost, runCaptionHost, memoryOpen: side.memoryOpen,
    // A shown Run moves agents exactly as the draft Board does (owner rule: one Board, the same rules).
    moveDraftNodes: authoringActions?.moveNodes,
    openMemoryCard: (cardId: string) => setMemoryOpen(true, cardId),
    executionChatMounted: !!collaborationSlots?.executionChat,
    canvasVisible: side.view === 'graph', teamNodeId: side.teamNodeId, selectTeam: side.selectTeam,
    collaborationFields: collaborationSlots,
    openLocation: () => setLocationOpen(true), openRuns: () => setRunsOpen(true), activeRuns, liveRunId, authoringActive: current, registerAuthoringActions,
    ...(current && authoringActions ? { saveChatAgent: authoringActions.saveChatAgent, draftNodeAgentId: authoringActions.draftNodeAgentId, draftNodeBrowser: authoringActions.draftNodeBrowser } : {}),
    navigationControls: current && side.view === 'graph' ? <BoardNavigationControls workspaceId={workspaceId} workflowId={workflowId} selection={navigationSelection} /> : undefined,
  }), [workspaceId, workflowId, chooseRun, getSelectionToken, inspection, selectInspection, selectedAgentId, selectDraftAgent, activeRuns, liveRunId, setRunsOpen, setLocationOpen, navigationSelection, current, side.view, side.panel, side.agentSelection?.nodeId, selectPanel, sidePanelHost, runCaptionHost, side.memoryOpen, setMemoryOpen, side.teamNodeId, side.selectTeam, collaborationSlots, registerAuthoringActions, authoringActions])
  const detailsValue = useMemo(() => detailsScope ? { ...value, run: detailsScope } : value, [value, detailsScope])
  const authoringEvent = (event: SyntheticEvent) => {
    if (event.target instanceof Element && event.target.closest('.workflow-floating-panel')) return
    // React capture also covers descendants portalled outside the inert subtree.
    if (!currentRef.current) { event.preventDefault(); event.stopPropagation() }
  }
  const showExecution = (nodeId: string, execution: ExecutionRef) => {
    side.selectExecution({ ...execution, nodeId })
  }
  const runControlsScope = boardSelection.active && !boardSelection.invalid && boardSelection.identity.runId && !runUnreadable
    ? { workspaceId, workflowId, runId: boardSelection.identity.runId,
      ...(picked?.kind === 'available' ? { workflowVersionId: picked.workflowVersionId } : {}) } : undefined
  const direction = useRunDirectionWait(runControlsScope)
  const suppliedOverview = collaborationSlots?.overview
  const overviewContent = side.memoryOpen ? null : suppliedOverview?.()
  // Over the Run's canvas it floats like the draft's own toolbar, so the canvas keeps the draft's exact box.
  const shownBoard = useRunBoardShown(boardSelection)
  const boardToolbar = shownBoard === 'run' || side.view === 'overview' ? <header className="board-topbar" aria-label="Board toolbar"
        style={side.view === 'graph' ? { flexWrap: 'wrap', justifyContent: 'flex-end', boxSizing: 'border-box', minWidth: 0 }
          : { position: 'relative', inset: 'auto', zIndex: 10, flex: '0 0 auto', flexWrap: 'wrap', justifyContent: 'flex-end', padding: 'var(--space-2)', boxSizing: 'border-box', minWidth: 0 }}>
        {side.view === 'graph' ? <div className="board-run-caption" ref={setRunCaptionHost} /> : null}
        {direction && !side.memoryOpen ? <DirectionWaitNotice direction={direction} onAnswer={() => {
          mentionInGroupChat({ workspaceId, workflowId }, direction)
          side.selectPanel({ kind: 'group_chat' })
        }} onAccept={() => {
          mentionInGroupChat({ workspaceId, workflowId }, direction, acceptFindingsDirection)
          side.selectPanel({ kind: 'group_chat' })
        }} /> : null}
        <BoardNavigationControls workspaceId={workspaceId} workflowId={workflowId} selection={navigationSelection}
          runsLabel={current && side.view === 'overview' ? 'Choose run' : undefined} />
        {detailsScope && !runUnreadable ? <IconButton label="Activities" onClick={() => setRunsOpen(true)}><Icon name="history" size={16} /></IconButton> : null}
        <IconButton label="Group chat" onClick={() => side.selectPanel({ kind: 'group_chat' })}><Icon name="chat" size={16} /></IconButton>
        {runControlsScope ?
          <SelectedRunControls key={JSON.stringify(boardSelection.identity)} visible={!side.memoryOpen}
            scope={runControlsScope} /> : null}
      </header> : null
  return <WorkflowBoardContext.Provider value={value}><PanelHeaderSlotContext.Provider value={panelHeaderSlot}><PanelFooterSlotContext.Provider value={panelFooterSlot}>
    <div ref={toolbar} className="unified-workflow-board" data-testid="unified-workflow-board" style={{ flexDirection: 'column' }}>
      <nav className="workflow-collaboration-toolbar" aria-label="Workflow views">
        <span>{legacyRun || pickedRunId ? 'Selected Run' : 'Editing draft'}</span>
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
      <div className="workflow-collaboration-canvas" hidden={side.view !== 'graph'} inert={side.view !== 'graph'}>
      <RunBoardSlot selection={boardSelection} shown={shownBoard}>
        <div className="workflow-board-authoring" onClickCapture={authoringEvent} onKeyDownCapture={authoringEvent} onSubmitCapture={authoringEvent}>
          {children}
          <ActivitiesPopover open={current && runsOpen} onClose={() => setRunsOpen(false)} findAnchor={findActivitiesButton}>
            {current ? <RunActivityPanel summaries={summaries} summariesReadAt={summariesReadAt} /> : null}
          </ActivitiesPopover>
          {current && locationOpen ? <WorkspaceExecutionLocationSettings workspaceId={workspaceId} presentation="dialog"
            open onOpenChange={setLocationOpen} onSaved={() => setLocationOpen(false)} /> : null}
        </div>
      </RunBoardSlot>
      </div>
      {side.view === 'overview' ? <section className="workflow-overview-slot" aria-label="Workflow Overview"
        hidden={side.memoryOpen} inert={side.memoryOpen}>
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
      {detailsScope ? <WorkflowBoardContext.Provider value={detailsValue}>
        <ActivitiesPopover open={runsOpen} onClose={() => setRunsOpen(false)} findAnchor={findActivitiesButton}>
          <RunActivityPanel summaries={summaries} summariesReadAt={summariesReadAt} />
        </ActivitiesPopover>
      </WorkflowBoardContext.Provider> : null}
      <WorkflowSidePanel scope={side.scope} workspaceId={workspaceId} workflowId={workflowId}
        workflowVersionId={legacyRun?.workflowVersionId ?? (picked?.kind === 'available' ? picked.workflowVersionId : undefined)}
        opener={side.opener} runId={legacyRun?.runId ?? pickedRunId} selection={side.panel} agentSelection={side.agentSelection} onSelect={selectPanel} bodyRef={setSidePanelHost} headerSlotRef={setPanelHeaderSlot} footerSlotRef={setPanelFooterSlot}
        onSelectTarget={side.selectChatTarget} onSelectRun={side.selectChatRun}
        modalOpen={side.memoryOpen} slots={{ ...collaborationSlots, groupChat: collaborationSlots?.groupChat ?? (() =>
          <GroupChatPanel workspaceId={workspaceId} workflowId={workflowId} runId={legacyRun?.runId ?? pickedRunId} onSelect={side.selectPanel} />) }} />
      {browsersOpen && !side.memoryOpen ? collaborationSlots?.browserSidebar?.({ workspaceId, workflowId, runId: legacyRun?.runId ?? pickedRunId,
        workflowVersionId: legacyRun?.workflowVersionId ?? (picked?.kind === 'available' ? picked.workflowVersionId : undefined) }) : null}
      </div>
      {side.memoryOpen && <MemoryBoardSurface scope={{ kind: 'workflow', workspaceId, workflowId }}
          scopeName="Workflow" dialog={{ open: true, onOpenChange: side.setMemoryOpen, historicalRun: Boolean(legacyRun || pickedRunId) }} />}
    </div>
  </PanelFooterSlotContext.Provider></PanelHeaderSlotContext.Provider></WorkflowBoardContext.Provider>
}
