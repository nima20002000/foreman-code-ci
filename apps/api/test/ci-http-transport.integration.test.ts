import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { CiCancelOutputSchema, CiGetOutputSchema, CiRunOutputSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { createCiHttpTransport } from '../src/modules/ci/client.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS } from '../src/modules/jobs/ciAuthority.js'
import { fixture } from './helpers/hostCiMcpFixture.js'

it('keeps HTTP and MCP ticket behavior, persisted records, audit sources and live authorization across the CI transport', async () => {
  const f = await fixture()
  const transport = await createCiHttpTransport(f.ci)
  const access = new PostgresAccessService(f.pool)
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands: new PostgresCommandCoordinator(f.pool), ci: transport.client } as never },
  })
  const mcp = new Client({ name: 'ci-http-transport-test', version: '1' })
  try {
    const credential = await f.credential([...CI_RUN_ACTIONS, ...CI_GET_ACTIONS])
    const url = `/api/management/workspaces/${f.workspaceId}/ci`
    const headers = { authorization: `Bearer ${credential.token}` }
    const input = { suite: 'unit', scope: 'affected', files: ['apps/api/test/example.test.ts'],
      commit: 'a'.repeat(40), commandId: 'http-start' }
    const started = await app.inject({ method: 'POST', url, headers, payload: input })
    expect(started.statusCode).toBe(200)
    const ticket = CiRunOutputSchema.parse(started.json())
    const replay = await app.inject({ method: 'POST', url, headers, payload: input })
    expect(replay.statusCode).toBe(200)
    expect(CiRunOutputSchema.parse(replay.json())).toEqual(ticket)
    await transport.client.dispatch()
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    await mcp.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { requestInit: { headers } }))
    const read = await mcp.callTool({ name: 'ci_get', arguments: { workspaceId: f.workspaceId,
      ticketId: ticket.ticketId, logTail: false } })
    expect(read.isError).not.toBe(true)
    const result = CiGetOutputSchema.parse(decodeMcpToolResult(read))
    const persisted = (await f.pool.query<{ record: unknown }>('select record from ci_runs where id=$1', [ticket.ticketId])).rows[0]!
    expect(result.run).toEqual(persisted.record)
    const canceled = await mcp.callTool({ name: 'ci_cancel', arguments: { workspaceId: f.workspaceId,
      ticketId: ticket.ticketId, commandId: 'mcp-cancel' } })
    expect(canceled.isError).not.toBe(true)
    expect(CiCancelOutputSchema.parse(decodeMcpToolResult(canceled)).run.state).toBe('canceled')
    const audit = (await f.pool.query<{ action: string; source: string }>(
      "select action,source from management_audit where principal_id=$1 and action in ('ci.run','ci.cancel') order by sequence",
      [credential.principal.id])).rows
    expect(audit).toEqual([{ action: 'ci.run', source: 'http' }, { action: 'ci.cancel', source: 'mcp' }])
    await access.revoke(credential.principal.id)
    await expect(transport.client.get(credential.principal, { workspaceId: f.workspaceId, ticketId: ticket.ticketId }))
      .rejects.toMatchObject({ status: 401 })
  } finally {
    await mcp.close()
    await app.close()
    await transport.close()
    await f.close()
  }
})
