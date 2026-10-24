import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, it, vi } from 'vitest'
import { ManagementPrincipalSchema } from '@foreman-code/contracts/management'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/current'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { RunBoardSnapshotSchema } from '@foreman-code/contracts/run-snapshots'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import { RunHistoryService } from '../src/modules/runs/history.js'
import { RunnerAdmission } from '../src/modules/runs/runnerAdmission.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { liveAuthorityQuery, livePrincipalRow } from './helpers/livePrincipal.js'

it('reads live queue reasons through authenticated Board MCP and denies an unauthorized caller', async () => {
  const f = makeCurrentWorkflowFixture('queue-read', 'single')
  const scope = { workspaceId: f.run.workspaceId, workflowId: f.run.workflowId, runId: f.run.id }
  const principal = ManagementPrincipalSchema.parse({ id: 'queue-reader', name: 'Queue reader', audience: 'operator',
    revokedAt: null, expiresAt: '2099-01-01T00:00:00.000Z', grants: [{ actions: ['runs:read'], scope: {
      workspaceIds: [scope.workspaceId], workflowIds: [scope.workflowId], runIds: [scope.runId],
    } }] })
  const denied = { ...principal, id: 'denied-reader', grants: [] }
  const snapshot = RunBoardSnapshotSchema.parse({ ...scope, kind: 'available', workflowVersionId: f.version.id,
    capturedAt: f.createdAt, edges: [], nodes: [{ id: f.identities[0]!.workflowNodeId, name: 'Worker',
      agentId: f.identities[0]!.agentId, agentConfigurationVersionId: f.configurations[0]!.id,
      position: { x: 0, y: 0 }, size: { width: 208, height: 112 } }] })
  const pool = new pg.Pool()
  // Reads are told apart by their bound values: a principal id is the live authority read, the Run scope (workspace,
  // workflow, Run) is the Run and snapshot read, the Run and workspace are the CI read, and the version id with the
  // workspace and workflow is the saved version read.
  const query = vi.fn(liveAuthorityQuery(() => livePrincipalRow(principal), async (text, values) => {
    if (/^(begin|commit|rollback)/i.test(text)) return { rows: [] }
    if (values.length === 3 && values[2] === f.run.id) return { rows: [{ workflow_version_id: f.version.id,
      snapshot_id: f.run.id, snapshot, execution_state: 'running' }] }
    if (values.length === 2) return { rows: [] }
    if (values.length === 3 && values[0] === f.version.id) return { rows: [{ record: f.version }] }
    throw new Error('Unexpected database read in queue fixture')
  }))
  vi.spyOn(pool, 'connect').mockResolvedValue({ query, release() {}, on() {}, removeListener() {} } as never)
  const access = new PostgresAccessService(pool)
  vi.spyOn(access, 'authenticate').mockImplementation(async token => {
    if (token === 'reader') return principal
    if (token === 'denied') return denied
    throw new DomainError('AUTH_REQUIRED', 'Invalid test bearer', 401)
  })
  const audit = vi.fn(async () => undefined)
  const services = { runs: { history: new RunHistoryService(pool) }, commands: { recordDenied: audit } } as unknown as OperatorServices
  const app = buildApp({ logger: false, readiness: { database: { ping: async () => undefined },
    checkpoints: { ping: async () => undefined } }, operator: { access, services } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  const connect = async (token: string) => {
    const client = new Client({ name: 'queue-read-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => token } }))
    return client
  }
  const gate = new RunnerAdmission(1)
  let release!: () => void
  const held = gate.run('blocking-run', new AbortController().signal,
    () => new Promise<void>(resolve => { release = resolve }))
  const execution = { id: 'queued-execution', runId: f.run.id, workflowNodeId: f.identities[0]!.workflowNodeId }
  const queued = gate.run(f.run.id, new AbortController().signal, async () => undefined, { execution })
  try {
    const reader = await connect('reader')
    const call = () => reader.callTool({ name: 'run_board_snapshot_get', arguments: scope })
    const result = decodeMcpToolResult(await call())
    expect(result).toMatchObject({ snapshot, executionQueue: [{ executionId: execution.id,
      workflowNodeId: execution.workflowNodeId, reason: { kind: 'host_capacity', hostKey: 'main', limit: 1 } }] })
    const forbidden = await (await connect('denied')).callTool({ name: 'run_board_snapshot_get', arguments: scope })
    expect(forbidden.isError).toBe(true)
    expect(decodeMcpToolResult(forbidden)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
    release()
    await Promise.all([held, queued])
    expect(decodeMcpToolResult(await call())).toMatchObject({ snapshot, executionQueue: [] })
  } finally {
    release()
    await Promise.all([held, queued])
    await Promise.all(clients.map(client => client.close()))
    await app.close()
    await pool.end()
    vi.restoreAllMocks()
  }
})
