import { isDeepStrictEqual } from 'node:util'
import { OperatorConfigurationVersionSchema } from '@foreman-code/contracts'
import { readCoordinatorCredentialAuthority } from '../../access/consultationAuthority.js'
import { requireAuthorization } from '../../access/policy.js'
import type { PostgresAccessService } from '../../access/postgres.js'
import { currentOperatorAuthority, readRunAuthorizationPrincipal } from '../../access/runAuthority.js'
import { assertDeviceHostInstallation } from '../../devices/hostAuthorization.js'
import { DomainError } from '../../errors.js'
import { credentialAuthority } from '../../interactions/current/credentialAuthority.js'
import { authorizeOperatorConfigurationRead } from '../../operators/index.js'
import type { ProviderAccountsService } from '../../provider-accounts/service.js'
import { PostgresClaudeInteractionAuthority } from '../claudeSdk/domainAuthority.js'
import { installedClaudeProfilePin } from '../claudeSdk/installedProfilePin.js'
import type { ClaudeProfileOwner } from '../claudeSdk/production.js'
import { requireClaudeProductionCredentialDelivery } from '../claudeSdk/productionCredentials.js'
import { CLAUDE_PROFILE_CHECK_REVISION } from '../claudeSdk/profileRevision.js'
import { authorizeOperatorProfileObservation } from '../operatorProfileObservation.js'
import type { ProductionHarnessRegistry } from '../productionRegistry.js'
import type { AcceptedProfileAuthority } from './acceptedProfile.js'
import type { HostHarnessProfileEvidenceRepository } from './profileRepository.js'
import type { HostHarnessInstanceProfileChecks } from './profileChecks.js'

/** Who may admit an accepted host profile, and the current installed proof behind it. */
export function createProductionProfileAuthority(deps: {
  access: PostgresAccessService
  providerAccounts: ProviderAccountsService
  registry: ProductionHarnessRegistry
  evidence: HostHarnessProfileEvidenceRepository
  /** The installed local Claude profile reader; absent when the host replays recorded protocol. */
  claudeCurrent: () => AcceptedProfileAuthority<ClaudeProfileOwner>['current'] | undefined
  checks: () => HostHarnessInstanceProfileChecks
}): AcceptedProfileAuthority<ClaudeProfileOwner> {
  const { access, providerAccounts, registry, evidence } = deps
  return {
    async authorize(binding, selector, client) {
      binding.admissionSignal?.throwIfAborted()
      if (binding.kind === 'workflow' && binding.purpose === 'consultation') {
        if (!binding.consultation) throw new DomainError('HARNESS_PROFILE_OWNER_CONFLICT',
          'The consultation profile requires its mailbox binding.', 409)
        const current = await readCoordinatorCredentialAuthority(client, binding.consultation)
        if (current.run_id !== binding.runId || current.execution.id !== binding.executionId
          || current.execution.attempt !== binding.attempt) throw new DomainError('HARNESS_PROFILE_OWNER_CONFLICT',
          'The consultation source attempt changed.', 409)
        const owner = binding.getOwner()
        if (!owner || owner.runId !== binding.runId) throw new DomainError('HARNESS_PROFILE_OWNER_CONFLICT',
          'The consultation Run owner is unavailable.', 409)
        owner.assertOwned()
        const row = await readRunAuthorizationPrincipal(client, binding.runId)
        if (!row) throw new DomainError('HARNESS_PROFILE_OWNER_CONFLICT', 'The accepted Run is unavailable.', 409)
        const principal = (await currentOperatorAuthority(client, row.principalId)).principal
        requireAuthorization(principal, 'runs:start', { workspaceId: current.workspace_id, workflowId: current.workflow_id })
      } else if (binding.kind === 'workflow') {
        const current = await credentialAuthority(client, binding.executionId,
          binding.purpose === 'reviewer' ? 'reviewer' : 'workflow')
        if (current.run.id !== binding.runId || current.execution.attempt !== binding.attempt) throw new DomainError('HARNESS_PROFILE_OWNER_CONFLICT', 'The exact Run attempt changed.', 409)
        if (!current.nativeSessionId && binding.purpose !== 'reviewer') {
          const owner = binding.getOwner()
          if (!owner || owner.runId !== binding.runId) throw new DomainError('HARNESS_PROFILE_OWNER_CONFLICT', 'The original native launch owner is unavailable.', 409)
          owner.assertOwned(); await owner.readOneShotFence(owner.client)
        }
        const row = await readRunAuthorizationPrincipal(client, binding.runId)
        if (!row?.principalId) throw new DomainError('HARNESS_PROFILE_OWNER_CONFLICT', 'The accepted Run principal is unavailable.', 409)
        const principal = (await currentOperatorAuthority(client, row.principalId)).principal
        requireAuthorization(principal, 'runs:start', { workspaceId: current.run.workspaceId, workflowId: current.run.workflowId })
      } else if (binding.kind === 'operator-observation') {
        await authorizeOperatorProfileObservation(client, binding, selector)
      } else if (binding.kind === 'operator-inspection') {
        const principal = await access.currentHarnessInspectionPrincipal(binding.principalId, client)
        requireAuthorization(principal, 'harnesses:read')
        await authorizeOperatorConfigurationRead(client, principal, binding.configurationVersionId)
        const row = (await client.query<{ record: unknown }>('select record from operator_configuration_versions where id=$1 and operator_id=$2',
          [binding.configurationVersionId, 'application-operator'])).rows[0]
        const configuration = row ? OperatorConfigurationVersionSchema.parse(row.record) : undefined
        if (!configuration || configuration.contentHash !== binding.configurationHash || !isDeepStrictEqual(configuration.harnessProfileSelection, selector)) {
          throw new DomainError('HARNESS_PROFILE_OWNER_CONFLICT', 'The exact saved Operator configuration changed before its read-only inspection.', 409)
        }
      } else await new PostgresClaudeInteractionAuthority(client, binding, { nativeCallbackContext: () => undefined }).profileAdmission()
      await assertDeviceHostInstallation(client, selector.target.hostRef, selector.target.applicationInstallationId)
      binding.admissionSignal?.throwIfAborted()
    },
    async current(binding, value, client, options) {
      if (value.driverId === 'claude') {
        await requireClaudeProductionCredentialDelivery(value.configuration, providerAccounts, value.target.hostRef,
          value.target.applicationInstallationId)
        if (value.target.hostRef.kind === 'device') {
          const pinned = registry.pinOverride(value)
          const proof = await evidence.latest(value.instanceId, value.revision, client)
          const pin = installedClaudeProfilePin(value, pinned, proof)
          registry.installations.assertCurrent(pinned)
          return { registry: pinned, pin, applicationInstallationId: value.target.applicationInstallationId,
            suiteRevision: CLAUDE_PROFILE_CHECK_REVISION }
        }
        const current = deps.claudeCurrent()
        if (!current) throw new DomainError('HARNESS_REPLAY_INCOMPLETE', 'Claude replay requires its current installed profile metadata port.', 500)
        return current(binding, value, client, options)
      }
      if (binding.kind !== 'operator-observation' && !await registry.profileEvidence(value, client, options)) {
        throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'The exact accepted native profile proof is stale.', 409)
      }
      return { registry: registry.pinOverride(value), applicationInstallationId: value.target.applicationInstallationId,
        suiteRevision: `${value.driverId}-profile-check-v1` }
    },
    assertCurrent: binding => registry.installations.assertCurrent(binding),
    assertReady: profile => deps.checks().assertReady(profile),
  }
}
