import { useQuery } from '@tanstack/react-query'
import type { MemoryBoardScope } from '@foreman-code/contracts'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { useWorkspaceDetailsQuery } from '../../shared/api/query'
import { readRunExecutions } from './runDetailsClient'
import { readBoardRun, scopeForBoardRun } from './client'
import type { MemoryNodeOption } from '../memory-boards'

/** The workspace's live Run summaries discover work; exact execution reads retain its logical obligation identity. */
export function useMemoryNodes(scope: MemoryBoardScope) {
  const workspace = useWorkspaceDetailsQuery(scope.workspaceId, { refetchInterval: 5000 })
  const active = workspace.data?.runs.filter(run => run.executionState !== 'completed'
    && (scope.kind === 'workspace' || run.workflowId === scope.workflowId)) ?? []
  const runs = active.map(run => run.id).sort()
  const workflows = workspace.data?.workflows.filter(workflow => scope.kind === 'workspace' || workflow.id === scope.workflowId) ?? []
  const query = useQuery({ queryKey: ['memory-nodes', sessionGeneration(), scope, runs, workflows.map(workflow => [workflow.id, workflow.version])], enabled: workspace.isSuccess,
    refetchInterval: 5000,
    queryFn: async ({ signal }) => {
      const nodes: MemoryNodeOption[] = workflows.flatMap(workflow => workflow.nodes.flatMap(node => node.kind === 'job' ? [] : [{
        node: { workspaceId: scope.workspaceId, workflowId: workflow.id, workflowNodeId: node.id, agentId: node.agentId },
        label: node.name ?? node.label ?? node.id, available: true, currentWork: [],
      }]))
      await Promise.all(active.map(async run => {
        const detail = await readBoardRun(scope.workspaceId, run.workflowId, run.id, { signal })
        const runScope = scopeForBoardRun(detail.run)
        let cursor: string | null = null
        do {
          const page = await readRunExecutions(runScope, {}, cursor, { signal })
          for (const execution of page.items) {
            // A finished native attempt can still have an obligation awaiting acceptance or child work.
            if (execution.kind === 'job' || !execution.logicalWork) continue
            const node = nodes.find(option => option.node.workflowId === run.workflowId
              && option.node.workflowNodeId === execution.workflowNodeId && option.node.agentId === execution.agentId)
            const work = execution.logicalWork
            const id = work.kind === 'activation' ? work.activationId : work.slotId
            if (node && !node.currentWork.some(current => current.work.runId === work.runId && current.work.kind === work.kind
              && (current.work.kind === 'activation' ? current.work.activationId : current.work.slotId) === id)) {
              node.currentWork.push({ work, label: `${node.label} · Run ${run.id} · ${work.kind} ${id} · attempt ${execution.attempt} (${execution.state})` })
            }
          }
          cursor = page.pageInfo.nextCursor
        } while (cursor)
      }))
      return nodes
    } })
  return { ...query, error: workspace.error ?? query.error, retry: () => { void workspace.refetch(); void query.refetch() } }
}
