// Installs Main's server ports for CI as a side effect of being imported. It loads only the port implementations, so a
// test setup can import it cheaply; an install replaces the previous one, so loading it again is harmless.
import { installCiServerPorts } from '@foreman-code/ci/environment'
import { requireAuthorization } from '../access/policy.js'
import { readComputerNames } from '../computers/names.js'
import { workerBundleErrorMessage } from '../computers/workerBundleReadiness.js'
import { Budget } from '../files/archives/policy.js'
import { decodeEntry, parseZip } from '../files/archives/zip.js'
import { assertBuildComputerTarget } from '../settings/buildComputers.js'
import { PostgresFoundationSettingsRepository } from '../settings/foundation.js'
import { WorkerExecutionPolicy } from '../settings/workerExecution.js'

installCiServerPorts({
  requireAuthorization,
  readComputerNames,
  workerBundleErrorMessage,
  assertBuildComputerTarget,
  createWorkerExecutionPolicy: () => new WorkerExecutionPolicy(),
  readCircleAccounts: (pool, client) => new PostgresFoundationSettingsRepository(pool).getCircleAccounts(client),
  createZipBudget: () => new Budget(),
  parseZip: (bytes, budget) => parseZip(bytes, budget as Budget),
  decodeEntry: (bytes, entry, budget) => decodeEntry(bytes, entry, budget as Budget),
})
