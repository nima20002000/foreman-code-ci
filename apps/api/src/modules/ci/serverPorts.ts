// Main's server ports for CI. It loads only the port implementations, so a test can import it cheaply.
import type { CiServerPorts } from '@foreman-code/ci/environment'
import { isAuthorized, requireAuthorization } from '../access/policy.js'
import { intersectGrants } from '../access/operatorDelegation.js'
import { currentOperatorAuthority } from '../access/runAuthority.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { readComputerNames } from '../computers/names.js'
import { workerBundleErrorMessage } from '../computers/workerBundleReadiness.js'
import { Budget } from '../files/archives/policy.js'
import { decodeEntry, parseZip } from '../files/archives/zip.js'
import { deviceApplicationFailure } from '../devices/deviceApplicationError.js'
import { JobOwnership } from '../jobs/ownership.js'
import { beforeGraphCommit } from '../run-graph/connection.js'
import { assertBuildComputerTarget, readBuildComputerPreference } from '../settings/buildComputers.js'
import { PostgresFoundationSettingsRepository } from '../settings/foundation.js'
import { WorkerExecutionPolicy } from '../settings/workerExecution.js'
import { lockActiveWorkspace } from '../workspaces/admission.js'

/** The Main-only services CI calls: authorization, computer settings and archive reading. */
export const ciServerPorts: CiServerPorts = {
  requireAuthorization,
  readComputerNames,
  workerBundleErrorMessage,
  assertBuildComputerTarget,
  createWorkerExecutionPolicy: () => new WorkerExecutionPolicy(),
  readCircleAccounts: (pool, client) => new PostgresFoundationSettingsRepository(pool).getCircleAccounts(client),
  createZipBudget: () => new Budget(),
  parseZip: (bytes, budget) => parseZip(bytes, budget as Budget),
  decodeEntry: (bytes, entry, budget) => decodeEntry(bytes, entry, budget as Budget),
  isAuthorized,
  intersectGrants,
  currentOperatorAuthority,
  readLiveManagementPrincipal,
  lockActiveWorkspace,
  beforeGraphCommit,
  readBuildComputerPreference,
  deviceApplicationFailure,
  acquireJobOwnership: (pool, executionId, onLost) => JobOwnership.acquire(pool, executionId, onLost),
}
