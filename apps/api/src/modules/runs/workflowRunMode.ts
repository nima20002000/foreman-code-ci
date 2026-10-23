import type { WorkflowVersionCurrent } from '@foreman-code/contracts/current'

/**
 * How a Run's saved workflow executes. `handoff` and `hierarchy` run the work-handoff graph; `graph` runs the
 * ordinary workflow graph. Only a workflow that declares explicit finite repeat blocks uses repeat.
 */
export type WorkflowRunMode = 'graph' | 'handoff' | 'hierarchy'

export function workflowRunMode(version: WorkflowVersionCurrent): WorkflowRunMode {
  if (!version.definition.handoffs) return 'graph'
  return version.definition.hierarchy ? 'hierarchy' : 'handoff'
}

/** True for the handoff and hierarchy modes, which share the work-handoff graph and its activations. */
export function usesWorkHandoffGraph(version: WorkflowVersionCurrent): boolean {
  return workflowRunMode(version) !== 'graph'
}

/** True only when the workflow declares explicit finite repeat blocks. */
export function declaresRepeatBlocks(version: WorkflowVersionCurrent): boolean {
  return version.definition.repeat !== undefined
}
