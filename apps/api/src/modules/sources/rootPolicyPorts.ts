import type { SqlQuery } from '../../infrastructure/transaction.js'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { ApprovedRootAllowlist, WorkspaceRootSelection, WorkspaceRootPolicy, WorkspaceRootAttestation, WorkspaceRootBrowseResult } from '@foreman-code/contracts/workspace-root-policies'
export interface AuthorizedWorkspaceRoot {
  selection: WorkspaceRootSelection; allowlist: ApprovedRootAllowlist; ownerPrincipalId: string
  registration: WorkspaceRootPolicy['registration']
}
/** C supplies existing commands/HTTP/MCP around this one generic root authority. */
export interface WorkspaceRootPolicyPort {
  adopt?(sql: SqlQuery, principal: ManagementPrincipal, workspaceId: string, host: ApprovedRootAllowlist['hostRef']): Promise<ApprovedRootAllowlist>
  list(sql: SqlQuery, principal: ManagementPrincipal, workspaceId: string): Promise<{ workspaceId: string; policies: WorkspaceRootPolicy[]; allowlists: ApprovedRootAllowlist[]; readiness: 'metadata-only' }>
  authorize(sql: SqlQuery, principal: ManagementPrincipal, selection: WorkspaceRootSelection): Promise<AuthorizedWorkspaceRoot>
  authorizeManaged?(sql: SqlQuery, principal: ManagementPrincipal,
    selection: WorkspaceRootSelection): Promise<AuthorizedWorkspaceRoot>
  attest(root: AuthorizedWorkspaceRoot): Promise<WorkspaceRootAttestation>
  prepareManaged?(root: AuthorizedWorkspaceRoot): Promise<WorkspaceRootAttestation>
  inspect(sql: SqlQuery, principal: ManagementPrincipal, policy: WorkspaceRootPolicy): Promise<void>
  browse(root: AuthorizedWorkspaceRoot, relativePath: string): Promise<WorkspaceRootBrowseResult>
  fence(sql: SqlQuery, root: AuthorizedWorkspaceRoot): Promise<void>
  bind(sql: SqlQuery, principal: ManagementPrincipal, root: AuthorizedWorkspaceRoot, attestation: WorkspaceRootAttestation, nextLocationRevision: number): Promise<WorkspaceRootPolicy>
  bindManaged?(sql: SqlQuery, principal: ManagementPrincipal, root: AuthorizedWorkspaceRoot,
    attestation: WorkspaceRootAttestation): Promise<WorkspaceRootPolicy>
  resolve(sql: SqlQuery, principal: ManagementPrincipal,
    selection: { workspaceId: string; hostRef: WorkspaceRootPolicy['hostRef']; rootPolicyId: string; rootPolicyRevision: string; locationRevision: string }): Promise<WorkspaceRootPolicy>
  read(sql: SqlQuery, principal: ManagementPrincipal, workspaceId: string): Promise<WorkspaceRootPolicy[]>
}
export interface WorkspaceRootHostPort {
  /** Read the original protected human-approved host configuration over its authenticated carrier. */
  configuration?(sql: SqlQuery, host: ApprovedRootAllowlist['hostRef']): Promise<ApprovedRootAllowlist>
  /** Main SQL authority calls W07's existing device/main authorizer before host I/O. */
  authorize(sql: SqlQuery, principal: ManagementPrincipal, host: ApprovedRootAllowlist['hostRef'], installationId: string): Promise<WorkspaceRootPolicy['registration']>
  /** Persisted human-approved host configuration only; no probe/browse on list. */
  configurations(sql: SqlQuery, workspaceId: string): Promise<ApprovedRootAllowlist[]>
  attest(root: AuthorizedWorkspaceRoot): Promise<WorkspaceRootAttestation>
  prepareManaged?(root: AuthorizedWorkspaceRoot): Promise<WorkspaceRootAttestation>
  browse(root: AuthorizedWorkspaceRoot, relativePath: string): Promise<WorkspaceRootBrowseResult>
  sourceNamespace(policy: WorkspaceRootPolicy, rootId: string): Promise<{ canonicalPath: string; filesystem: WorkspaceRootPolicy['filesystem']; attestationId: string; attestationDigest: string }>
}
