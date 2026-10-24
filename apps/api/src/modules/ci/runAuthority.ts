import type pg from 'pg'
import { withTransaction } from '../../infrastructure/transaction.js'
import type { JobInitiatingAgent } from '@foreman-code/contracts/jobs'
import type { ManagementAction, ManagementPrincipal } from '@foreman-code/contracts/management'
import { currentOperatorAuthority } from '../access/index.js'
import { intersectGrants } from '../access/index.js'
import { requireAuthorization } from '../access/index.js'
import { workerScopesForAction } from '../access/index.js'
import { assertCurrentWorkerBinding } from '../interactions/index.js'
import { DomainError, retryDatabaseRead } from '../errors.js'
import type { CiAuthority } from './authority.js'

export class RunCiAuthority implements CiAuthority {
  constructor(private readonly pool: pg.Pool) {}

  async resolve(caller: ManagementPrincipal, requestedWorkspace: string | undefined, actions: ManagementAction[]) {
    // Only reads: the binding is verified from one committed snapshot and no row lock outlives this COMMIT, so
    // CI calls never queue behind the Run owner. A CI ticket is admitted later in its own transaction.
    return retryDatabaseRead(() => withTransaction(this.pool, async (sql) => {
      let principalId = caller.id
      let workspaceId = requestedWorkspace
      let executionId: string | undefined
      let initiatingAgent: JobInitiatingAgent | undefined
      if (caller.audience === 'worker') {
        await assertCurrentWorkerBinding(sql, caller.id)
        const binding = (await sql.query<{ workspace_id: string; workflow_id: string; run_id: string;
          authorization_principal_id: string; execution_id: string | null }>(`select b.workspace_id,b.workflow_id,b.run_id,b.execution_id,
            r.record->>'authorizationPrincipalId' as authorization_principal_id
          from worker_credential_bindings b join runs r on r.id=b.run_id and r.workspace_id=b.workspace_id
          join run_authority_principals a on a.run_id=r.id and a.principal_id=r.record->>'authorizationPrincipalId'
          where b.principal_id=$1 and b.agent_id=$2 and b.purpose='workflow' and b.revoked_at is null`,
        [caller.id, caller.agentId])).rows[0]
        const scoped = binding && workerScopesForAction(caller, 'interactions:read').some(scope =>
          scope.workspaceIds?.includes(binding.workspace_id) && scope.workflowIds?.includes(binding.workflow_id)
          && scope.runIds?.includes(binding.run_id))
        if (!binding || !scoped || workspaceId && workspaceId !== binding.workspace_id) {
          throw new DomainError('ACCESS_DENIED', 'CI is limited to this Agent’s active Run workspace.', 403)
        }
        workspaceId = binding.workspace_id
        principalId = binding.authorization_principal_id
        executionId = binding.execution_id ?? undefined
        if (executionId) initiatingAgent = {
          workflowId: binding.workflow_id,
          runId: binding.run_id,
          agentId: caller.agentId!,
          executionId,
        }
      }
      if (!workspaceId) throw new DomainError('INVALID_REQUEST', 'Operator CI requires workspaceId.', 400)
      const accepted = (await currentOperatorAuthority(sql, principalId)).principal
      const grants = caller.audience === 'operator' ? intersectGrants(caller.grants, accepted.grants) : accepted.grants
      const principal = { ...accepted, grants: intersectGrants(grants, [{
        actions,
        scope: { workspaceIds: [workspaceId] },
      }]), expiresAt: caller.audience === 'operator'
        ? new Date(Math.min(Date.parse(caller.expiresAt), Date.parse(accepted.expiresAt))).toISOString()
        : accepted.expiresAt }
      for (const action of actions) requireAuthorization(principal, action, { workspaceId })
      return { principal, workspaceId, executionId, initiatingAgent }
    }, { isolation: 'repeatable read', readOnly: true }))
  }
}
