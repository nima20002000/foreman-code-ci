import { fileURLToPath } from 'node:url'
import { installCiPlatform } from '@foreman-code/ci/environment'
import { withTransaction, inTransaction } from '../../infrastructure/transaction.js'
import {
  queueCiDatabaseWork, waitForCiDispatch, withCiDatabasePriority, withCiDatabaseReservation, withoutCiDatabaseDeadline,
  withoutCiDatabasePriority, withoutCiDatabaseReservation,
} from '../../infrastructure/ciDatabasePriority.js'
import { componentLogger } from '../diagnostics/logger.js'
import { fallbackOnError, fallbackOnMissing, logIgnoredError } from '../diagnostics/ignoredError.js'
import { reportServiceFailure, trackService } from '../diagnostics/serviceHealth.js'
import { failedReadObservation, successfulReadObservation } from '../diagnostics/readObservation.js'
import { updateOperationalFailure } from '../diagnostics/operationalFailures.js'
import {
  deepenUntilConnected, ensureClone, ensureCommit, fetchRepositoryBranch, systemGitWorktreePorts,
} from '../sources/gitWorktree.js'
import { importAgentSnapshot, snapshotAgentWorktree } from '../sources/agentSnapshot.js'
import { publishCommit } from '../sources/githubPublisher.js'
import { gitFailure } from '../sources/gitErrors.js'
import { SourceError } from '../sources/manifest.js'
import { withPrivateDirectoryLock } from '../sources/privateFilesystem.js'
import { DeviceApplicationAdmissionError, DeviceApplicationError } from '../devices/deviceApplicationError.js'
import { DeviceAccessError } from '../devices/accessError.js'

// Installs this process's single-instance services for CI. Main and the Worker both load it before any CI code runs:
// every adapter module that hands out CI code imports it first. It imports nothing server-only, so the Worker can load it.

/**
 * The watchdog wraps unit and integration commands when the tested source has none. This is the expression the
 * runner used before CI moved into its own package, unchanged because this file sits at the same depth
 * (apps/api/src/modules/<dir>/): a bundled Worker (.mjs) finds it in its artifacts, a source or compiled API in the
 * repository's scripts.
 */
const watchdog = fileURLToPath(new URL(import.meta.url.endsWith('.mjs')
  ? '../artifacts/verification/ci-watchdog.mjs' : '../../../../../scripts/ci-watchdog.mjs', import.meta.url))

installCiPlatform({
  componentLogger,
  logIgnoredError,
  fallbackOnError,
  fallbackOnMissing,
  trackService,
  reportServiceFailure,
  failedReadObservation,
  successfulReadObservation,
  updateOperationalFailure,
  withTransaction,
  inTransaction,
  withCiDatabasePriority,
  withoutCiDatabasePriority,
  withoutCiDatabaseReservation,
  withCiDatabaseReservation,
  queueCiDatabaseWork,
  withoutCiDatabaseDeadline,
  waitForCiDispatch,
  ensureClone,
  ensureCommit,
  fetchRepositoryBranch,
  deepenUntilConnected,
  systemGitWorktreePorts,
  snapshotAgentWorktree,
  importAgentSnapshot,
  publishCommit,
  gitFailure,
  sourceError: (code, message, options) => new SourceError(code, message, options),
  isSourceError: (error): error is SourceError => error instanceof SourceError,
  withPrivateDirectoryLock,
  isDeviceApplicationError: (error): error is DeviceApplicationError => error instanceof DeviceApplicationError,
  isDeviceApplicationAdmissionError: (error): error is DeviceApplicationAdmissionError =>
    error instanceof DeviceApplicationAdmissionError,
  isDeviceAccessError: (error): error is DeviceAccessError => error instanceof DeviceAccessError,
  paths: { watchdog },
})
