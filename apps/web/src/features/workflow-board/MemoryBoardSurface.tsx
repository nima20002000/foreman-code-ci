import { useCallback, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { type MemoryBoardScope, type MemoryCardWorkBinding } from '@foreman-code/contracts'
import { MemoryBoard, MemoryBoardDialog, createMemoryBoardClient, type MemoryBoardInteraction, type MemoryFilters } from '../memory-boards'
import { useLocalHumanAccessQuery } from '../../shared/api/settingsExperience'
import { useManagedWorkflowQuery } from '../../shared/api/query'
import { Button } from '../../shared/ui/nocturne'
import { useMemoryNodes } from './useMemoryNodes'
import { canUseBoardAction } from './permissions'

const client = createMemoryBoardClient()

export function MemoryBoardSurface({ scope, scopeName, dialog }: {
  scope: MemoryBoardScope
  scopeName: string
  dialog?: { open: boolean; onOpenChange(open: boolean): void; historicalRun: boolean }
}) {
  const navigate = useNavigate()
  const [leaving, setLeaving] = useState(false)
  const interaction = useRef<MemoryBoardInteraction | undefined>(undefined)
  const changed = useCallback((next: MemoryBoardInteraction | undefined) => { interaction.current = next }, [])
  const modal = Boolean(dialog)
  const leave = useCallback((proceed: () => void) => {
    const afterClose = () => {
      if (modal) flushSync(() => setLeaving(true))
      proceed()
    }
    if (interaction.current) interaction.current.requestLeave(afterClose)
    else afterClose()
  }, [modal])
  const search = useLocation().search
  const access = useLocalHumanAccessQuery()
  const principal = access.isError ? undefined : access.data?.principal
  const workflowId = scope.kind === 'workflow' ? scope.workflowId : ''
  const workflow = useManagedWorkflowQuery(scope.workspaceId, workflowId, scope.kind === 'workflow')
  const destination = scope.kind === 'workspace' ? '/workspaces/$workspaceId/memory' : '/workspaces/$workspaceId'
  const selected = useCallback((memoryCard: string | undefined) => {
    void navigate({ to: destination, params: { workspaceId: scope.workspaceId }, replace: true, search: previous => ({ ...previous, memoryCard }) })
  }, [navigate, destination, scope.workspaceId])
  const filtersChanged = useCallback((filters: MemoryFilters) => {
    void navigate({ to: destination, params: { workspaceId: scope.workspaceId }, replace: true, search: previous => ({ ...previous,
      memoryQuery: filters.query || undefined, memoryStatus: filters.status,
      memoryDone: filters.doneOpen || undefined, memoryCompletion: filters.completionKind,
    }) })
  }, [navigate, destination, scope.workspaceId])
  const openWork = useCallback((binding: MemoryCardWorkBinding) => {
    leave(() => { void navigate({ to: '/workspaces/$workspaceId', params: { workspaceId: binding.node.workspaceId }, search: {
      workflowId: binding.node.workflowId, selectedRunId: binding.work.runId, boardPanel: 'agent',
      boardNodeId: binding.node.workflowNodeId, boardAgentTab: 'details',
      ...(binding.currentExecutionId ? { boardExecutionId: binding.currentExecutionId } : {}),
    } }) })
  }, [navigate, leave])
  const nodeOptions = useMemoryNodes(scope)
  const canWrite = Boolean(principal && Date.parse(principal.expiresAt) > Date.now()
    && canUseBoardAction(principal.grants, scope.kind === 'workspace' ? 'workspaces:update' : 'workflows:update',
      { workspaceId: scope.workspaceId, workflowId }))
  const notice = nodeOptions.error ? <p role="alert">Linked nodes and current work could not be read.
    <Button size="sm" onClick={nodeOptions.retry}>Retry linked work options</Button></p> : null
  const props = { workOptionsNotice: notice, client, scope, scopeName: workflow.data?.workflow.name ?? scopeName, nodes: nodeOptions.error ? [] : nodeOptions.data ?? [], canWrite,
    filters: { query: search.memoryQuery ?? '', doneOpen: search.memoryDone ?? false,
      ...(search.memoryStatus ? { status: search.memoryStatus } : {}),
      ...(search.memoryCompletion ? { completionKind: search.memoryCompletion } : {}) },
    ...(search.memoryCard ? { selectedCardId: search.memoryCard } : {}),
    onSelectCard: selected, onFiltersChange: filtersChanged, onOpenWork: openWork, onInteractionChange: changed,
  }
  return dialog ? <MemoryBoardDialog {...props} {...dialog} open={dialog.open && !leaving} /> : <MemoryBoard {...props} />
}
