import { useState } from 'react'
import type { AgentIdentity, ExecutionRef, WorkflowHierarchyReadResult } from '@foreman-code/contracts'
import { Button } from '../../shared/ui/nocturne'
import { HierarchyRunStop } from './HierarchyRunStop'

const labels = { active: 'Active', waiting_for_direction: 'Waiting for direction', succeeded: 'Completed',
  failed: 'Failed', canceled: 'Stopped' } as const

export function MasterRunState({ saved, master, onChat, onExecution }: {
  saved: WorkflowHierarchyReadResult; master: AgentIdentity
  onChat(nodeId: string, execution?: ExecutionRef): void
  onExecution(agent: AgentIdentity, execution: ExecutionRef): void
}) {
  const [controlsOpen, setControlsOpen] = useState(false)
  const run = saved.run
  if (!run) return <p>Choose a Run to see team reports and its final answer.</p>
  const coordination = run.coordination, source = coordination?.latestDeliverable?.execution ?? coordination?.sourceExecution
  return <section aria-label="Master Run status">
    <h3>{coordination ? labels[coordination.state] : `Recorded Run state · ${run.state}`}</h3>
    {coordination?.summary ? <p>{coordination.summary}</p> : null}
    {coordination?.state === 'waiting_for_direction' && coordination.direction ? <>
      <p>The Master needs your direction. This Run stays open; sending to its queued execution continues the same work.</p>
      <Button onClick={() => onChat(master.workflowNodeId, coordination.direction!.execution)}>Continue with direction</Button>
    </> : null}
    {source ? <Button onClick={() => onExecution(master, source)}>
      {coordination?.state === 'succeeded' ? 'Read final answer' : 'Read latest deliverable'}</Button> : null}
    {coordination?.state === 'failed' ? <p>The recorded failure is preserved with the Run. Open Run controls or the related execution for details.</p> : null}
    <Button size="sm" variant="ghost" aria-expanded={controlsOpen} onClick={() => setControlsOpen(open => !open)}>
      {controlsOpen ? 'Hide Run controls' : 'Run controls · Stop'}</Button>
    {controlsOpen && saved.workflowVersionId ? <HierarchyRunStop key={run.runId} scope={{ workspaceId: saved.workspaceId, workflowId: saved.workflowId,
      workflowVersionId: saved.workflowVersionId, runId: run.runId, executionSemanticsVersion: 3 }} /> : null}
  </section>
}
