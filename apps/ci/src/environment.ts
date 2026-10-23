import { constants } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import type pg from 'pg'
import type { OperationalFailure, ReadObservation } from '@foreman-code/contracts'
import type { WorkerBundleReadiness } from '@foreman-code/contracts/computer-maintenance'
import type { BuildComputerPreference } from '@foreman-code/contracts/build-computers'
import type { DeviceApplicationFailure, DeviceApplicationResult, DeviceNegotiatedExtension, DeviceRequestPriority }
  from '@foreman-code/contracts/device-application'
import type { DeviceFailureCode, DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { FailureClass } from '@foreman-code/contracts/failure'
import type { JobRuntimeProfileRecord, JobRuntimeProfileSaveRecord, JobVerificationQuotaPool }
  from '@foreman-code/contracts/job-verification-runtime'
import type { CircleAccounts, ManagementAction, ManagementGrant, ManagementPrincipal } from '@foreman-code/contracts/management'
import type { RemoteJobOperationReceiptRecord } from '@foreman-code/contracts/remote-job-execution'
import type { SourceRootRecord } from '@foreman-code/contracts/source-admission'
import type { SourceManifest } from '@foreman-code/contracts/source-materialization'
import type { DomainError } from '@foreman-code/contracts/server-kit'

// The host process (Main or a Worker) installs its own single-instance services here before CI runs: one logger,
// one service-health table, one transaction helper and one CI database-priority context per process. Every CI module
// calls them through the forwarding exports below, so a module may be loaded before the host installs them.

export type LogComponent = 'lifecycle' | 'http' | 'engine' | 'harness' | 'db' | 'devices' | 'jobs' | 'byte-transfer'
export type CiLogFn = (obj: unknown, msg?: string, ...args: unknown[]) => void
export interface CiLogger { debug: CiLogFn; info: CiLogFn; warn: CiLogFn; error: CiLogFn }
export interface ServiceSchedule { cadenceMs?: number; deadlineMs: number }

export interface SqlQuery {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>
}
/** Main's job SQL client: a pool, a client or a graph transaction. */
export type JobSql = SqlQuery
/** A statement client inside one of Main's graph transactions. */
export interface GraphTransactionSql extends SqlQuery { readonly transaction: true }
export interface TransactionOptions {
  isolation?: 'read committed' | 'repeatable read'
  readOnly?: boolean
  conflictRetries?: number
  operation?: 'transaction' | 'graph.read' | 'graph.write'
}

export interface GitWorktreePorts {
  cloneDirectory(repository: string): string
  git(args: string[], options: { cwd?: string; signal: AbortSignal; env?: Record<string, string>;
    lifetimeLockFd?: number }): Promise<{ code: number; stdout: string; stderr: string }>
}
export type AgentSnapshot = { commit: string; bundle: Buffer | null }

export interface DeviceApplicationErrorLike extends Error {
  readonly code: string
  readonly class: FailureClass
  readonly retryable: boolean
  readonly details: WorkerBundleReadiness | undefined
}
export interface DeviceApplicationAdmissionErrorLike extends DeviceApplicationErrorLike { readonly reason: string }
export interface DeviceConnectionErrorLike extends Error {
  readonly code: DeviceFailureCode
  readonly detail: string | undefined
}
export type DeviceAccessErrorLike = DomainError & {
  readonly code: 'unauthorized' | 'revoked' | 'expired' | 'conflict' | 'forbidden' | 'wrong_main'
}
export interface DeviceRequestOptions { signal?: AbortSignal; timeoutMs?: number; priority?: DeviceRequestPriority }
/** The parts of Main's device endpoint CI reads. */
export interface DeviceEndpoint {
  capabilities(deviceId: string): DeviceNegotiatedExtension[]
  request(deviceId: string, namespace: string, payload: unknown, options?: DeviceRequestOptions): Promise<DeviceApplicationResult>
  captureRequest(deviceId: string, namespace: string): {
    binding: Readonly<DeviceSessionBinding>
    request(payload: unknown, options?: DeviceRequestOptions): Promise<DeviceApplicationResult>
  } | undefined
  currentBinding(deviceId: string, namespace?: string): Readonly<DeviceSessionBinding> | undefined
}

interface PreparedMutation {
  releaseDuringPreparation?: true
  resourceLock: string
  validate(client: pg.PoolClient): Promise<boolean>
}
export interface CommandInput<T> {
  principal: ManagementPrincipal
  source: 'http' | 'mcp' | 'device'
  operation: string
  commandId?: string | undefined
  targetKey: string
  payload: unknown
  resourceLock?: string
  perform(client: pg.PoolClient): Promise<T>
  authorize?(client: pg.PoolClient): Promise<void>
  afterRollback?(client: pg.PoolClient): Promise<void>
  dedicatedConnection?: true
  prepare?(pool: pg.Pool): Promise<void>
  preparedMutation?: PreparedMutation
  replayResult?(result: unknown): T
  shouldResumeReceipt?(client: pg.PoolClient): Promise<boolean>
}
/** Main's command coordinator: receipts, idempotent replay and denial audit. */
export interface PostgresCommandCoordinator {
  execute<T>(input: CommandInput<T>): Promise<{ value: T; replayed: boolean }>
  recordDenied(principalId: string | undefined, source: 'http' | 'mcp' | 'device', action: string, targetKey: string): Promise<void>
}

export interface AuthorizedResource {
  workspaceId?: string
  workflowId?: string
  runId?: string
  mainId?: string
  deviceId?: string
  applicationInstallationId?: string
  providerAccountId?: string
}
export interface CiWorkerExecutionPolicy { requireEnabled(host: { kind: 'main' | 'device' }): void }
/** The parts of Main's computer endpoint CI runtime preparation calls. */
export interface ComputerAccountsEndpoint {
  capabilities(deviceId: string): readonly { namespace: string; mainCanRequest: boolean }[]
  request(deviceId: string, namespace: string, payload: unknown, options?: DeviceRequestOptions): Promise<{ payload: unknown }>
}
/** Main's job-runtime profile service, as CI runtime preparation and enrollment call it. */
export interface JobRuntimeProfiles {
  list(principal: ManagementPrincipal, workspaceId: string):
    Promise<{ profiles: { profile: JobRuntimeProfileRecord; ready: boolean }[] }>
  save(principal: ManagementPrincipal, source: 'http' | 'mcp', workspaceId: string,
    raw: JobRuntimeProfileSaveRecord): Promise<JobRuntimeProfileRecord>
  requestQualification(principal: ManagementPrincipal, source: 'http' | 'mcp', workspaceId: string,
    raw: unknown): Promise<{ id: string }>
  qualify(principal: ManagementPrincipal, source: 'http' | 'mcp', workspaceId: string, commandId: string,
    approvalId: string, options?: { signal?: AbortSignal }): Promise<JobRuntimeProfileRecord>
}
/** Main's source service, as CI runtime preparation calls it. */
export interface PostgresSourceService {
  approveProject(principal: ManagementPrincipal, input: { workspaceId: string; commandId: string; commit?: string }):
    Promise<{ manifest: SourceManifest }>
  rootList(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: unknown): Promise<{ items: SourceRootRecord[] }>
  bindRoot(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: unknown): Promise<{ value: SourceRootRecord }>
  publish(repository: string, commit: string, signal: AbortSignal): Promise<void>
}
export interface VersionedSetting<T> { value: T; versionId: string | null; revision: number }
/** Main's foundation settings, as the CircleCI account service reads and writes them. */
export interface CircleAccountSettings {
  getCircleAccounts(client?: pg.ClientBase): Promise<VersionedSetting<CircleAccounts>>
  updateCircleAccounts(value: CircleAccounts, expectedRevision: number | undefined, client: pg.ClientBase):
    Promise<VersionedSetting<CircleAccounts>>
}
/** A session-level Postgres lock that owns one CI operation until it is released or its connection is lost. */
export interface CiJobOwnership {
  readonly connection: { transaction<T>(work: (sql: GraphTransactionSql) => Promise<T>, readOnly?: boolean): Promise<T> }
  assertOwned(): void
  release(): Promise<void>
}
/** The journal reads that decide which CI job images a computer keeps. */
export interface CiImageJournal {
  jobOperations(): Promise<RemoteJobOperationReceiptRecord[]>
  jobNativeOwner(operationId: string): Promise<{ sourceReclamation?: unknown } | null>
}
export interface QualificationPathFingerprint {
  path: string; device: string; inode: string; mode: string; uid: string; gid: string; sha256: string | null
}
export interface JobProjectQuotaReading {
  projectId: number; hardLimitBytes: number; hardInodes: number; usedBytes: number; usedInodes: number
}
export interface CiRuntimeContextInput {
  repository: string
  commit?: string
  output: string
  offlineSeed?: {
    directory: string
    receiptPath: string
    unitCodex?: {
      path: string
      binarySha256: string
      version: string
      review: { reviewedByPrincipalId: string; decisionDigest: string; reviewedAt: string }
    }
  }
}
export interface CiLock { packages?: Record<string, { resolution: { integrity: string } }> }
export interface CiZipBudget { remaining(): number; check(): void }
export interface ZipEntry {
  name: string
  kind: 'file' | 'directory'
  compressedBytes: number
  uncompressedBytes: number
  compression: 'stored' | 'deflate'
}
export interface ParsedEntry extends ZipEntry { checksum: number; dataOffset: number }

/** Host services CI uses on Main and on Workers. */
export interface CiPlatform {
  componentLogger(component: LogComponent): CiLogger
  logIgnoredError(component: LogComponent, operation: string, error: unknown, context?: Record<string, unknown>,
    expected?: readonly string[]): void
  fallbackOnError<T>(fallback: T, component: LogComponent, operation: string, context?: Record<string, unknown>,
    expected?: readonly string[]): (error: unknown) => T
  fallbackOnMissing<T>(fallback: T): (error: unknown) => T
  trackService<T>(name: string, schedule: ServiceSchedule, work: () => Promise<T>, clock?: () => number): Promise<T>
  reportServiceFailure(name: string, error: unknown, now?: number): void
  failedReadObservation(previous: ReadObservation | undefined, error: unknown, message: string, now?: number): ReadObservation
  successfulReadObservation(now?: number): ReadObservation
  updateOperationalFailure(component: LogComponent, operation: string,
    details: Pick<OperationalFailure, 'elapsedMs' | 'selectedSource'>): void
  withTransaction<T>(pool: Pick<pg.Pool, 'connect'>, perform: (client: pg.PoolClient) => Promise<T>,
    options?: TransactionOptions): Promise<T>
  inTransaction<T>(pool: Pick<pg.Pool, 'connect'>, supplied: pg.ClientBase | undefined,
    perform: (client: pg.ClientBase) => Promise<T>): Promise<T>
  withCiDatabasePriority<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T>
  withoutCiDatabasePriority<T>(work: () => Promise<T>): Promise<T>
  withoutCiDatabaseReservation<T>(work: () => Promise<T>): Promise<T>
  withCiDatabaseReservation<T>(pool: object, work: () => Promise<T>): Promise<T>
  queueCiDatabaseWork<T>(pool: object, work: () => Promise<T>, kind: 'claim' | 'delivery'): Promise<T>
  withoutCiDatabaseDeadline<T>(work: () => Promise<T>): Promise<T>
  waitForCiDispatch<T>(work: () => Promise<T>): Promise<T>
  ensureClone(ports: GitWorktreePorts, repository: string, signal: AbortSignal): Promise<string>
  ensureCommit(ports: GitWorktreePorts, repository: string, commit: string, signal: AbortSignal): Promise<string>
  fetchRepositoryBranch(ports: GitWorktreePorts, clone: string, repository: string, branch: string, signal: AbortSignal,
    options?: { recoveryRef: string }): Promise<string>
  deepenUntilConnected(ports: GitWorktreePorts, clone: string, commits: string[], connected: () => Promise<boolean>,
    signal: AbortSignal): Promise<boolean>
  systemGitWorktreePorts(environment?: NodeJS.ProcessEnv): GitWorktreePorts
  snapshotAgentWorktree(ports: Pick<GitWorktreePorts, 'git'>, input: { path: string; baseCommit: string },
    signal: AbortSignal): Promise<AgentSnapshot>
  importAgentSnapshot(ports: Pick<GitWorktreePorts, 'git'>, clone: string, snapshot: AgentSnapshot,
    signal: AbortSignal): Promise<void>
  publishCommit(ports: GitWorktreePorts, repository: string, commit: string, signal: AbortSignal): Promise<void>
  gitFailure(code: 'SOURCE_WORKTREE_FAILED' | 'SOURCE_SNAPSHOT_FAILED', operation: string | undefined): DomainError
  sourceError(code: string, message: string, options?: ErrorOptions): DomainError
  isSourceError(error: unknown): error is DomainError
  withPrivateDirectoryLock<T>(root: FileHandle, work: (guard: FileHandle) => Promise<T>,
    options?: { nonBlocking?: boolean; signal?: AbortSignal | undefined }): Promise<T>
  isDeviceApplicationError(error: unknown): error is DeviceApplicationErrorLike
  isDeviceApplicationAdmissionError(error: unknown): error is DeviceApplicationAdmissionErrorLike
  isDeviceAccessError(error: unknown): error is DeviceAccessErrorLike
  isDeviceConnectionError(error: unknown): error is DeviceConnectionErrorLike
  identity(handle: FileHandle): Promise<{ device: string; inode: string; mountId: string }>
  openPrivateRoot(path: string, privateOnly?: boolean): Promise<FileHandle>
  openChildDirectory(parent: FileHandle, name: string, create?: boolean): Promise<FileHandle>
  fingerprintQualificationPath(path: string, executable?: boolean): Promise<QualificationPathFingerprint>
  readJobProjectQuota(pool: JobVerificationQuotaPool, directory: string, signal: AbortSignal): Promise<JobProjectQuotaReading>
  /** The CI runtime build context from the Worker artifact (`apps/worker/artifacts/ci-runtime/context.mjs`). */
  buildCiRuntimeContext(input: CiRuntimeContextInput): Promise<unknown>
  ciRuntimeInputDigest(input: { repository: string; commit: string }): Promise<string>
  parseCiLock(text: string): CiLock
  /** The verification runner's portions for one suite of the repository at `root`. */
  expectedPortions(root: string, suite: string): Array<{ key: string; kind: string }>
  paths: { watchdog: string }
}

/** Main-only services: authorization, computer settings and archive reading. */
export interface CiServerPorts {
  requireAuthorization(principal: ManagementPrincipal, action: ManagementAction, resource?: AuthorizedResource): void
  readComputerNames(sql: SqlQuery, mainId: string): Promise<ReadonlyMap<string, string>>
  workerBundleErrorMessage(readiness: WorkerBundleReadiness): string
  assertBuildComputerTarget(sql: SqlQuery, target: DeviceProvisioningTarget): Promise<void>
  /** A policy with the default settings, for an endpoint built without Main's live policy. */
  createWorkerExecutionPolicy(): CiWorkerExecutionPolicy
  readCircleAccounts(pool: pg.Pool, client?: pg.ClientBase): Promise<{ value: CircleAccounts; versionId: string | null; revision: number }>
  createZipBudget(): CiZipBudget
  parseZip(bytes: Buffer, budget: CiZipBudget): ParsedEntry[]
  decodeEntry(bytes: Buffer, entry: ParsedEntry, budget: CiZipBudget): Promise<Buffer>
  isAuthorized(principal: ManagementPrincipal, action: ManagementAction, resource?: AuthorizedResource, now?: Date): boolean
  intersectGrants(issued: ManagementGrant[], current: ManagementGrant[]): ManagementGrant[]
  currentOperatorAuthority(database: SqlQuery, id: string, atCommit?: boolean):
    Promise<{ principal: ManagementPrincipal; owner: ManagementPrincipal }>
  readLiveManagementPrincipal(client: SqlQuery, principalId: string): Promise<ManagementPrincipal>
  lockActiveWorkspace(client: SqlQuery, workspaceId: string): Promise<void>
  beforeGraphCommit(sql: GraphTransactionSql, finalize: () => Promise<void>): void
  readBuildComputerPreference(sql: SqlQuery, target: DeviceProvisioningTarget): Promise<BuildComputerPreference>
  deviceApplicationFailure(error: unknown): DeviceApplicationFailure
  acquireJobOwnership(pool: pg.Pool, executionId: string, onLost: () => void): Promise<CiJobOwnership | undefined>
}

let installedPlatform: CiPlatform | undefined
let installedServerPorts: CiServerPorts | undefined

export function installCiPlatform(platform: CiPlatform): void { installedPlatform = platform }
export function installCiServerPorts(ports: CiServerPorts): void { installedServerPorts = ports }

function platform(): CiPlatform {
  if (!installedPlatform) throw new Error('CI platform is not installed')
  return installedPlatform
}
function serverPorts(): CiServerPorts {
  if (!installedServerPorts) throw new Error('CI server ports are not installed')
  return installedServerPorts
}

/** Modules create their logger at load time, before the host installs the platform; each call resolves it. */
export function componentLogger(component: LogComponent): CiLogger {
  let resolved: { from: CiPlatform; logger: CiLogger } | undefined
  const current = () => {
    const from = platform()
    if (resolved?.from !== from) resolved = { from, logger: from.componentLogger(component) }
    return resolved.logger
  }
  return {
    debug: (...args) => current().debug(...args),
    info: (...args) => current().info(...args),
    warn: (...args) => current().warn(...args),
    error: (...args) => current().error(...args),
  }
}
export const logIgnoredError: CiPlatform['logIgnoredError'] = (...args) => platform().logIgnoredError(...args)
export const fallbackOnError: CiPlatform['fallbackOnError'] = (...args) => platform().fallbackOnError(...args)
export const fallbackOnMissing: CiPlatform['fallbackOnMissing'] = fallback => platform().fallbackOnMissing(fallback)
export const trackService: CiPlatform['trackService'] = (...args) => platform().trackService(...args)
export const reportServiceFailure: CiPlatform['reportServiceFailure'] = (...args) => platform().reportServiceFailure(...args)
export const failedReadObservation: CiPlatform['failedReadObservation'] = (...args) => platform().failedReadObservation(...args)
export const successfulReadObservation: CiPlatform['successfulReadObservation'] = now => platform().successfulReadObservation(now)
export const updateOperationalFailure: CiPlatform['updateOperationalFailure'] = (...args) =>
  platform().updateOperationalFailure(...args)
export const withTransaction: CiPlatform['withTransaction'] = (...args) => platform().withTransaction(...args)
export const inTransaction: CiPlatform['inTransaction'] = (...args) => platform().inTransaction(...args)
export const withCiDatabasePriority: CiPlatform['withCiDatabasePriority'] = (...args) => platform().withCiDatabasePriority(...args)
export const withoutCiDatabasePriority: CiPlatform['withoutCiDatabasePriority'] = work => platform().withoutCiDatabasePriority(work)
export const withoutCiDatabaseReservation: CiPlatform['withoutCiDatabaseReservation'] = work =>
  platform().withoutCiDatabaseReservation(work)
export const withCiDatabaseReservation: CiPlatform['withCiDatabaseReservation'] = (...args) =>
  platform().withCiDatabaseReservation(...args)
export const queueCiDatabaseWork: CiPlatform['queueCiDatabaseWork'] = (...args) => platform().queueCiDatabaseWork(...args)
export const withoutCiDatabaseDeadline: CiPlatform['withoutCiDatabaseDeadline'] = work => platform().withoutCiDatabaseDeadline(work)
export const waitForCiDispatch: CiPlatform['waitForCiDispatch'] = work => platform().waitForCiDispatch(work)
export const ensureClone: CiPlatform['ensureClone'] = (...args) => platform().ensureClone(...args)
export const ensureCommit: CiPlatform['ensureCommit'] = (...args) => platform().ensureCommit(...args)
export const fetchRepositoryBranch: CiPlatform['fetchRepositoryBranch'] = (...args) => platform().fetchRepositoryBranch(...args)
export const deepenUntilConnected: CiPlatform['deepenUntilConnected'] = (...args) => platform().deepenUntilConnected(...args)
export const systemGitWorktreePorts: CiPlatform['systemGitWorktreePorts'] = environment =>
  platform().systemGitWorktreePorts(environment)
export const snapshotAgentWorktree: CiPlatform['snapshotAgentWorktree'] = (...args) => platform().snapshotAgentWorktree(...args)
export const importAgentSnapshot: CiPlatform['importAgentSnapshot'] = (...args) => platform().importAgentSnapshot(...args)
export const publishCommit: CiPlatform['publishCommit'] = (...args) => platform().publishCommit(...args)
export const gitFailure: CiPlatform['gitFailure'] = (...args) => platform().gitFailure(...args)
export const sourceError: CiPlatform['sourceError'] = (...args) => platform().sourceError(...args)
export function isSourceError(error: unknown): error is DomainError { return platform().isSourceError(error) }
export const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
export const withPrivateDirectoryLock: CiPlatform['withPrivateDirectoryLock'] = (...args) =>
  platform().withPrivateDirectoryLock(...args)
export function isDeviceApplicationError(error: unknown): error is DeviceApplicationErrorLike {
  return platform().isDeviceApplicationError(error)
}
export function isDeviceApplicationAdmissionError(error: unknown): error is DeviceApplicationAdmissionErrorLike {
  return platform().isDeviceApplicationAdmissionError(error)
}
export function isDeviceAccessError(error: unknown): error is DeviceAccessErrorLike {
  return platform().isDeviceAccessError(error)
}
export function isDeviceConnectionError(error: unknown): error is DeviceConnectionErrorLike {
  return platform().isDeviceConnectionError(error)
}
export function anchored(handle: FileHandle, name = ''): string { return `/proc/self/fd/${handle.fd}${name ? `/${name}` : ''}` }
export const identity: CiPlatform['identity'] = handle => platform().identity(handle)
export const openPrivateRoot: CiPlatform['openPrivateRoot'] = (...args) => platform().openPrivateRoot(...args)
export const openChildDirectory: CiPlatform['openChildDirectory'] = (...args) => platform().openChildDirectory(...args)
export const fingerprintQualificationPath: CiPlatform['fingerprintQualificationPath'] = (...args) =>
  platform().fingerprintQualificationPath(...args)
export const readJobProjectQuota: CiPlatform['readJobProjectQuota'] = (...args) => platform().readJobProjectQuota(...args)
export const buildCiRuntimeContext: CiPlatform['buildCiRuntimeContext'] = input => platform().buildCiRuntimeContext(input)
export const ciRuntimeInputDigest: CiPlatform['ciRuntimeInputDigest'] = input => platform().ciRuntimeInputDigest(input)
export const parseCiLock: CiPlatform['parseCiLock'] = text => platform().parseCiLock(text)
export const expectedPortions: CiPlatform['expectedPortions'] = (...args) => platform().expectedPortions(...args)
export function watchdogPath(): string { return platform().paths.watchdog }

export const requireAuthorization: CiServerPorts['requireAuthorization'] = (...args) => serverPorts().requireAuthorization(...args)
export const readComputerNames: CiServerPorts['readComputerNames'] = (...args) => serverPorts().readComputerNames(...args)
export const workerBundleErrorMessage: CiServerPorts['workerBundleErrorMessage'] = readiness =>
  serverPorts().workerBundleErrorMessage(readiness)
export const assertBuildComputerTarget: CiServerPorts['assertBuildComputerTarget'] = (...args) =>
  serverPorts().assertBuildComputerTarget(...args)
export const isAuthorized: CiServerPorts['isAuthorized'] = (...args) => serverPorts().isAuthorized(...args)
export const intersectGrants: CiServerPorts['intersectGrants'] = (...args) => serverPorts().intersectGrants(...args)
export const currentOperatorAuthority: CiServerPorts['currentOperatorAuthority'] = (...args) =>
  serverPorts().currentOperatorAuthority(...args)
export const readLiveManagementPrincipal: CiServerPorts['readLiveManagementPrincipal'] = (...args) =>
  serverPorts().readLiveManagementPrincipal(...args)
export const lockActiveWorkspace: CiServerPorts['lockActiveWorkspace'] = (...args) => serverPorts().lockActiveWorkspace(...args)
export const beforeGraphCommit: CiServerPorts['beforeGraphCommit'] = (...args) => serverPorts().beforeGraphCommit(...args)
export const readBuildComputerPreference: CiServerPorts['readBuildComputerPreference'] = (...args) =>
  serverPorts().readBuildComputerPreference(...args)
export const deviceApplicationFailure: CiServerPorts['deviceApplicationFailure'] = error =>
  serverPorts().deviceApplicationFailure(error)
export const acquireJobOwnership: CiServerPorts['acquireJobOwnership'] = (...args) => serverPorts().acquireJobOwnership(...args)

const workerExecutionPolicies = new WeakMap<WorkerExecutionPolicy, CiWorkerExecutionPolicy>()
/** Main's policy with its default settings; a live policy from Main is passed in its place. */
export class WorkerExecutionPolicy {
  constructor() { workerExecutionPolicies.set(this, serverPorts().createWorkerExecutionPolicy()) }
  requireEnabled(host: { kind: 'main' | 'device' }): void { workerExecutionPolicies.get(this)!.requireEnabled(host) }
}
/** Reads the saved CircleCI accounts; only the read CI needs from Main's settings repository. */
export class PostgresFoundationSettingsRepository {
  readonly #pool: pg.Pool
  constructor(pool: pg.Pool) { this.#pool = pool }
  getCircleAccounts(client?: pg.ClientBase) { return serverPorts().readCircleAccounts(this.#pool, client) }
}
/** A ZIP time budget starts when it is created. */
export class Budget implements CiZipBudget {
  readonly #budget = serverPorts().createZipBudget()
  remaining(): number { return this.#budget.remaining() }
  check(): void { this.#budget.check() }
}
export const parseZip: CiServerPorts['parseZip'] = (...args) => serverPorts().parseZip(...args)
export const decodeEntry: CiServerPorts['decodeEntry'] = (...args) => serverPorts().decodeEntry(...args)
