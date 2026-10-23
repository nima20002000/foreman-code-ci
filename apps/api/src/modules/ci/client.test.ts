import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { CiRunRecordSchema } from '@foreman-code/contracts'
import { ManagementPrincipalSchema } from '@foreman-code/contracts/management'
import { DomainError } from '@foreman-code/contracts/server-kit'
import type { CiServiceClient } from './types.js'
import { createCiHttpTransport } from './client.js'
import { deferred } from '../../../test/helpers/deferred.js'
import { publicFailureClass } from '../errors.js'

const caller = ManagementPrincipalSchema.parse({ id: 'worker-1', name: 'Agent', audience: 'worker', agentId: 'agent-1',
  grants: [], expiresAt: '9999-12-31T23:59:59.999Z', revokedAt: null })
const run = CiRunRecordSchema.parse({ id: '00000000-0000-4000-8000-000000000001', groupId: '00000000-0000-4000-8000-000000000002', workspaceId: 'workspace-1',
  suite: 'unit', commit: 'a'.repeat(40), repository: 'owner/repo', partition: null, state: 'canceled',
  computer: null, step: null, exitCode: null, message: null,
  queuedAt: '2026-10-23T00:00:00.000Z', startedAt: null, finishedAt: '2026-10-23T00:01:00.000Z',
  initiator: { principalId: caller.id, executionId: 'execution-1' } })
const transports: Awaited<ReturnType<typeof createCiHttpTransport>>[] = []
afterEach(async () => {
  await Promise.all(transports.splice(0).map(transport => transport.close()))
  vi.restoreAllMocks()
})
async function connect(service: Partial<CiServiceClient>) {
  const transport = await createCiHttpTransport(service as CiServiceClient)
  transports.push(transport)
  return transport.client
}

it('preserves caller identity, inferred workspace and audit sources through the production HTTP transport', async () => {
  const start = vi.fn<CiServiceClient['run']>().mockResolvedValue({ ticketId: run.id })
  const cancel = vi.fn<CiServiceClient['cancel']>().mockResolvedValue({ run, detached: { remainingRequesters: 1 } })
  const client = await connect({ run: start, cancel })
  const input = { suite: 'unit' as const, scope: 'affected' as const, files: ['apps/ci/test/ciClient.test.ts'],
    commit: 'b'.repeat(40), commandId: 'start-1', noSupersede: true }
  expect(await client.run(caller, input)).toEqual({ ticketId: run.id })
  expect(start).toHaveBeenLastCalledWith(caller, input, 'mcp')
  await client.run(caller, { ...input, workspaceId: run.workspaceId }, 'http')
  expect(start).toHaveBeenLastCalledWith(caller, { ...input, workspaceId: run.workspaceId }, 'http')
  const cancellation = { ticketId: run.id, commandId: 'cancel-1' }
  expect(await client.cancel(caller, cancellation)).toEqual({ run, detached: { remainingRequesters: 1 } })
  expect(cancel).toHaveBeenLastCalledWith(caller, cancellation, 'mcp')
  await client.cancel(caller, { ...cancellation, workspaceId: run.workspaceId }, 'http')
  expect(cancel).toHaveBeenLastCalledWith(caller, { ...cancellation, workspaceId: run.workspaceId }, 'http')
})

it('preserves read options, structured results and service errors', async () => {
  const get = vi.fn<CiServiceClient['get']>().mockResolvedValue({ run, tests: null })
  const tests = vi.fn<CiServiceClient['tests']>().mockResolvedValue({ ticketId: run.id, tests: null })
  const list = vi.fn<CiServiceClient['list']>().mockResolvedValue({ runId: 'run-1', jobs: [], truncated: false })
  const logs = vi.fn<CiServiceClient['logs']>().mockResolvedValue({ text: 'tail', nextOffset: 4, logBytes: 4, maxBytes: 20 })
  const computers = vi.fn<CiServiceClient['computers']>().mockResolvedValue({ computers: [] })
  const client = await connect({ get, tests, list, logs, computers })
  const read = { ticketId: run.id, waitUntil: 'group-terminal' as const, waitSeconds: 30,
    logTail: false, testStatus: ['failed' as const, 'skipped' as const] }
  expect(await client.get(caller, read)).toEqual({ run, tests: null })
  expect(get).toHaveBeenCalledWith(caller, read, expect.any(AbortSignal))
  expect(await client.tests(caller, { ticketId: run.id, status: ['failed'] })).toEqual({ ticketId: run.id, tests: null })
  expect(tests).toHaveBeenCalledWith(caller, { ticketId: run.id, status: ['failed'] })
  expect(await client.list(caller, { runId: 'run-1', executionId: 'execution-1' }))
    .toEqual({ runId: 'run-1', jobs: [], truncated: false })
  expect(list).toHaveBeenCalledWith(caller, { runId: 'run-1', executionId: 'execution-1' })
  expect(await client.logs(caller, { ticketId: run.id, afterOffset: 0, maxBytes: 20, group: true }))
    .toEqual({ text: 'tail', nextOffset: 4, logBytes: 4, maxBytes: 20 })
  expect(logs).toHaveBeenCalledWith(caller, { ticketId: run.id, afterOffset: 0, maxBytes: 20, group: true })
  expect(await client.computers(caller, {})).toEqual({ computers: [] })
  expect(computers).toHaveBeenCalledWith(caller, {})
  const failure = new DomainError('ACCESS_DENIED', 'Denied.', 403, { reason: 'revoked' })
  failure.denialAudited = true
  get.mockRejectedValueOnce(failure)
  await expect(client.get(caller, read)).rejects.toMatchObject({ code: failure.code, status: failure.status,
    message: failure.message, details: failure.details, denialAudited: true })
  get.mockRejectedValueOnce(Object.assign(new Error('connection admission'), { code: '53300' }))
  await expect(client.get(caller, read)).rejects.toMatchObject({ code: 'DATABASE_BUSY', status: 503,
    details: { retryable: true, newCommandRequired: false } })
})

it('carries dispatch, stopped Run cleanup and the exact sweep instant over authenticated service routes', async () => {
  const dispatch = vi.fn<CiServiceClient['dispatch']>().mockResolvedValue()
  const cancelStoppedRun = vi.fn<CiServiceClient['cancelStoppedRun']>().mockResolvedValue()
  const expireOverdueRuns = vi.fn<CiServiceClient['expireOverdueRuns']>().mockResolvedValue(3)
  const client = await connect({ dispatch, cancelStoppedRun, expireOverdueRuns })
  await client.dispatch()
  await client.cancelStoppedRun('run-1')
  const now = new Date('2026-10-23T12:34:56.789Z')
  expect(await client.expireOverdueRuns(now)).toBe(3)
  expect(dispatch).toHaveBeenCalledOnce()
  expect(cancelStoppedRun).toHaveBeenCalledExactlyOnceWith('run-1')
  expect(expireOverdueRuns).toHaveBeenCalledExactlyOnceWith(now)
})

it('rejects missing or wrong service credentials before invoking CI', async () => {
  const fetcher = vi.spyOn(globalThis, 'fetch')
  const dispatch = vi.fn<CiServiceClient['dispatch']>().mockResolvedValue()
  const client = await connect({ dispatch })
  await client.dispatch()
  const [url] = fetcher.mock.calls[0]!
  for (const authorization of [undefined, 'Bearer wrong']) {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json',
      ...(authorization ? { authorization } : {}) }, body: '{}' })
    expect(response.status).toBe(401)
    expect(await response.json()).toMatchObject({ error: { code: 'AUTHENTICATION_REQUIRED' } })
  }
  expect(dispatch).toHaveBeenCalledOnce()
})

it('aborts the service wait when the HTTP client cancels its request', async () => {
  const entered = deferred()
  const aborted = deferred()
  const client = await connect({ get: async (_caller, _input, signal) => {
    entered.resolve()
    await new Promise<void>(resolve => signal!.addEventListener('abort', () => { aborted.resolve(); resolve() }, { once: true }))
    return { run }
  } })
  const controller = new AbortController()
  const result = client.get(caller, { ticketId: run.id, waitUntil: 'group-terminal', waitSeconds: 60 }, controller.signal)
  const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
  await entered.promise
  controller.abort()
  await Promise.all([rejected, aborted.promise])
})

it('retains non-domain failure kinds so HTTP and MCP keep their existing error responses', async () => {
  const get = vi.fn<CiServiceClient['get']>()
  const client = await connect({ get })
  get.mockRejectedValueOnce(Object.assign(new Error('private backend failure'), { class: 'transient' }))
  const internal = await client.get(caller, { ticketId: run.id }).catch(error => error)
  expect(internal).toBeInstanceOf(Error)
  expect(internal).not.toBeInstanceOf(DomainError)
  expect(publicFailureClass(internal)).toBe('transient')
  const invalid = z.object({ state: z.literal('running') }).safeParse({ state: 'private invalid state' })
  if (invalid.success) throw new Error('Expected the invalid fixture to fail validation.')
  get.mockRejectedValueOnce(invalid.error)
  const validation = await client.get(caller, { ticketId: run.id }).catch(error => error)
  expect(validation).toBeInstanceOf(z.ZodError)
  expect(validation.issues).toEqual(invalid.error.issues)
})
