import { useInfiniteQuery, useQuery, type InfiniteData, type QueryClient } from '@tanstack/react-query'
import type { WorkflowHierarchyReadInput, WorkflowReportsPage } from '@foreman-code/contracts'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { readHierarchy, readHierarchyReports } from './client'

export const hierarchyKey = (scope: WorkflowHierarchyReadInput) =>
  ['workflow-hierarchy', sessionGeneration(), scope.workspaceId, scope.workflowId, scope.runId ?? null, scope.workflowVersionId ?? null] as const
export const hierarchyReportKey = (scope: WorkflowHierarchyReadInput) => [...hierarchyKey(scope), 'reports', 'children'] as const
/** Lifecycle notifications refresh one bounded page per visible branch, never its loaded history. */
export function refreshHierarchyReports(cache: QueryClient, scope: WorkflowHierarchyReadInput) {
  const queryKey = hierarchyReportKey(scope)
  cache.setQueriesData<InfiniteData<WorkflowReportsPage>>({ queryKey }, current => current && ({
    pages: current.pages.slice(0, 1), pageParams: current.pageParams.slice(0, 1),
  }))
  return cache.invalidateQueries({ queryKey })
}

/** Explicit node history owns an immutable cursor window, separate from live child summaries. */
export function useHierarchyReportHistory(scope: WorkflowHierarchyReadInput, workflowNodeId: string, { enabled = true } = {}) {
  return useInfiniteQuery({ queryKey: [...hierarchyKey(scope), 'report-history', workflowNodeId], enabled: enabled && !!scope.runId,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => readHierarchyReports({ workspaceId: scope.workspaceId,
      workflowId: scope.workflowId, runId: scope.runId!, workflowNodeId, limit: 20,
      ...(pageParam ? { cursor: pageParam } : {}) }, { signal }),
    getNextPageParam: (page, _pages, _param, params) => page.nextCursor && !params.includes(page.nextCursor) ? page.nextCursor : undefined,
    retry: false, staleTime: Infinity, refetchOnWindowFocus: false, refetchOnReconnect: false,
    refetchOnMount: false, maxPages: 20,
  })
}
export function useHierarchy(scope: WorkflowHierarchyReadInput, { enabled = true } = {}) {
  return useQuery({ queryKey: hierarchyKey(scope), enabled, queryFn: ({ signal }) => readHierarchy(scope, { signal }),
    retry: false, staleTime: Infinity, refetchOnMount: 'always', refetchOnWindowFocus: false })
}
export function useHierarchyReports(scope: WorkflowHierarchyReadInput, parentNodeId: string, enabled: boolean) {
  return useInfiniteQuery({ queryKey: [...hierarchyReportKey(scope), parentNodeId], enabled: enabled && !!scope.runId,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ signal, pageParam }) => readHierarchyReports({ workspaceId: scope.workspaceId,
      workflowId: scope.workflowId, runId: scope.runId!, parentNodeId, limit: 50, ...(pageParam ? { cursor: pageParam } : {}) }, { signal }),
    getNextPageParam: page => page.nextCursor ?? undefined, retry: false, staleTime: Infinity,
    refetchOnWindowFocus: false, refetchOnMount: 'always', maxPages: 20,
  })
}
