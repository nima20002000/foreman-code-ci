// Main's CI: installs the platform and the server ports, and builds the CircleCI and host CI services that production
// composes and starts.
import './platform.js'
import './serverPorts.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { HostCiService } from '@foreman-code/ci/service'
import { GitCiCommits } from '@foreman-code/ci/commits'
import { ProductionHostCiEndpoint } from '@foreman-code/ci/endpoint'
import { HostCiRunner, systemHostCiPorts } from '@foreman-code/ci/runner'
import { CircleCreditUsage } from '@foreman-code/ci/circleCredits'
import { CircleAccountDirectory } from '@foreman-code/ci/circleAccounts'
import { CircleCreditCache } from '@foreman-code/ci/circleCreditCache'
import { circleOrganizations } from '@foreman-code/ci/circleOrganizations'
import { CircleStandby } from '@foreman-code/ci/circleStandby'
import { CircleAccountFleetStatus } from '@foreman-code/ci/circleAccountStatus'
import { activeCiRuns, circleCiOrgs, cloudCis, runningCircleCiOwners, workspaceMirrorList, workspaceMirrors }
  from '@foreman-code/ci/cloud'
import { configuredReservedCloudSlots } from '@foreman-code/ci/cloudSlots'
import { agentSnapshots, type ReadAgentFiles } from '@foreman-code/ci/agentSnapshots'
import { withCiDatabaseReservation } from '../../infrastructure/ciDatabasePriority.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { RunCiAuthority } from './runAuthority.js'
import { CircleAccountsManagementService } from '@foreman-code/ci/circleAccountsManagement'
import type { PostgresFoundationSettingsRepository } from '../settings/foundation.js'
import type { WorkerExecutionPolicy } from '../settings/workerExecution.js'

export { agentFileReader } from '@foreman-code/ci/agentFileReader'
export { CiRuntimeProvisioner } from '@foreman-code/ci/ciRuntimeProvisioner'
export { CiEnrollment } from '@foreman-code/ci/ciEnrollment'

/** Builds Main's CircleCI and GitHub Actions providers and the CircleCI account settings service. */
export async function createCircleCi(input: {
  pool: pg.Pool
  mainId: string
  foundationSettings: PostgresFoundationSettingsRepository
  commands: PostgresCommandCoordinator
}) {
  const { pool, mainId, foundationSettings, commands } = input
  const registry = { list: async () => (await foundationSettings.getCircleAccounts()).value.accounts }
  const directory = new CircleAccountDirectory(systemHostCiPorts(), registry)
  const context = async (id: string) => {
    const account = await directory.context(id)
    if (!account) throw new DomainError('CI_CLOUD_UNAVAILABLE', 'This CircleCI login is no longer registered.', 409)
    return account
  }
  const options = { activeRuns: () => activeCiRuns(pool) }
  const mirrors = workspaceMirrors(pool)
  const mirrorList = workspaceMirrorList(pool)
  const clouds = cloudCis(mainId, mirrors, {
    ...options, primaryContext: await context('default'), explicitCircleOrgs: true,
  })
  const cache = new CircleCreditCache(join(homedir(), '.local/share/foreman-code/circleci-usage', 'usage.json'))
  const circleCredits = new CircleCreditUsage(async id => (await context(id)).http, {
    allowance: () => withCiDatabaseReservation(pool, async () => {
      return (await foundationSettings.getCircleCreditAllowance()).value
    }),
    primaryOwner: async () => null,
  }, { cache })
  const circleStandby = new CircleStandby(() => circleOrganizations(clouds), circleCredits, cache)
  const circleOrgs = circleCiOrgs(clouds, mainId, mirrors, mirrorList, {
    ...options, registry, context, standby: circleStandby, explicitPrimary: true,
    runningOrganizations: runningCircleCiOwners(pool, mainId),
  })
  const circleAccounts = new CircleAccountsManagementService(foundationSettings, commands,
    new CircleAccountFleetStatus(pool, mainId, directory, clouds, circleStandby), async id => {
    directory.invalidate(id)
    for (const cloud of clouds) if (cloud.provider.circleAccountId === id) cloud.invalidateReadiness()
    await circleOrgs.refresh()
    circleOrgs.invalidate()
    await circleOrgs.refresh()
  })
  return { clouds, discoverClouds: () => circleOrgs.refresh(), circleCredits, circleStandby, circleAccounts }
}

/** Builds Main's host CI service; the caller starts it and closes it with the app. */
export function createHostCi(input: {
  pool: pg.Pool
  mainId: string
  commands: PostgresCommandCoordinator
  devices: ConstructorParameters<typeof ProductionHostCiEndpoint>[2]
  workerExecution: WorkerExecutionPolicy
  clouds: ReturnType<typeof cloudCis>
  discoverClouds: () => Promise<void>
  readAgentFiles: ReadAgentFiles
  circleCredits: CircleCreditUsage
  circleStandby: CircleStandby
}): HostCiService {
  const { pool, mainId, commands, devices, workerExecution, clouds, discoverClouds, readAgentFiles, circleCredits,
    circleStandby } = input
  // CI runs directly on build computers (Main included) from GitHub, like self-hosted runners.
  return new HostCiService(pool, commands, new RunCiAuthority(pool), new GitCiCommits(),
    new ProductionHostCiEndpoint(pool, mainId, devices, new HostCiRunner(),
      clouds, discoverClouds, workerExecution),
    agentSnapshots(pool, readAgentFiles), {
      reservedCloudSlots: configuredReservedCloudSlots(), circleCredits, circleStandby,
    })
}
