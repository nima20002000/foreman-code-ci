import { useEffect, useMemo, useRef, useState } from 'react'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { BrowserOperationResponseSchemas, type AgentSubject, type BrowserSession } from '@foreman-code/contracts'
import { BrowserSidebar, type BrowserSidebarStatus, type BrowserSidebarTab } from '../features/agent-browser/BrowserSidebar'
import { useBrowserSidebar, useBrowserSidebarTabs } from '../features/workflow-board/useBrowserSidebar'
import { useWorkflowBoard } from '../features/workflow-board/context'
import { apiClient, ApiError } from '../shared/api/client'
import { useManagedWorkflowQuery } from '../shared/api/query'
import { errorMessage } from '../shared/errorMessage'
import { browserSessionClient } from './browserRecovery'
import { browserAuthBoundary, useBrowserComputers } from './browserComputerFacts'
import { WorkflowBrowserTarget } from './WorkflowBrowser'

export interface WorkflowBrowserSidebarProps { workspaceId: string; workflowId: string; runId?: string; workflowVersionId?: string }

const POLL_MS = 3000
/** A browser whose page, tabs or state changed within this window counts as working. */
const WORKING_MS = 20_000
const live = (session: BrowserSession) => session.state !== 'closed' && session.state !== 'failed'
const runOf = (subject: AgentSubject) => subject.kind === 'execution' ? subject.execution.runId
  : subject.kind === 'coordinator_consultation' ? subject.binding.runId : undefined

/** Every live browser session this person can see, read per online computer so one offline computer hides nothing else. */
function useLiveBrowserSessions() {
  const facts = useBrowserComputers()
  const computers = facts.computers.filter(computer => computer.online).map(computer => computer.id).sort()
  return useQuery({ queryKey: ['browser-sidebar', browserAuthBoundary(), 'sessions', computers], enabled: computers.length > 0,
    refetchInterval: POLL_MS, refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      const sessions: BrowserSession[] = [], unreachable: string[] = []
      await Promise.all(computers.map(async computerId => {
        try {
          let cursor: string | null = null
          for (let page = 0; page < 20; page++) {
            const input: { computerId: string; limit: number; live: true; cursor?: string } = { computerId, limit: 100, live: true, ...(cursor ? { cursor } : {}) }
            const result: { sessions: BrowserSession[]; nextCursor: string | null } = await apiClient.request(`/api/browser/sessions?${new URLSearchParams({ input: JSON.stringify(input) })}`,
              BrowserOperationResponseSchemas.browser_sessions_list, { signal })
            sessions.push(...result.sessions.filter(live))
            cursor = result.nextCursor
            if (!cursor) break
          }
        } catch (error) {
          // Only an offline computer is skipped; any other failure keeps the last good list and shows the error.
          if (signal.aborted || !ApiError.is(error) || error.code !== 'BROWSER_COMPUTER_OFFLINE') throw error
          unreachable.push(facts.computers.find(computer => computer.id === computerId)?.name ?? 'A computer')
        }
      }))
      return { sessions, unreachable }
    } })
}

type Activity = { signature: string; changedAt: number; page?: string }
/** Working or idle comes from whether the Agent's browser actually changed recently. */
function useBrowserActivity(sessions: readonly BrowserSession[]) {
  const queryClient = useQueryClient()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 5000); return () => clearInterval(timer) }, [])
  const reads = useQueries({ queries: sessions.map(session => {
    const queryKey = ['browser-sidebar', browserAuthBoundary(), 'activity', session.id] as const
    return { queryKey, refetchInterval: POLL_MS, refetchOnWindowFocus: false, retry: false,
      queryFn: async ({ signal }: { signal: AbortSignal }): Promise<Activity> => {
        const read = await browserSessionClient.readSession(session.id, signal)
        const selected = read.tabs.find(tab => tab.tabId === read.session.selectedTabId)
        const signature = JSON.stringify([read.session.state, read.session.browserGeneration, read.session.selectedTabId,
          read.tabs.map(tab => [tab.tabId, tab.url, tab.title])])
        const previous = queryClient.getQueryData<Activity>(queryKey)
        const page = selected ? selected.title || selected.url : undefined
        // The first read is a baseline, not activity: a browser that has sat still reads as idle.
        return { signature, page, changedAt: !previous ? 0 : previous.signature === signature ? previous.changedAt : Date.now() }
      } }
  }) })
  return new Map(sessions.map((session, index) => {
    const activity = reads[index]?.data
    const status: BrowserSidebarStatus = session.state === 'starting' || session.state === 'recovering'
      || (activity && now - activity.changedAt < WORKING_MS) ? 'working' : 'idle'
    return [session.id, { status, page: activity?.page }] as const
  }))
}

/** The Board's right-hand browser sidebar: every live Agent browser in this workflow's selected Run, one tab per Agent. */
export function WorkflowBrowserSidebar({ workspaceId, workflowId, runId, workflowVersionId }: WorkflowBrowserSidebarProps) {
  const sidebar = useBrowserSidebar(workspaceId, workflowId)
  const board = useWorkflowBoard()
  const workflow = useManagedWorkflowQuery(workspaceId, workflowId)
  const listed = useLiveBrowserSessions()
  const opened = useBrowserSidebarTabs(state => state.opened[sidebar.scope])
  const closed = useBrowserSidebarTabs(state => state.closed[sidebar.scope])
  // Sessions of this workflow: the selected Run's executions, plus Agent chats, which belong to no Run.
  const sessions = useMemo(() => (listed.data?.sessions ?? []).filter(session => {
    const subject = session.subject
    if (!subject || subject.agent.workspaceId !== workspaceId || subject.agent.workflowId !== workflowId) return false
    const sessionRun = runOf(subject)
    return !runId || !sessionRun || sessionRun === runId
  }), [listed.data, workspaceId, workflowId, runId])
  const byNode = useMemo(() => {
    const groups = new Map<string, BrowserSession[]>()
    for (const session of sessions) {
      const nodeId = session.subject!.agent.workflowNodeId
      groups.set(nodeId, [...groups.get(nodeId) ?? [], session])
    }
    return groups
  }, [sessions])
  const seen = useRef(new Set<string>())
  for (const nodeId of byNode.keys()) seen.current.add(nodeId)
  const primaries = useMemo(() => [...byNode.values()].map(group => group[0]!), [byNode])
  const activity = useBrowserActivity(primaries)
  // A browser that starts shows up as a tab and stays (as Ended) after it closes, until the person closes the tab.
  useEffect(() => {
    for (const nodeId of byNode.keys()) {
      if (opened?.includes(nodeId) || closed?.includes(nodeId)) continue
      useBrowserSidebarTabs.getState().add(sidebar.scope, nodeId)
    }
  }, [byNode, opened, closed, sidebar.scope])
  const nodeName = (nodeId: string) => {
    const node = workflow.data?.workflow.nodes.find(item => item.id === nodeId)
    return byNode.get(nodeId)?.[0]?.subject?.agent.displayName ?? node?.name ?? node?.label ?? 'Agent'
  }
  const ids = [...new Set([...opened ?? [], ...sidebar.selected && !opened?.includes(sidebar.selected) && !closed?.includes(sidebar.selected) ? [sidebar.selected] : []])]
  const tabs: BrowserSidebarTab[] = ids.map(nodeId => {
    const primary = byNode.get(nodeId)?.[0]
    const state = primary ? activity.get(primary.id) : undefined
    return { id: nodeId, name: nodeName(nodeId), status: state?.status ?? (primary ? 'idle' : seen.current.has(nodeId) ? 'ended' : 'not_started'), ...(state?.page ? { page: state.page } : {}) }
  })
  const selectedId = sidebar.selected && ids.includes(sidebar.selected) ? sidebar.selected : ids[0]
  const primary = selectedId ? byNode.get(selectedId)?.[0] : undefined
  const notice = listed.error ? <p className="browser-sidebar-notice" role="alert">{errorMessage(listed.error, 'Agent browsers could not be read.')}</p>
    : listed.data?.unreachable.length ? <p className="browser-sidebar-notice">{listed.data.unreachable.join(', ')} could not be reached; its browsers are not shown.</p>
      : listed.isPending ? <p className="browser-sidebar-notice" role="status">Looking for agent browsers…</p> : null
  return <BrowserSidebar tabs={tabs} selectedId={selectedId} notice={notice}
    emptyText={runId ? 'No agent browsers are active in this run.' : 'No agent browsers are active in this workflow.'}
    onSelect={sidebar.select} onClose={sidebar.close}
    onCloseTab={nodeId => {
      const index = ids.indexOf(nodeId)
      sidebar.closeTab(nodeId, ids[index + 1] ?? ids[index - 1])
    }}>
    {selectedId ? <SidebarBrowser key={`${selectedId}:${primary?.id ?? ''}`} workspaceId={workspaceId} workflowId={workflowId}
      nodeId={selectedId} session={primary} runId={runId} workflowVersionId={workflowVersionId}
      onOpenSettings={() => board?.selectSidePanel?.({ kind: 'agent', nodeId: selectedId, tab: 'settings' })} /> : null}
  </BrowserSidebar>
}

/** The selected tab's browser. A live session pins the exact Agent subject; without one, the node's browser in this Run. */
function SidebarBrowser({ session, runId, workflowVersionId, ...props }: {
  workspaceId: string; workflowId: string; nodeId: string; session?: BrowserSession; runId?: string; workflowVersionId?: string
  onOpenSettings(): void
}) {
  const subject = session?.subject
  const board = useWorkflowBoard()
  // A node not saved in the workflow yet finds its chat's browser through its Agent.
  const agentId = subject?.agent.agentId ?? board?.draftNodeAgentId?.(props.nodeId)
  const [picked, setPicked] = useState<{ runId: string; workflowVersionId: string; executionId?: string; waitingActivationId?: string }>()
  const [view, setView] = useState<{ sessionId?: string; tabId?: string }>({ sessionId: session?.id })
  const target = picked ?? (subject?.kind === 'execution' ? { runId: subject.execution.runId, workflowVersionId: subject.execution.workflowVersionId,
    executionId: subject.execution.executionId }
    : subject?.kind === 'coordinator_consultation' ? { runId: subject.binding.runId, workflowVersionId: subject.binding.workflowVersionId,
      waitingActivationId: subject.binding.waitingActivationId }
      : subject?.kind === 'conversation' ? {} : runId && workflowVersionId ? { runId, workflowVersionId } : {})
  return <WorkflowBrowserTarget key={JSON.stringify(target)} {...props} {...target} {...(agentId ? { agentId } : {})} compact
    {...(view.sessionId ? { sessionId: view.sessionId } : {})} {...(view.tabId ? { tabId: view.tabId } : {})}
    onSelect={(sessionId, tabId) => setView({ sessionId, tabId })}
    onPickTarget={(pickedRun, pickedVersion, executionId, waitingActivationId) => {
      setView({}); setPicked({ runId: pickedRun, workflowVersionId: pickedVersion, executionId, waitingActivationId })
    }} />
}
