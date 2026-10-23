// Main's server ports for CI. It loads only the port implementations, so a test can import it cheaply.
import type { CiServerPorts } from '@foreman-code/ci/environment'
import { isAuthorized, requireAuthorization } from '../access/index.js'
import { intersectGrants } from '../access/index.js'
import { currentOperatorAuthority } from '../access/index.js'
import { readLiveManagementPrincipal } from '../access/index.js'
import { readComputerNames } from '../computers/index.js'
import { workerBundleErrorMessage } from '../computers/index.js'
import { Budget } from '../files/index.js'
import { decodeEntry, parseZip } from '../files/index.js'
import { deviceApplicationFailure } from '../devices/deviceApplicationError.js'
import { JobOwnership } from '../jobs/ownership.js'
import { beforeGraphCommit } from '../run-graph/index.js'
import { assertBuildComputerTarget, readBuildComputerPreference } from '../settings/index.js'
import { PostgresFoundationSettingsRepository } from '../settings/index.js'
import { WorkerExecutionPolicy } from '../settings/index.js'
import { lockActiveWorkspace } from '../workspaces/index.js'

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
