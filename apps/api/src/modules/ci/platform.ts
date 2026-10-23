import { fileURLToPath } from 'node:url'
import { createCiContext, type CiContext, type CiPlatform } from '@foreman-code/ci/environment'
import { withTransaction } from '../../infrastructure/transaction.js'
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
import { identity, openChildDirectory, openPrivateRoot, withPrivateDirectoryLock } from '../sources/privateFilesystem.js'
import { DeviceApplicationAdmissionError, DeviceApplicationError } from '../devices/deviceApplicationError.js'
import { DeviceAccessError } from '../devices/accessError.js'
import { DeviceConnectionError } from '../devices/deviceWire.js'
import { fingerprintQualificationPath } from '../jobs/qualificationFingerprint.js'
import { readJobProjectQuota } from '../jobs/quotaOwnership.js'
import { buildCiRuntimeContext, ciRuntimeInputDigest, parseCiLock } from '../jobs/ciRuntimeContext.mjs'
import { expectedPortions } from '../../../../../scripts/verification-runner.mjs'

// This process's single-instance services for CI, on Main and on a Worker. It imports nothing server-only, so the Worker
// can load it.

/**
 * The watchdog wraps unit and integration commands when the tested source has none. This is the expression the
 * runner used before CI moved into its own package, unchanged because this file sits at the same depth
 * (apps/api/src/modules/<dir>/): a bundled Worker (.mjs) finds it in its artifacts, a source or compiled API in the
 * repository's scripts.
 */
const watchdog = fileURLToPath(new URL(import.meta.url.endsWith('.mjs')
  ? '../artifacts/verification/ci-watchdog.mjs' : '../../../../../scripts/ci-watchdog.mjs', import.meta.url))

/** The host services CI calls on Main and on a Worker. */
export const ciPlatform: CiPlatform = {
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
  inTransaction: (pool, supplied, perform) => withTransaction(pool, perform, { join: supplied }),
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
  isDeviceConnectionError: (error): error is DeviceConnectionError => error instanceof DeviceConnectionError,
  identity,
  openPrivateRoot,
  openChildDirectory,
  fingerprintQualificationPath,
  readJobProjectQuota,
  buildCiRuntimeContext,
  ciRuntimeInputDigest,
  parseCiLock,
  expectedPortions,
  paths: { watchdog },
}

/** CI's context on a host without Main's server ports: a Worker, and Main's code that a Worker shares. */
export const platformCiContext: CiContext = createCiContext(ciPlatform)
