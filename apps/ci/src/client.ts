// CI's ticket operations as a client. The product calls CI through CiTicketClient and does not care whether CI runs in
// its own process (HostCiService, the in-process transport) or behind the CI HTTP routes (HttpCiClient).
import { ApiErrorResponseSchema, CiCancelOutputSchema, CiComputersOutputSchema, CiGetOutputSchema, CiListOutputSchema,
  CiLogsOutputSchema, CiRunOutputSchema, CiTestsOutputSchema } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { DomainError } from '@foreman-code/contracts/server-kit'
import type { z } from 'zod'
import type { HostCiService } from './service.js'

/** The calls the product makes to start, read and cancel CI tickets. HostCiService implements it in process. */
export type CiTicketClient = Pick<HostCiService, 'run' | 'get' | 'tests' | 'list' | 'logs' | 'cancel' | 'computers'>

type Result<K extends keyof CiTicketClient> = Awaited<ReturnType<CiTicketClient[K]>>
type Input<K extends keyof CiTicketClient> = Parameters<CiTicketClient[K]>[1]
type HeaderMap = Record<string, string>

export interface HttpCiClientOptions {
  /** Where the CI routes are served, e.g. `http://127.0.0.1:3041`. */
  baseUrl: string
  /** Credentials that make the CI routes authenticate this caller; the routes authorize the principal themselves. */
  headers(caller: ManagementPrincipal): HeaderMap | Promise<HeaderMap>
  fetch?: typeof fetch
}

/** CiTicketClient over the CI HTTP routes (`registerHostCiRoutes`). Every ticket call is addressed by workspace. */
export class HttpCiClient implements CiTicketClient {
  private readonly fetcher: typeof fetch

  constructor(private readonly options: HttpCiClientOptions) {
    this.fetcher = options.fetch ?? fetch
  }

  async run(caller: ManagementPrincipal, input: Input<'run'>): Promise<Result<'run'>> {
    const { workspaceId, ...body } = input
    return await this.send(caller, 'POST', this.root(workspaceId), CiRunOutputSchema, { body }) as Result<'run'>
  }

  async get(caller: ManagementPrincipal, input: Input<'get'>, signal?: AbortSignal): Promise<Result<'get'>> {
    const { workspaceId, ticketId, testStatus, ...rest } = input
    return await this.send(caller, 'GET', `${this.root(workspaceId)}/${ticketId}`, CiGetOutputSchema, {
      query: { ...rest, ...(testStatus ? { testStatus: testStatus.join(',') } : {}) }, signal,
    }) as Result<'get'>
  }

  async tests(caller: ManagementPrincipal, input: Input<'tests'>): Promise<Result<'tests'>> {
    return await this.send(caller, 'GET', `${this.root(input.workspaceId)}/${input.ticketId}/tests`, CiTestsOutputSchema, {
      query: input.status ? { status: input.status.join(',') } : {},
    }) as Result<'tests'>
  }

  async list(caller: ManagementPrincipal, input: Input<'list'>): Promise<Result<'list'>> {
    const { workspaceId, ...query } = input
    return await this.send(caller, 'GET', this.root(workspaceId), CiListOutputSchema, { query }) as Result<'list'>
  }

  async logs(caller: ManagementPrincipal, input: Input<'logs'>): Promise<Result<'logs'>> {
    const { workspaceId, ticketId, ...query } = input
    return await this.send(caller, 'GET', `${this.root(workspaceId)}/${ticketId}/logs`, CiLogsOutputSchema, { query }) as Result<'logs'>
  }

  /** The audit source of a cancellation over HTTP is always `http`; the argument only exists for the shared interface. */
  async cancel(caller: ManagementPrincipal, input: Input<'cancel'>): Promise<Result<'cancel'>> {
    const { workspaceId, ticketId, ...query } = input
    return await this.send(caller, 'DELETE', `${this.root(workspaceId)}/${ticketId}`, CiCancelOutputSchema, { query }) as Result<'cancel'>
  }

  async computers(caller: ManagementPrincipal, input: Input<'computers'>): Promise<Result<'computers'>> {
    return await this.send(caller, 'GET', `${this.root(input.workspaceId)}/computers`, CiComputersOutputSchema, {}) as Result<'computers'>
  }

  private root(workspaceId: string | undefined): string {
    if (!workspaceId) throw new DomainError('CI_WORKSPACE_REQUIRED', 'CI over HTTP is addressed by workspace.', 400)
    return `/api/management/workspaces/${encodeURIComponent(workspaceId)}/ci`
  }

  private async send(caller: ManagementPrincipal, method: string, path: string, schema: z.ZodType,
    { query = {}, body, signal }: { query?: Record<string, unknown>; body?: unknown; signal?: AbortSignal | undefined }): Promise<unknown> {
    const url = new URL(path, this.options.baseUrl)
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value))
    const response = await this.fetcher(url, {
      method, ...(signal ? { signal } : {}),
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...await this.options.headers(caller) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await response.text()
    let payload: unknown
    // ignore: a body that is not JSON is reported through the status below.
    try { payload = text ? JSON.parse(text) : undefined } catch { payload = undefined }
    if (!response.ok) {
      const failure = ApiErrorResponseSchema.safeParse(payload)
      throw failure.success
        ? new DomainError(failure.data.error.code, failure.data.error.message, response.status, failure.data.error.details)
        : new DomainError('CI_UNAVAILABLE', `CI answered HTTP ${response.status}.`, response.status >= 500 ? response.status : 502)
    }
    return schema.parse(payload)
  }
}
