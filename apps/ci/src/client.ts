// CI's ticket operations as a client. The product calls CI through CiTicketClient and does not care whether CI runs in
// its own process (HostCiService, the in-process transport) or behind the CI HTTP routes (HttpCiClient).
import { ApiErrorResponseSchema, CiCancelOutputSchema, CiComputersOutputSchema, CiGetOutputSchema, CiListOutputSchema,
  CiLogsOutputSchema, CiRunOutputSchema, CiTestsOutputSchema } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { DomainError } from '@foreman-code/contracts/server-kit'
import { z } from 'zod'
import type { HostCiService } from './service.js'

/** The calls the product makes to start, read and cancel CI tickets. HostCiService implements it in process. */
export type CiTicketClient = Pick<HostCiService, 'run' | 'get' | 'tests' | 'list' | 'logs' | 'cancel' | 'computers'>
export type CiServiceClient = CiTicketClient & Pick<HostCiService, 'dispatch' | 'cancelStoppedRun' | 'expireOverdueRuns'>

type Result<K extends keyof CiTicketClient> = Awaited<ReturnType<CiTicketClient[K]>>
type Input<K extends keyof CiTicketClient> = Parameters<CiTicketClient[K]>[1]
type HeaderMap = Record<string, string>

export interface HttpCiClientOptions {
  /** Where the CI routes are served, e.g. `http://127.0.0.1:3041`. */
  baseUrl: string
  /** Credentials that make the CI routes authenticate this caller; the routes authorize the principal themselves. */
  headers(caller: ManagementPrincipal): HeaderMap | Promise<HeaderMap>
  /** Private service routes preserve workspace inference and the original audit source. */
  service?: { headers(): HeaderMap | Promise<HeaderMap> }
  fetch?: typeof fetch
}

/** CiTicketClient over the CI HTTP routes (`registerHostCiRoutes`). Every ticket call is addressed by workspace. */
export class HttpCiClient implements CiServiceClient {
  private readonly fetcher: typeof fetch

  constructor(private readonly options: HttpCiClientOptions) {
    this.fetcher = options.fetch ?? fetch
  }

  async run(caller: ManagementPrincipal, input: Input<'run'>, source: 'mcp' | 'http' = 'mcp'): Promise<Result<'run'>> {
    if (this.options.service) return await this.serviceCall('run', CiRunOutputSchema, { input, source }, caller) as Result<'run'>
    const { workspaceId, ...body } = input
    return await this.send(caller, 'POST', this.root(workspaceId), CiRunOutputSchema, { body }) as Result<'run'>
  }

  async get(caller: ManagementPrincipal, input: Input<'get'>, signal?: AbortSignal): Promise<Result<'get'>> {
    if (this.options.service) return await this.serviceCall('get', CiGetOutputSchema, { input }, caller, signal) as Result<'get'>
    const { workspaceId, ticketId, testStatus, ...rest } = input
    return await this.send(caller, 'GET', `${this.root(workspaceId)}/${ticketId}`, CiGetOutputSchema, {
      query: { ...rest, ...(testStatus ? { testStatus: testStatus.join(',') } : {}) }, signal,
    }) as Result<'get'>
  }

  async tests(caller: ManagementPrincipal, input: Input<'tests'>): Promise<Result<'tests'>> {
    if (this.options.service) return await this.serviceCall('tests', CiTestsOutputSchema, { input }, caller) as Result<'tests'>
    return await this.send(caller, 'GET', `${this.root(input.workspaceId)}/${input.ticketId}/tests`, CiTestsOutputSchema, {
      query: input.status ? { status: input.status.join(',') } : {},
    }) as Result<'tests'>
  }

  async list(caller: ManagementPrincipal, input: Input<'list'>): Promise<Result<'list'>> {
    if (this.options.service) return await this.serviceCall('list', CiListOutputSchema, { input }, caller) as Result<'list'>
    const { workspaceId, ...query } = input
    return await this.send(caller, 'GET', this.root(workspaceId), CiListOutputSchema, { query }) as Result<'list'>
  }

  async logs(caller: ManagementPrincipal, input: Input<'logs'>): Promise<Result<'logs'>> {
    if (this.options.service) return await this.serviceCall('logs', CiLogsOutputSchema, { input }, caller) as Result<'logs'>
    const { workspaceId, ticketId, ...query } = input
    return await this.send(caller, 'GET', `${this.root(workspaceId)}/${ticketId}/logs`, CiLogsOutputSchema, { query }) as Result<'logs'>
  }

  async cancel(caller: ManagementPrincipal, input: Input<'cancel'>, source: 'mcp' | 'http' = 'mcp'): Promise<Result<'cancel'>> {
    if (this.options.service) return await this.serviceCall('cancel', CiCancelOutputSchema, { input, source }, caller) as Result<'cancel'>
    const { workspaceId, ticketId, ...query } = input
    return await this.send(caller, 'DELETE', `${this.root(workspaceId)}/${ticketId}`, CiCancelOutputSchema, { query }) as Result<'cancel'>
  }

  async computers(caller: ManagementPrincipal, input: Input<'computers'>): Promise<Result<'computers'>> {
    if (this.options.service) return await this.serviceCall('computers', CiComputersOutputSchema, { input }, caller) as Result<'computers'>
    return await this.send(caller, 'GET', `${this.root(input.workspaceId)}/computers`, CiComputersOutputSchema, {}) as Result<'computers'>
  }

  async dispatch(): Promise<void> {
    await this.serviceCall('dispatch', z.object({}).strict(), {})
  }

  async cancelStoppedRun(runId: string): Promise<void> {
    await this.serviceCall('cancel-stopped-run', z.object({}).strict(), { runId })
  }

  async expireOverdueRuns(now = new Date()): Promise<number> {
    return await this.serviceCall('expire-overdue-runs', z.number().int().nonnegative(), { now: now.toISOString() }) as number
  }

  private async serviceCall(operation: string, schema: z.ZodType, body: Record<string, unknown>,
    caller?: ManagementPrincipal, signal?: AbortSignal): Promise<unknown> {
    if (!this.options.service) throw new DomainError('CI_SERVICE_REQUIRED', 'This operation requires the private CI service transport.', 500)
    return this.send(caller, 'POST', `/internal/ci/${operation}`, schema, {
      body: { ...body, ...(caller ? { caller } : {}) }, signal, headers: await this.options.service.headers(),
    })
  }

  private root(workspaceId: string | undefined): string {
    if (!workspaceId) throw new DomainError('CI_WORKSPACE_REQUIRED', 'CI over HTTP is addressed by workspace.', 400)
    return `/api/management/workspaces/${encodeURIComponent(workspaceId)}/ci`
  }

  private async send(caller: ManagementPrincipal | undefined, method: string, path: string, schema: z.ZodType,
    { query = {}, body, signal, headers = {} }: { query?: Record<string, unknown>; body?: unknown;
      signal?: AbortSignal | undefined; headers?: HeaderMap }): Promise<unknown> {
    const url = new URL(path, this.options.baseUrl)
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value))
    const response = await this.fetcher(url, {
      method, ...(signal ? { signal } : {}),
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(caller ? await this.options.headers(caller) : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    let payload: unknown
    // ignore: a body that is not JSON is reported through the status below.
    try { payload = text ? JSON.parse(text) : undefined } catch { payload = undefined }
    if (!response.ok) {
      const failure = ApiErrorResponseSchema.safeParse(payload)
      if (this.options.service) {
        const kind = response.headers.get('x-ci-error-kind')
        const issues = failure.success ? failure.data.error.details?.issues : undefined
        if (kind === 'validation' && Array.isArray(issues)) throw new z.ZodError(issues as z.core.$ZodIssue[])
        if (kind === 'internal') {
          const error = new Error('CI request failed.')
          const failureClass = response.headers.get('x-ci-failure-class')
          if (failureClass === 'transient' || failureClass === 'cancelled') Object.assign(error, { class: failureClass })
          throw error
        }
      }
      const error = failure.success
        ? new DomainError(failure.data.error.code, failure.data.error.message, response.status, failure.data.error.details)
        : new DomainError('CI_UNAVAILABLE', `CI answered HTTP ${response.status}.`, response.status >= 500 ? response.status : 502)
      if (this.options.service && response.headers.get('x-ci-denial-audited') === 'true') error.denialAudited = true
      throw error
    }
    return schema.parse(payload)
  }
}
