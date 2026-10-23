import type { WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'

/** Each saved delegate route with the direct child it reaches, so an Agent can pick a child by name. */
export function hierarchyChildRoutesPrompt(definition: WorkflowDefinitionV3, nodeId: string): string {
  const node = definition.nodes.find(candidate => candidate.id === nodeId)
  const routes = node && node.kind !== 'job' ? (node.choice?.outcomes ?? []).flatMap(choice => {
    if (choice.target.kind !== 'edge') return []
    const relationshipId = choice.target.relationshipId
    const edge = definition.edges.find(item => item.id === relationshipId && item.kind === 'execution' && item.source === nodeId)
    const child = edge && definition.hierarchy?.parents.some(member => member.parentNodeId === nodeId && member.workflowNodeId === edge.target)
      ? definition.nodes.find(item => item.id === edge.target) : undefined
    return child ? [`${JSON.stringify(choice.outcome)} → ${child.kind === 'job' ? child.id : child.name ?? child.label ?? child.id}`] : []
  }) : []
  return routes.length
    ? `Your direct children, by saved route outcome (copy the outcome string exactly): ${routes.join('; ')}.`
    : 'You have no direct children to delegate to.'
}

/** The saved hierarchy's handoff contract is independent of the result-protocol cutover. */
export function hierarchyWorkPrompt(definition: WorkflowDefinitionV3, nodeId: string): string {
  const node = definition.nodes.find(candidate => candidate.id === nodeId)
  if (!definition.hierarchy || !node || node.kind === 'job') throw new Error('HIERARCHY_AGENT_REQUIRED')
  const outcomes = node.choice?.outcomes.map(choice => choice.outcome) ?? []
  return [
    'Return one complete JSON object with routing, data, and summary, within 65536 UTF-8 bytes.',
    'data has latestDeliverable (your non-null business deliverable, including all results and facts you found) and remainingFindings (unresolved problems that still need work; [] when your task is done).',
    'summary is a nonempty string of at most 600 characters.',
    `Saved work routes: ${JSON.stringify(outcomes)}.`,
    'Delegate to selected direct children with {"kind":"delegate","requests":[{"outcome":<saved direct-child route>,"data":<the child task>}]} in routing.',
    hierarchyChildRoutesPrompt(definition, nodeId),
    'Each child may be selected once. Your reserved continuation receives all selected children\'s deliverables and findings after they settle.',
    'For a single saved work handoff use {"kind":"request","outcome":<saved route>}.',
    'Answer your actual caller with {"kind":"return","requestId":<received request ID>,"outcome":"accepted" or "needs_changes"}.',
    'A return starts no children and ends your part; when your task needs your children, delegate first and return only from the continuation that receives their results.',
    'Only the Master may finish the workflow with {"kind":"finish"}, after every child obligation settles. Finish never starts unselected children.',
    'Master finish with remaining findings waits for explicit user direction in this same Run.',
    ...(node.artifactOutputs ? [`Also include artifactOutputs with the original publication command IDs for these keys: ${JSON.stringify(node.artifactOutputs.outputKeys)}.`] : []),
    ...(node.outputSchema ? [`latestDeliverable must satisfy this JSON Schema: ${JSON.stringify(node.outputSchema)}.`] : []),
  ].join('\n')
}
