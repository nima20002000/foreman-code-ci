import { constants } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import type pg from 'pg'
import type { OperationalFailure, ReadObservation } from '@foreman-code/contracts'
import type { WorkerBundleReadiness } from '@foreman-code/contracts/computer-maintenance'
import type { DeviceApplicationResult, DeviceNegotiatedExtension, DeviceRequestPriority } from '@foreman-code/contracts/device-application'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { FailureClass } from '@foreman-code/contracts/failure'
import type { CircleAccounts, ManagementAction, ManagementPrincipal } from '@foreman-code/contracts/management'
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
export function watchdogPath(): string { return platform().paths.watchdog }

export const requireAuthorization: CiServerPorts['requireAuthorization'] = (...args) => serverPorts().requireAuthorization(...args)
export const readComputerNames: CiServerPorts['readComputerNames'] = (...args) => serverPorts().readComputerNames(...args)
export const workerBundleErrorMessage: CiServerPorts['workerBundleErrorMessage'] = readiness =>
  serverPorts().workerBundleErrorMessage(readiness)
export const assertBuildComputerTarget: CiServerPorts['assertBuildComputerTarget'] = (...args) =>
  serverPorts().assertBuildComputerTarget(...args)

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
