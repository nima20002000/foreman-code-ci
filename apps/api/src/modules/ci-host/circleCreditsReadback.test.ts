import Fastify from 'fastify'
import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import { CiComputersOutputSchema } from '@foreman-code/contracts'
import type { CircleCreditAllowance } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { registerGraphqlMcp } from '../../mcp/unified/transport.js'
import type { OperatorServices } from '../../mcp/operator/types.js'
import { PostgresAccessService } from '../access/postgres.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { CI_GET_ACTIONS, type CiAuthority } from '../jobs/ciAuthority.js'
import { CircleCreditUsage } from './circleCredits.js'
import { CloudHttp } from './cloudHttp.js'
import type { HostCiPorts } from './runner.js'
import { HostCiService, type CiCommits } from './service.js'
import type { HostCiComputer, HostCiEndpoint } from './serviceTypes.js'

const ports: HostCiPorts = { run: async () => ({ code: 1, stdout: '', stderr: '' }), now: () => new Date(),
  cpus: 4, memoryBytes: 2 ** 30 }
const userSystemd = { supported: true, reason: null }
const slot = (account: string | undefined, index: number): HostCiComputer => ({
  key: `fixture-main:cloud:circleci${account ? `@${account}` : ''}:${index}`,
  hostRef: { kind: 'cloud', mainId: 'fixture-main', provider: 'circleci', ...(account ? { account } : {}), slot: index },
  label: `CircleCI ${account ?? 'primary'} ${index + 1}`, priority: 30, userSystemd })
const github: HostCiComputer = { key: 'fixture-main:cloud:github:0', label: 'GitHub Actions 1', priority: 30, userSystemd,
  hostRef: { kind: 'cloud', mainId: 'fixture-main', provider: 'github', slot: 0 } }

it('reads the estimated CircleCI credits per account through authenticated ci_computers_list from one cached usage read', async () => {
  const requests: string[] = []
  const circleFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}`)
    const json = (body: unknown) => new Response(JSON.stringify(body))
    if (url.pathname === '/api/v2/me/collaborations') return json([{ id: 'org-acme', name: 'acme', vcs_type: 'github' }])
    if (init?.method === 'POST') return json({ usage_export_job_id: 'job-1', state: 'created' })
    if (url.pathname.endsWith('/job-1')) return json({ state: 'completed', download_urls: ['https://signed.example/a.csv'] })
    return new Response('project_name,total_credits\nsite,5690\n')
  }
  const allowance: CircleCreditAllowance = { defaultMonthlyCredits: 30000, accounts: {} }
  const credits = new CircleCreditUsage(new CloudHttp(ports, 'circleci', { fetch: circleFetch, circleToken: async () => 'fixture-token' }),
    { allowance: async () => allowance, primaryOwner: async () => null }, { pollMs: 1 })
  const endpoint: HostCiEndpoint = {
    computers: async () => [slot('acme', 0), slot('acme', 1), slot(undefined, 0), github],
    request: async () => ({ operation: 'status', ready: true, reasons: [], cpuCount: 4, memoryBytes: 2 ** 30,
      slotsUsed: 0, slotsTotal: 1, runs: [] }),
  }
  const pool = { query: async () => ({ rows: [] }) } as unknown as pg.Pool
  const caller: ManagementPrincipal = { id: 'fixture-reader', name: 'Fixture reader', audience: 'operator',
    grants: [{ actions: CI_GET_ACTIONS, scope: { workspaceIds: ['fixture-workspace'] } }],
    expiresAt: '9999-12-31T23:59:59.999Z', revokedAt: null }
  const authority: CiAuthority = { resolve: async principal => {
    if (!principal.grants.length) throw new DomainError('ACCESS_DENIED', 'CI read denied.', 403)
    return { principal, workspaceId: 'fixture-workspace' }
  } }
  const ci = new HostCiService(pool, new PostgresCommandCoordinator(pool), authority, {} as CiCommits, endpoint,
    undefined, { circleCredits: credits })
  const access = new PostgresAccessService(pool)
  vi.spyOn(access, 'authenticate').mockImplementation(async token =>
    token === 'reader' ? caller : { ...caller, id: 'fixture-denied', grants: [] })
  const app = Fastify()
  registerGraphqlMcp(app, { access, operator: { ci,
    commands: { recordDenied: async () => undefined } } as unknown as OperatorServices })
  const call = async (token: string) => {
    const response = await app.inject({ method: 'POST', url: '/mcp',
      headers: { authorization: `Bearer ${token}`, accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ci_computers_list',
        arguments: { workspaceId: 'fixture-workspace' } } } })
    const data = response.body.split('\n').find(line => line.startsWith('data: '))
    return data ? JSON.parse(data.slice(6)) : response.json()
  }
  const list = async () => CiComputersOutputSchema.parse(decodeMcpToolResult((await call('reader')).result)).computers
  try {
    const denied = await call('denied')
    expect(denied.result?.isError ?? Boolean(denied.error)).toBe(true)
    const first = await list()
    expect(first.find(computer => computer.label === 'CircleCI acme 1')).toMatchObject({ credits: null,
      creditsUnavailable: expect.any(String) })
    await vi.waitFor(async () => {
      expect((await list()).find(computer => computer.label === 'CircleCI acme 1')?.credits).toMatchObject(
        { total: 30000, used: 5690, remaining: 24310 })
    })
    const computers = await list()
    for (const label of ['CircleCI acme 1', 'CircleCI acme 2']) {
      expect(computers.find(computer => computer.label === label)?.credits).toMatchObject({ remaining: 24310 })
    }
    // The primary org's owner is unknown here, and GitHub Actions has no CircleCI credits.
    expect(computers.find(computer => computer.label === 'CircleCI primary 1')).toMatchObject({ credits: null })
    expect(computers.find(computer => computer.label === 'GitHub Actions 1')).not.toHaveProperty('credits')
    expect(requests.filter(request => request.startsWith('POST'))).toHaveLength(1)
  } finally {
    await ci.close()
    await app.close()
  }
})
