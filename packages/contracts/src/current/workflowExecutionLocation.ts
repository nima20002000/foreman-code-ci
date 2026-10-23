import type { WorkflowDefinitionCurrent } from './workflowShape.js'

export function workflowUsesAgentPlacements(definition: WorkflowDefinitionCurrent): boolean {
  return Boolean(definition.defaultWorktree)
    || definition.nodes.some(node => node.kind !== 'job' && Boolean(node.placement || node.worktree || node.artifactOutputs))
}

/** Jobs execute in the workspace directory; placed Agents use their accepted roots. */
export function workflowRequiresWorkspaceDirectory(definition: WorkflowDefinitionCurrent): boolean {
  return definition.nodes.some(node => node.kind === 'job') || !workflowUsesAgentPlacements(definition)
}
