import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { open, type FileHandle } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { ReadObservation } from '@foreman-code/contracts'
import { DomainError } from '@foreman-code/contracts/server-kit'
import { anchored, createCiContext, type CiLogger, type CiPlatform, type CiServerPorts, type MainCiContext,
  type SqlQuery } from '../../src/environment.js'

// A host for CI unit tests: real file locks and simple stand-ins for the services a host owns. Database work runs on
// the test's pool without transaction statements, and no dispatch pass holds database priority, so priority and
// deadline scopes run their work directly, as Main does outside a dispatch pass. Git, Main's private filesystem, the
// runtime build and Main's settings are not part of it: tests of those stay with the API, which supplies them.

const silent: CiLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }

const codeOf = (error: unknown) => (error as { code?: unknown } | null)?.code

class TestSourceError extends DomainError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(code, message, 400)
    if (options && 'cause' in options) this.cause = options.cause
    this.name = 'SourceError'
  }
}

const unavailable = (name: string) => () => {
  throw new Error(`${name} is not part of the CI unit test host; test it with the API's host services.`)
}

/** Locks the pinned directory inode across processes with flock(1), until the guard closes. */
async function withDirectoryLock<T>(root: FileHandle, work: (guard: FileHandle) => Promise<T>,
  options: { nonBlocking?: boolean; signal?: AbortSignal | undefined } = {}): Promise<T> {
  const guard = await open(anchored(root), constants.O_RDONLY | constants.O_DIRECTORY)
  try {
    options.signal?.throwIfAborted()
    const locked = await new Promise<boolean>((resolve, reject) => {
      const child = spawn('/usr/bin/flock', ['--exclusive', ...(options.nonBlocking ? ['--nonblock'] : []), '3'], {
        stdio: ['ignore', 'ignore', 'ignore', guard.fd],
        ...(options.signal ? { signal: options.signal } : {}),
      })
      let failure: Error | undefined
      child.once('error', error => { failure = error })
      child.once('close', code => {
        if (options.signal?.aborted) reject(options.signal.reason)
        else if (failure) reject(failure)
        else if (code === 0) resolve(true)
        else if (options.nonBlocking && code === 1) resolve(false)
        else reject(new TestSourceError('SOURCE_CLAIM_LOCK_FAILED', 'Source ownership serialization failed.'))
      })
    })
    if (!locked) throw new TestSourceError('SOURCE_CLAIM_LOCK_FAILED', 'Source ownership serialization failed.')
    options.signal?.throwIfAborted()
    return await work(guard)
  } finally { await guard.close() }
}

async function onConnection<T>(pool: { connect(): Promise<unknown> }, perform: (client: never) => Promise<T>) {
  const client = await pool.connect() as { release(): void }
  try {
    return await perform(client as never)
  } finally { client.release() }
}

export const testCiPlatform: CiPlatform = {
  componentLogger: () => silent,
  logIgnoredError: () => {},
  fallbackOnError: fallback => () => fallback,
  fallbackOnMissing: fallback => error => {
    if (codeOf(error) === 'ENOENT') return fallback
    throw error
  },
  trackService: (_name, _schedule, work) => work(),
  reportServiceFailure: () => {},
  failedReadObservation: (previous: ReadObservation | undefined, error, message, now = Date.now()) => {
    const code = codeOf(error)
    const reason = typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,79}$/u.test(code) ? code : 'READ_FAILED'
    return { status: 'unavailable', lastError: `${message} (${reason}).`, failedAt: new Date(now).toISOString(),
      lastSuccess: previous?.lastSuccess ?? null, consecutiveFailures: (previous?.consecutiveFailures ?? 0) + 1 }
  },
  successfulReadObservation: (now = Date.now()) => ({ status: 'available', lastError: null, failedAt: null,
    lastSuccess: new Date(now).toISOString(), consecutiveFailures: 0 }),
  updateOperationalFailure: () => {},
  withTransaction: (pool, perform) => onConnection(pool, perform),
  inTransaction: (pool, supplied, perform) => supplied ? perform(supplied) : onConnection(pool, perform),
  withCiDatabasePriority: work => work(),
  withoutCiDatabasePriority: work => work(),
  withoutCiDatabaseReservation: work => work(),
  withCiDatabaseReservation: (_pool, work) => work(),
  queueCiDatabaseWork: (_pool, work) => work(),
  withoutCiDatabaseDeadline: work => work(),
  waitForCiDispatch: work => work(),
  ensureClone: unavailable('ensureClone'),
  ensureCommit: unavailable('ensureCommit'),
  fetchRepositoryBranch: unavailable('fetchRepositoryBranch'),
  deepenUntilConnected: unavailable('deepenUntilConnected'),
  systemGitWorktreePorts: unavailable('systemGitWorktreePorts'),
  snapshotAgentWorktree: unavailable('snapshotAgentWorktree'),
  importAgentSnapshot: unavailable('importAgentSnapshot'),
  publishCommit: unavailable('publishCommit'),
  gitFailure: unavailable('gitFailure'),
  sourceError: (code, message, options) => new TestSourceError(code, message, options),
  isSourceError: (error): error is DomainError => error instanceof TestSourceError,
  withPrivateDirectoryLock: withDirectoryLock,
  isDeviceApplicationError: (error): error is never => { void error; return false },
  isDeviceApplicationAdmissionError: (error): error is never => { void error; return false },
  isDeviceAccessError: (error): error is never => { void error; return false },
  isDeviceConnectionError: (error): error is never => { void error; return false },
  identity: unavailable('identity'),
  openPrivateRoot: unavailable('openPrivateRoot'),
  openChildDirectory: unavailable('openChildDirectory'),
  fingerprintQualificationPath: unavailable('fingerprintQualificationPath'),
  readJobProjectQuota: unavailable('readJobProjectQuota'),
  buildCiRuntimeContext: unavailable('buildCiRuntimeContext'),
  ciRuntimeInputDigest: unavailable('ciRuntimeInputDigest'),
  parseCiLock: unavailable('parseCiLock'),
  expectedPortions: unavailable('expectedPortions'),
  paths: { watchdog: fileURLToPath(new URL('../../../../scripts/ci-watchdog.mjs', import.meta.url)) },
}

export const testCiServerPorts: CiServerPorts = {
  requireAuthorization: unavailable('requireAuthorization'),
  readComputerNames: async (sql: SqlQuery, mainId: string) => {
    const rows = await sql.query<{ host_key: string; name: string }>(
      'select host_key,name from computer_names where host_key like $1', [`${mainId}:%`])
    return new Map(rows.rows.map(row => [row.host_key, row.name]))
  },
  workerBundleErrorMessage: unavailable('workerBundleErrorMessage'),
  assertBuildComputerTarget: unavailable('assertBuildComputerTarget'),
  createWorkerExecutionPolicy: () => ({ requireEnabled: () => {} }),
  readCircleAccounts: unavailable('readCircleAccounts'),
  createZipBudget: unavailable('createZipBudget'),
  parseZip: unavailable('parseZip'),
  decodeEntry: unavailable('decodeEntry'),
  isAuthorized: unavailable('isAuthorized'),
  intersectGrants: unavailable('intersectGrants'),
  currentOperatorAuthority: unavailable('currentOperatorAuthority'),
  readLiveManagementPrincipal: unavailable('readLiveManagementPrincipal'),
  lockActiveWorkspace: unavailable('lockActiveWorkspace'),
  beforeGraphCommit: unavailable('beforeGraphCommit'),
  readBuildComputerPreference: unavailable('readBuildComputerPreference'),
  deviceApplicationFailure: unavailable('deviceApplicationFailure'),
  acquireJobOwnership: unavailable('acquireJobOwnership'),
}

/** The context CI unit tests pass wherever Main would pass its own. */
export const testCiContext: MainCiContext = createCiContext(testCiPlatform, testCiServerPorts)
