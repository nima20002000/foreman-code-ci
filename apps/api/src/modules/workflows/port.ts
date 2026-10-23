import type { WorkflowVersionCurrent } from '@foreman-code/contracts/current'

export interface ImmutableWorkflowVersionReader {
  getSavedVersion(workflowVersionId: string): Promise<WorkflowVersionCurrent | undefined>
  getCurrentSavedVersion(workspaceId: string, workflowId: string): Promise<WorkflowVersionCurrent | undefined>
}
