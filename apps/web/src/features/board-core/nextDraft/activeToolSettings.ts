import { activeForemanToolOverride } from '@foreman-code/contracts'
import type { WorkflowDefinitionCurrent } from '@foreman-code/contracts/current'

/** New authoring commands use the active catalog; recorded graph metadata stays untouched. */
export function activeWorkflowNode(node: WorkflowDefinitionCurrent['nodes'][number]) {
  if (node.kind === 'job') return node
  const { graphqlTools, ...content } = node
  const override = activeForemanToolOverride(graphqlTools)
  return { ...content, ...(override ? { graphqlTools: override } : {}) }
}

export function activeWorkflowGraph(graph: WorkflowDefinitionCurrent) {
  return { ...graph, nodes: graph.nodes.map(activeWorkflowNode) }
}
