import { useQuery } from '@tanstack/react-query'
import type { WorkflowDefinitionCurrent } from '@foreman-code/contracts/current'
import { Button } from '../../shared/ui/nocturne'
import { useWorkflowBoard } from '../board-core'
import { JsonValue, readPinnedAgentVersion, runInspectionQueryKey } from '../workflow-board'
import type { AvailableRunBoardSnapshot } from './model'

export function SavedAgentSettings({ snapshot, definition, nodeId }: {
  snapshot: AvailableRunBoardSnapshot; definition?: WorkflowDefinitionCurrent; nodeId: string
}) {
  const board = useWorkflowBoard()
  const node = snapshot.nodes.find(item => item.id === nodeId)
  const savedNode = definition?.nodes.find(item => item.id === nodeId)
  const agent = node && node.kind !== 'job' ? node : undefined
  const scope = { workspaceId: snapshot.workspaceId, workflowId: snapshot.workflowId, runId: snapshot.runId,
    workflowVersionId: snapshot.workflowVersionId, executionSemanticsVersion: 3 as const }
  const configuration = useQuery({
    queryKey: [...runInspectionQueryKey(scope), 'agent-configuration', agent?.agentId, agent?.agentConfigurationVersionId],
    enabled: !!agent,
    queryFn: ({ signal }) => readPinnedAgentVersion(snapshot.workspaceId, agent!.agentId, agent!.agentConfigurationVersionId, { signal }),
    staleTime: Infinity,
  })
  return <section aria-label="Saved Agent settings"><h3>{node?.name ?? nodeId}</h3>
    <p>This Run keeps its saved Agent configuration. Edits to the current workflow apply to future Runs.</p>
    {savedNode ? <JsonValue label="Saved node settings" value={savedNode} /> : <p>Saved node settings unavailable.</p>}
    {agent ? configuration.isError ? <p role="status">Saved Agent configuration unavailable. <Button size="sm"
      onClick={() => void configuration.refetch()}>Retry configuration</Button></p>
      : configuration.data ? <JsonValue label="Saved Agent configuration" value={configuration.data} />
        : <p role="status">Loading saved Agent configuration…</p> : null}
    <Button size="sm" onClick={() => board?.selectRun()}>Edit current workflow</Button>
  </section>
}
