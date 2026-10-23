import type { JobInitiatingAgent } from '@foreman-code/contracts/jobs'
import type { ManagementAction, ManagementPrincipal } from '@foreman-code/contracts/management'

export const CI_RUN_ACTIONS: ManagementAction[] = ['ci']
export const CI_GET_ACTIONS: ManagementAction[] = ['jobs:read', 'job_logs:read', 'job_artifacts:read']
export const CI_PREPARATION_ACTIONS: ManagementAction[] = [
  'job_definitions:read', 'job_definitions:write', 'sources:read',
  'source_roots:bind', 'source_roots:read', 'workspace_locations:read', 'jobs:start', 'job_artifacts:read',
]
export interface CiAuthority {
  resolve(caller: ManagementPrincipal, workspaceId: string | undefined, actions: ManagementAction[]):
    Promise<{
      principal: ManagementPrincipal
      workspaceId: string
      executionId?: string | undefined
      initiatingAgent?: JobInitiatingAgent | undefined
    }>
}
