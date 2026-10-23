import { lstat, mkdir } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type pg from 'pg'
import { z } from 'zod'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { WorkspaceRootPolicySchema } from '@foreman-code/contracts/workspace-root-policies'
import { componentLogger } from '../diagnostics/index.js'
import { lockWorkspaceFolders } from './folderLocks.js'
import { WORKSPACE_FOLDER_LIFECYCLE_LOCK } from './projectFolderCleanup.js'
import { requireAuthorization } from '../access/policy.js'
import type { PostgresCommandCoordinator } from '../commands/index.js'
import { DomainError } from '../errors.js'
import { lockActiveWorkspace } from './admission.js'
import { lockAgentConfigurations } from './agentConfiguration.js'
import { assertAgentIdle } from './operatorAgents.js'

type Input = {workspaceId:string;expectedRevision:number;commandId:string}
const RemovedProjectFolderSchema = z.object({ runnerId: z.string(), rootPath: z.string() })
/** Restore's project-folder seam: the local runner and the root-location binding that re-attests a recreated folder. */
export interface RestoredFolderBinding {
  runnerId: string
  rebind(principal: ManagementPrincipal, selection: Record<string, unknown>): Promise<unknown>
}
export class OperatorLifecycleService {
  constructor(private readonly commands: PostgresCommandCoordinator, private readonly folders?: RestoredFolderBinding) {}

  async restoreWorkspace(principal: ManagementPrincipal, input: Input) {
    requireAuthorization(principal,'workspaces:restore',{workspaceId:input.workspaceId})
    // Assigned inside the command's transaction callback.
    let recreated = undefined as { selection?: Record<string, unknown> } | undefined
    const result = await this.commands.execute({principal,source:'mcp',operation:'workspace.restore',commandId:input.commandId,
      targetKey:`workspace:${input.workspaceId}`,payload:input,perform:async(client) => {
        await client.query('select pg_advisory_xact_lock(hashtext($1))',[`admission:workspace:${input.workspaceId}`])
        const rows = await client.query<{revision:string;archived_at:Date|null;removed_project_folder:unknown}>(
          'select revision,archived_at,removed_project_folder from workspaces where id=$1 for update',[input.workspaceId])
        const current = this.check(rows.rows[0],input.expectedRevision)
        if (!current.archived_at) return {id:input.workspaceId,revision:input.expectedRevision,archived:false}
        await client.query('update workspaces set archived_at=null,revision=revision+1 where id=$1',[input.workspaceId])
        if (current.removed_project_folder) recreated = await this.recreateProjectFolder(client, input.workspaceId, current.removed_project_folder)
        return {id:input.workspaceId,revision:input.expectedRevision+1,archived:false}
      }})
    if (recreated?.selection && this.folders) {
      // The recreated folder is a new directory; bind it again so Runs accept it. A failure leaves the folder for
      // the owner to choose again in the workspace location settings.
      await this.folders.rebind(principal, { ...recreated.selection, commandId: `${input.commandId}:folder` }).catch((error: unknown) => {
        componentLogger('lifecycle').warn({ err: error, workspaceId: input.workspaceId }, 'Restored workspace folder needs its location chosen again')
      })
    }
    return result
  }

  /** Recreates the app-created project folder that archiving removed, empty, at its original path. */
  private async recreateProjectFolder(client: pg.PoolClient, workspaceId: string, raw: unknown) {
    const removed = RemovedProjectFolderSchema.safeParse(raw)
    if (!this.folders || !removed.success || removed.data.runnerId !== this.folders.runnerId || !isAbsolute(removed.data.rootPath)) return undefined
    const { runnerId, rootPath } = removed.data
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [WORKSPACE_FOLDER_LIFECYCLE_LOCK])
    await lockWorkspaceFolders(client, [rootPath])
    try { await mkdir(rootPath, { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // Something else now holds that path; it is not this workspace's to own or delete.
      await client.query('update workspaces set removed_project_folder=null where id=$1', [workspaceId])
      return undefined
    }
    const details = await lstat(rootPath, { bigint: true })
    const identity = { device: String(details.dev), inode: String(details.ino) }
    await client.query('update workspaces set created_project_folder=$2::jsonb,removed_project_folder=null where id=$1',
      [workspaceId, JSON.stringify({ runnerId, rootPath, identity })])
    const workspace = (await client.query<{ location_revision: string }>('select location_revision::text from workspaces where id=$1', [workspaceId])).rows[0]
    const policies = (await client.query<{ record: unknown }>(`select p.record from workspace_root_policy_heads h
      join workspace_root_policies p on p.root_policy_id=h.root_policy_id and p.root_policy_revision=h.root_policy_revision
      where h.workspace_id=$1 and p.revoked_at is null`, [workspaceId])).rows
      .map(row => WorkspaceRootPolicySchema.parse(row.record))
      .filter(policy => policy.hostRef.kind === 'main' && policy.canonicalProjectRoot === rootPath)
    if (policies.length !== 1) {
      // A folder without an approved-root binding keeps its location; record the new directory's identity.
      await client.query("update workspaces set execution_location_identity=$2::jsonb where id=$1 and execution_location->>'rootPath'=$3",
        [workspaceId, JSON.stringify(identity), rootPath])
      return {}
    }
    const policy = policies[0]!
    return { selection: { workspaceId, hostRef: policy.hostRef, allowedBaseId: policy.allowedBaseId,
      configurationRevision: policy.configurationRevision, relativePath: policy.relativePath, accessMode: policy.accessMode,
      expectedLocationRevision: Number(workspace!.location_revision), expectedRootPolicyRevision: Number(policy.rootPolicyRevision) } }
  }
  restoreWorkflow(principal: ManagementPrincipal, input: Input & {workflowId:string}) {
    requireAuthorization(principal,'workflows:restore',{workspaceId:input.workspaceId,workflowId:input.workflowId})
    return this.commands.execute({principal,source:'mcp',operation:'workflow.restore',commandId:input.commandId,
      targetKey:`workflow:${input.workflowId}`,payload:input,perform:async(client) => {
        await lockActiveWorkspace(client,input.workspaceId)
        const rows = await client.query<{revision:string;archived_at:Date|null}>('select revision,archived_at from workflows where workspace_id=$1 and id=$2 for update',[input.workspaceId,input.workflowId])
        const current = this.check(rows.rows[0],input.expectedRevision)
        if (!current.archived_at) return {id:input.workflowId,revision:input.expectedRevision,archived:false}
        await client.query('update workflows set archived_at=null,revision=revision+1 where workspace_id=$1 and id=$2',[input.workspaceId,input.workflowId])
        return {id:input.workflowId,revision:input.expectedRevision+1,archived:false}
      }})
  }
  agent(principal: ManagementPrincipal, input: Input & {agentId:string}, archived: boolean) {
    requireAuthorization(principal,archived?'agents:archive':'agents:restore',{workspaceId:input.workspaceId})
    return this.commands.execute({principal,source:'mcp',operation:archived?'agent.archive':'agent.restore',commandId:input.commandId,
      targetKey:`workspace:${input.workspaceId}:agent:${input.agentId}`,payload:input,perform:async(client) => {
        await lockActiveWorkspace(client,input.workspaceId)
        await lockAgentConfigurations(client,[input.agentId])
        const rows = await client.query<{revision:string;archived_at:Date|null}>(
          'select metadata_revision as revision,archived_at from agents where workspace_id=$1 and id=$2 for update',[input.workspaceId,input.agentId],
        )
        const current = this.check(rows.rows[0],input.expectedRevision)
        if (Boolean(current.archived_at) === archived) return {id:input.agentId,revision:input.expectedRevision,archived}
        await assertAgentIdle(client,input.workspaceId,input.agentId)
        if (archived) {
          const referenced = await client.query(
            `select id from workflows where workspace_id=$1 and (exists(select 1 from jsonb_array_elements(record->'nodes') n where n->>'agentId'=$2)
               or exists(select 1 from workflow_versions v where v.id=workflows.current_version_id and v.record->'agentConfigurationVersionIds' ? $2))
             union all select id from graph_drafts where workspace_id=$1 and discarded_at is null and
               exists(select 1 from jsonb_array_elements(record->'graph'->'nodes') n where n->>'agentId'=$2)
             limit 1`,[input.workspaceId,input.agentId],
          )
          if (referenced.rows.length) throw new DomainError('AGENT_STILL_REFERENCED','Remove the Agent from saved workflows and active drafts before archiving it. Historical versions are retained.',409)
        }
        await client.query('update agents set archived_at=case when $3 then now() else null end,metadata_revision=metadata_revision+1 where workspace_id=$1 and id=$2',[input.workspaceId,input.agentId,archived])
        return {id:input.agentId,revision:input.expectedRevision+1,archived}
      }})
  }
  private check<T extends {revision:string;archived_at:Date|null}>(row:T|undefined,revision:number): T {
    if (!row) throw new DomainError('RESOURCE_NOT_FOUND','The resource was not found.',404)
    if (Number(row.revision)!==revision) throw new DomainError('REVISION_CONFLICT','The resource changed since it was read.',409)
    return row
  }
}
