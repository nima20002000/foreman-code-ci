import { useState } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { BrowserTargetSelectionSchema, BrowserTargetResultSchema, type BrowserTargetResult } from '@foreman-code/contracts'
import type { WorkflowCollaborationSlots } from '../features/workflow-board'
import { useWorkflowBoard } from '../features/board-core'
import { AgentBrowserPanel } from '../features/agent-browser'
import { useBrowserProfiles } from '../features/browser-profiles'
import { ApiError, apiClient } from '../shared/api/client'
import { Button } from '../shared/ui/nocturne'
import { browserFilesClient } from './browserClients'
import { browserProfileClient, browserSessionClient } from './browserRecovery'
import { browserAuthBoundary, useBrowserComputers } from './browserComputerFacts'

type Selection = Parameters<NonNullable<WorkflowCollaborationSlots['browser']>>[0]
export function WorkflowBrowser(props: Selection) {
  return props.nodeId ? <SelectedWorkflowBrowser key={JSON.stringify([props.workspaceId, props.workflowId, props.runId, props.nodeId])} {...props} nodeId={props.nodeId} />
    : <p>Select an Agent on the Board, then open Browser.</p>
}
function SelectedWorkflowBrowser(props: Selection & { nodeId: string }) {
  const board = useWorkflowBoard(), navigate = useNavigate(), location = useLocation()
  const agentId = board?.draftNodeAgentId?.(props.nodeId)
  return <WorkflowBrowserTarget {...props} {...(agentId ? { agentId } : {})}
    onSelect={(sessionId, tabId) => board?.selectSidePanel?.({ ...props, kind: 'browser', sessionId, tabId })}
    onOpenSettings={() => board?.selectSidePanel?.({ kind: 'agent', nodeId: props.nodeId, tab: 'settings' })}
    onPickTarget={(runId, workflowVersionId, executionId, waitingActivationId) => {
      void navigate({ to: location.pathname, search: previous => ({ ...previous, workflowId: props.workflowId,
        runId, workflowVersionId, executionSemanticsVersion: 3, selectedRunId: undefined, boardPanel: 'browser',
        boardNodeId: props.nodeId, boardExecutionId: executionId, boardWaitingActivationId: waitingActivationId,
        browserSessionId: undefined, browserTabId: undefined }) })
    }} />
}

export interface WorkflowBrowserTargetProps {
  workspaceId: string; workflowId: string; nodeId: string; runId?: string; workflowVersionId?: string
  executionId?: string; waitingActivationId?: string; sessionId?: string; tabId?: string
  /** The node's Agent, so a node not saved in the workflow yet still finds its chat's browser. */
  agentId?: string
  /** The browser sidebar names the Agent itself and hides raw ids. */
  compact?: boolean
  onSelect(sessionId?: string, tabId?: string): void
  onOpenSettings(): void
  onPickTarget(runId: string, workflowVersionId: string, executionId?: string, waitingActivationId?: string): void
}
/** One Agent's browser: resolves the exact Agent subject for the node and shows its live browser. */
export function WorkflowBrowserTarget(props: WorkflowBrowserTargetProps) {
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | null>(null)
  const input = BrowserTargetSelectionSchema.parse({ workspaceId: props.workspaceId, workflowId: props.workflowId,
    workflowNodeId: props.nodeId, runId: props.runId, workflowVersionId: props.workflowVersionId,
    executionId: props.executionId, waitingActivationId: props.waitingActivationId, agentId: props.agentId, cursor })
  const query = useQuery({ queryKey: ['browser-target', browserAuthBoundary(), input],
    queryFn: ({ signal }) => apiClient.request(`/api/browser/target?${new URLSearchParams({ input: JSON.stringify(input) })}`, BrowserTargetResultSchema, { signal }) })
  const catalog = useBrowserProfiles(browserProfileClient, browserAuthBoundary(), true), facts = useBrowserComputers()
  const result = query.data
  return <>
    {query.isPending ? <p role="status">Finding the selected Agent’s browser…</p> : null}
    {query.error ? <p role="alert">{browserTargetError(query.error)}<Button onClick={() => { void query.refetch() }}>Retry</Button></p> : null}
    {result?.kind === 'selected' ? <AgentBrowserPanel visible compact={props.compact} selection={{
      authBoundary: browserAuthBoundary(), visitKey: JSON.stringify([result.subject, props.sessionId]),
      subject: result.subject, sessionId: props.sessionId ?? null, tabId: props.tabId ?? null,
      enabled: result.browser.enabled, historical: result.historical }} port={browserSessionClient} files={browserFilesClient}
      preparation={result.preparation} computerName={facts.computers.find(computer => computer.id === result.computerId)?.name ?? 'Selected computer'}
      profileName={catalog.data?.profiles.find(profile => profile.id === result.browser.profileId)?.name ?? 'Browser profile'}
      readOnly={result.readOnly} onOpenSettings={props.onOpenSettings}
      onSelectSession={sessionId => props.onSelect(sessionId)} onSelectTab={tabId => props.onSelect(props.sessionId, tabId)}
      onCleanupError={message => setNotice(message && browserTargetError(new Error(message)))} /> : null}
    {result?.kind === 'unavailable' ? <p>{result.reason === 'conversation_missing' ? 'Start an Agent chat to open its saved browser.'
      : result.reason === 'consultation_idle' ? 'The coordinator has no active consultation browser.' : 'This Agent browser is unavailable.'}</p> : null}
    {result?.kind === 'choose_target' ? <BrowserTargetChoices result={result} pick={props.onPickTarget} page={setCursor} /> : null}
    {notice ? <p role="alert">{notice}</p> : null}
  </>
}
function BrowserTargetChoices({ result, pick, page }: {
  result: Extract<BrowserTargetResult, { kind: 'choose_target' }>
  pick(runId: string, workflowVersionId: string, executionId?: string, waitingActivationId?: string): void
  page(cursor: string): void
}) {
  const selected = result.selection
  if (selected.kind !== 'run_selection_required' && selected.kind !== 'selection_required') return <p>No active browser target is available for this selection.</p>
  return <section aria-label="Choose browser target"><p>Choose which attempt’s browser to show.</p>
    {selected.kind === 'run_selection_required' ? selected.items.map(item => <Button key={item.runId}
      onClick={() => pick(item.runId, item.workflowVersionId)}>Run {item.runId}</Button>)
      : selected.items.map(item => {
        const target = item.target
        return <Button key={JSON.stringify(target)} onClick={() => target.kind === 'workflow_execution'
          ? pick(target.execution.runId, item.workflowVersionId, target.execution.executionId)
          : pick(target.runId, item.workflowVersionId, undefined, target.waitingActivationId)}>
          {item.agent.displayName} · {target.kind === 'workflow_execution' ? `attempt ${target.execution.attempt}` : 'coordinator'}
          {item.state === 'idle' ? '' : ` · ${item.state}`}</Button>
      })}
    {selected.hasMore && selected.nextCursor ? <Button onClick={() => page(selected.nextCursor!)}>More browser targets</Button> : null}
  </section>
}

/** A browser that closed with its finished work is not an error worth raw server wording. */
function browserTargetError(error: Error) {
  const revoked = (ApiError.is(error) && error.code === 'AUTH_REVOKED') || /no longer owns the coordinator mailbox/.test(error.message)
  return revoked ? 'This browser closed when its work finished.' : error.message
}
