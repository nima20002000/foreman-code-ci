import type { WorkflowDefinitionCurrent, WorkflowVersionCurrent } from '@foreman-code/contracts/current'

/** Agent-only fixtures reject Jobs rather than manufacturing Agent identities. */
export function agentWorkflowNode(node: WorkflowDefinitionCurrent['nodes'][number] | undefined) {
  if (!node || node.kind === 'job') throw new Error('Agent fixture requires an Agent workflow node')
  return node
}

export function agentWorkflowVersion(version: WorkflowVersionCurrent) {
  return { ...version, definition: { ...version.definition, nodes: version.definition.nodes.map(agentWorkflowNode) } }
}
