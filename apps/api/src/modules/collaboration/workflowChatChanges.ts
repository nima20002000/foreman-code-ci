import type pg from 'pg'
import { WorkflowExecutionChatChangeSchema } from '@foreman-code/contracts'
import type { Principal } from './ports.js'
import { controlDigest, workflowTargetRunId } from './workflowControlRecords.js'
import { readWorkflowChatIdentity } from './workflowChatIdentity.js'
import { withWorkflowChatRead } from './workflowChatRead.js'
import type { WorkflowChatOwnerPort, WorkflowChatTarget } from './workflowControlTypes.js'

export async function readWorkflowChatChanges(pool: pg.Pool, owner: WorkflowChatOwnerPort,
  principal: Principal, target: WorkflowChatTarget) {
  return withWorkflowChatRead(pool, principal, target, 'agent_chat:read', async sql => {
    const identity = await readWorkflowChatIdentity(sql, target)
    const kind = target.kind === 'workflow_execution' ? 'execution' : 'consultation'
    const scopeId = target.kind === 'workflow_execution' ? target.execution.executionId : target.waitingActivationId
    // Sum item revisions because consultation sources have independent native sequences.
    const native = (await sql.query<{ revision: string }>(`select coalesce(sum(revision),0)::text as revision
      from workflow_native_chat_items where kind=$1 and run_id=$2 and scope_id=$3`,
    [kind, workflowTargetRunId(target), scopeId])).rows[0]!
    const commands = (await sql.query<{ revision: string }>(`select coalesce(sum(revision),0)::text as revision
      from run_chat_commands where run_id=$1 and target_key=$2`,
    [workflowTargetRunId(target), controlDigest(target)])).rows[0]!
    const observation = await owner.observe(target)
    return WorkflowExecutionChatChangeSchema.parse({ target, snapshotRequired: true,
      revision: Number(native.revision) + Number(commands.revision),
      cursor: controlDigest({ target, state: identity.state, native, commands, observation }) })
  })
}
