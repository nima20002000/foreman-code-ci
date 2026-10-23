import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import {
  ManagementActionSchema, WorkflowReorderResultSchema,
  type ManagementPrincipal, type WorkflowReorderInput,
} from '@foreman-code/contracts/management'
import { decodeMcpToolResult, WorkflowSummaryPageSchema } from '@foreman-code/contracts/operator-mcp'
import { SavedManagedWorkflowPageSchema } from '@foreman-code/contracts/current'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { currentDatabase } from './helpers/database.js'

async function workflowOrderFixture() {
  const database = await currentDatabase()
  const access = new PostgresAccessService(database.pool)
  const commands = new PostgresCommandCoordinator(database.pool)
  const locations = new WorkspaceLocationService(database.pool, commands)
  const workspaces = new WorkspaceManagementService(database.pool, commands, locations)
  const workflows = new WorkflowManagementService(database.pool, commands)
  const services = { commands, workspaces, workflows } as unknown as OperatorServices
  const app = buildApp({ logger: false, readiness: {
    database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined },
  }, operator: { access, services } })
  const clients: Client[] = []
  try {
    const owner = await access.issue({ name: 'Order owner', audience: 'operator',
      grants: [{ actions: [...ManagementActionSchema.options], scope: {} }],
      expiresAt: new Date(Date.now() + 600_000) })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'workflow-order-test', version: '1.0.0' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    const client = await connect(owner.token)
    const workspaceId = (await workspaces.create(owner.principal, 'http', {
      commandId: randomUUID(), name: 'Ordered workflows',
    })).value.workspace.id
    const created = []
    for (const name of ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon']) {
      created.push((await workflows.create(owner.principal, 'http', {
        workspaceId, name, commandId: randomUUID(),
      })).value)
    }
    return { database, access, commands, workspaces, workflows, app, owner, client, workspaceId, created, connect,
      async close() {
        for (const current of clients) await current.close()
        try { await app.close() } finally { await database.close() }
      } }
  } catch (error) {
    for (const client of clients) await client.close()
    try { await app.close() } finally { await database.close() }
    throw error
  }
}

type Fixture = Awaited<ReturnType<typeof workflowOrderFixture>>

async function listPage(f: Fixture, client = f.client, token = f.owner.token, cursor?: string) {
  const input = { workspaceId: f.workspaceId, limit: 2, ...(cursor ? { cursor } : {}) }
  const response = await f.app.inject({ method: 'GET',
    url: `/api/management/workspaces/${f.workspaceId}/workflows?${new URLSearchParams({
      limit: '2', ...(cursor ? { cursor } : {}),
    })}`, headers: { authorization: `Bearer ${token}` } })
  expect(response.statusCode, response.body).toBe(200)
  const mcp = await client.callTool({ name: 'workflow_list', arguments: { ...input, detail: 'full' } })
  expect(mcp.isError, JSON.stringify(mcp)).not.toBe(true)
  const page = SavedManagedWorkflowPageSchema.parse(decodeMcpToolResult(mcp))
  expect(response.json()).toEqual(page)
  return page
}

async function readOrder(f: Fixture, client = f.client, token = f.owner.token) {
  let page = await listPage(f, client, token)
  const ids = page.items.map((item) => item.workflow.id)
  while (page.pageInfo.nextCursor) {
    page = await listPage(f, client, token, page.pageInfo.nextCursor)
    ids.push(...page.items.map((item) => item.workflow.id))
  }
  return { ids, orderRevision: page.orderRevision }
}

async function issueCaller(f: Fixture, grants: ManagementPrincipal['grants']) {
  const issued = await f.access.issue({ name: 'Order caller', audience: 'operator', grants,
    expiresAt: new Date(Date.now() + 600_000) })
  return { ...issued, client: await f.connect(issued.token) }
}

function reorder(f: Fixture, token: string, input: WorkflowReorderInput) {
  return f.app.inject({ method: 'PUT', url: `/api/management/workspaces/${input.workspaceId}/workflows/order`,
    headers: { authorization: `Bearer ${token}` }, payload: input })
}

async function expectReorderError(f: Fixture, token: string, input: WorkflowReorderInput, code: string) {
  const result = await reorder(f, token, input)
  expect(result.statusCode).toBeGreaterThanOrEqual(400)
  expect(result.json()).toMatchObject({ error: { code } })
}

describe('persisted workflow ordering through authenticated HTTP, read back through MCP and HTTP', () => {
  it('reorders across scoped pages, retains omitted slots, persists readback and replays one audited command', async () => {
    const f = await workflowOrderFixture()
    try {
      const ids = f.created.map((item) => item.workflow.id)
      const original = await readOrder(f)
      expect(original.ids).toEqual(ids)
      expect(original.orderRevision).toBe(5)

      const first = await listPage(f)
      const httpInput = { workspaceId: f.workspaceId, commandId: randomUUID(),
        expectedRevision: first.orderRevision, workflowIds: [ids[1]!, ids[0]!] }
      const http = await reorder(f, f.owner.token, httpInput)
      expect(http.statusCode, http.body).toBe(200)
      const httpResult = WorkflowReorderResultSchema.parse(http.json())
      expect(httpResult.value).toEqual({ workspaceId: f.workspaceId,
        workflowIds: httpInput.workflowIds, orderRevision: 6 })
      const httpReplay = WorkflowReorderResultSchema.parse((await reorder(f, f.owner.token, httpInput)).json())
      expect(httpReplay).toEqual({ ...httpResult, replayed: true })

      const scopedIds = [ids[0]!, ids[2]!, ids[4]!]
      const scoped = await issueCaller(f, [{ actions: ['workflows:read', 'workflows:update'],
        scope: { workspaceIds: [f.workspaceId], workflowIds: scopedIds } }])
      const scopedFirst = await listPage(f, scoped.client, scoped.token)
      const scopedLast = await listPage(f, scoped.client, scoped.token, scopedFirst.pageInfo.nextCursor!)
      expect(scopedFirst.items.map((item) => item.workflow.id)).toEqual(scopedIds.slice(0, 2))
      expect(scopedLast.items.map((item) => item.workflow.id)).toEqual(scopedIds.slice(2))
      const input = { workspaceId: f.workspaceId, commandId: randomUUID(),
        expectedRevision: scopedFirst.orderRevision, workflowIds: [...scopedIds].reverse() }
      const result = WorkflowReorderResultSchema.parse((await reorder(f, scoped.token, input)).json())
      expect(result).toEqual({ value: { workspaceId: f.workspaceId, workflowIds: input.workflowIds,
        orderRevision: 7 }, replayed: false })
      expect(await readOrder(f, scoped.client, scoped.token)).toEqual({ ids: input.workflowIds, orderRevision: 7 })
      const expected = [ids[1], ids[4], ids[2], ids[3], ids[0]]
      expect((await readOrder(f)).ids).toEqual(expected)
      expect((await new PostgresWorkflowRepository(f.database.pool).list(f.workspaceId)).map((item) => item.id))
        .toEqual(expected)
      const reopened = new WorkflowManagementService(f.database.pool, new PostgresCommandCoordinator(f.database.pool))
      expect((await reopened.list(f.owner.principal, {
        workspaceId: f.workspaceId, limit: 100, includeArchived: false,
      })).items.map((item) => item.workflow.id)).toEqual(expected)
      const persisted = await Promise.all(ids.map((id) => f.workflows.get(f.owner.principal, f.workspaceId, id)))
      expect(persisted).toEqual(f.created)

      const compact = WorkflowSummaryPageSchema.parse(decodeMcpToolResult(await scoped.client.callTool({
        name: 'workflow_list', arguments: { workspaceId: f.workspaceId },
      })))
      expect(compact.orderRevision).toBe(7)
      expect(compact.items.map((item) => item.workflow.id)).toEqual(input.workflowIds)
      const staleCursor = await scoped.client.callTool({ name: 'workflow_list', arguments: {
        workspaceId: f.workspaceId, cursor: scopedFirst.pageInfo.nextCursor,
      } })
      expect(decodeMcpToolResult(staleCursor)).toMatchObject({ error: { code: 'REVISION_CONFLICT' } })
      const staleHttp = await f.app.inject({ method: 'GET',
        url: `/api/management/workspaces/${f.workspaceId}/workflows?cursor=${encodeURIComponent(first.pageInfo.nextCursor!)}`,
        headers: { authorization: `Bearer ${f.owner.token}` } })
      expect(staleHttp.statusCode).toBe(409)

      const replay = WorkflowReorderResultSchema.parse((await reorder(f, scoped.token, input)).json())
      expect(replay).toEqual({ ...result, replayed: true })
      await expectReorderError(f, scoped.token, { ...input, workflowIds: scopedIds }, 'COMMAND_ID_CONFLICT')
      await expectReorderError(f, scoped.token, { ...input, commandId: randomUUID() }, 'REVISION_CONFLICT')
      expect(await readOrder(f)).toEqual({ ids: expected, orderRevision: 7 })
      const audit = await f.database.pool.query<{ source: string; count: string }>(
        `select source, count(*) from management_audit where action = 'workflow.reorder'
         and outcome = 'succeeded' group by source order by source`,
      )
      expect(audit.rows).toEqual([{ source: 'http', count: '2' }])

      const appended = (await f.workflows.create(f.owner.principal, 'mcp', {
        workspaceId: f.workspaceId, name: 'Appended workflow', commandId: randomUUID(),
      })).value.workflow.id
      expect(await readOrder(f)).toEqual({ ids: [...expected, appended], orderRevision: 8 })
      await f.database.pool.query('update management_principals set grants = $2::jsonb where id = $1',
        [scoped.principal.id, JSON.stringify([{ actions: ['workflows:read'],
          scope: { workspaceIds: [f.workspaceId], workflowIds: scopedIds } }])])
      await expect(f.workflows.reorder(scoped.principal, 'mcp', input)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
      expect((await readOrder(f)).orderRevision).toBe(8)
    } finally {
      await f.close()
    }
  }, 60_000)

  it('denies read-only and incomplete scopes and rolls back invalid or stale selections', async () => {
    const f = await workflowOrderFixture()
    try {
      const ids = f.created.map((item) => item.workflow.id)
      const original = await readOrder(f)
      const input = { workspaceId: f.workspaceId, commandId: randomUUID(),
        expectedRevision: original.orderRevision, workflowIds: [ids[1]!, ids[0]!] }
      const reader = await issueCaller(f, [{ actions: ['workflows:read'], scope: { workspaceIds: [f.workspaceId] } }])
      const deniedHttp = await reorder(f, reader.token, input)
      expect(deniedHttp.statusCode).toBe(403)
      const incomplete = await issueCaller(f, [
        { actions: ['workflows:read'], scope: { workspaceIds: [f.workspaceId], workflowIds: [ids[0]!] } },
        { actions: ['workflows:update'], scope: { workspaceIds: [f.workspaceId], workflowIds: ids.slice(0, 2) } },
      ])
      await expectReorderError(f, incomplete.token, input, 'ACCESS_DENIED')
      const writeOnly = await issueCaller(f, [{ actions: ['workflows:update'], scope: { workspaceIds: [f.workspaceId] } }])
      expect((await reorder(f, writeOnly.token, input)).statusCode).toBe(403)
      expect(await readOrder(f)).toEqual(original)

      const foreignWorkspace = (await f.workspaces.create(f.owner.principal, 'http', {
        name: 'Other workspace', commandId: randomUUID(),
      })).value.workspace.id
      const foreign = (await f.workflows.create(f.owner.principal, 'http', {
        workspaceId: foreignWorkspace, name: 'Foreign workflow', commandId: randomUUID(),
      })).value.workflow.id
      const foreignOwnerPage = await f.workflows.list(f.owner.principal, {
        workspaceId: foreignWorkspace, limit: 10, includeArchived: false,
      })
      expect(foreignOwnerPage.orderRevision).toBe(1)
      const workflowReader = await issueCaller(f, [{ actions: ['workflows:read'],
        scope: { workflowIds: ids.slice(0, 2) } }])
      const workflowReaderPage = await listPage(f, workflowReader.client, workflowReader.token)
      expect(workflowReaderPage.orderRevision).toBe(original.orderRevision)
      expect(workflowReaderPage.items.map(item => item.workflow.id)).toEqual(ids.slice(0, 2))
      for (const denied of [reader, workflowReader]) {
        const empty = { items: [], pageInfo: { nextCursor: null }, orderRevision: 0 }
        for (const detail of ['compact', 'full'] as const) {
          const result = await denied.client.callTool({ name: 'workflow_list', arguments: {
            workspaceId: foreignWorkspace, detail,
          } })
          expect(result.isError).not.toBe(true)
          const expected = detail === 'compact' ? { ...empty, detail } : empty
          expect(decodeMcpToolResult(result)).toEqual(expected)
        }
        const deniedList = await f.app.inject({ method: 'GET',
          url: `/api/management/workspaces/${foreignWorkspace}/workflows`,
          headers: { authorization: `Bearer ${denied.token}` } })
        expect(deniedList.statusCode).toBe(200)
        expect(deniedList.json()).toEqual(empty)
      }
      await expectReorderError(f, f.owner.token, { ...input, commandId: randomUUID(),
        workflowIds: [ids[0]!, foreign] }, 'WORKFLOW_NOT_FOUND')
      await expectReorderError(f, f.owner.token, { ...input, commandId: randomUUID(),
        workflowIds: [ids[0]!, 'workflow-missing'] }, 'WORKFLOW_NOT_FOUND')
      await expectReorderError(f, f.owner.token, { ...input, commandId: randomUUID(), expectedRevision: 0 }, 'REVISION_CONFLICT')
      expect(await readOrder(f)).toEqual(original)
      const first = await listPage(f)
      for (const cursor of ['invalid-cursor', first.pageInfo.nextCursor!]) {
        const rejected = await f.app.inject({ method: 'GET',
          url: `/api/management/workspaces/${foreignWorkspace}/workflows?cursor=${encodeURIComponent(cursor)}`,
          headers: { authorization: `Bearer ${f.owner.token}` } })
        expect(rejected.statusCode).toBe(400)
        expect(rejected.json()).toMatchObject({ error: { code: 'WORKFLOW_ORDER_CURSOR_INVALID' } })
      }

      await f.workflows.archive(f.owner.principal, 'http', { workspaceId: f.workspaceId, workflowId: ids[1]!,
        commandId: randomUUID(), expectedRevision: f.created[1]!.revision })
      const afterArchive = await readOrder(f)
      expect(afterArchive).toEqual({ ids: ids.filter((id) => id !== ids[1]), orderRevision: 6 })
      await expectReorderError(f, f.owner.token, { ...input, commandId: randomUUID(), expectedRevision: 6 }, 'WORKFLOW_ARCHIVED')
      expect(await readOrder(f)).toEqual(afterArchive)
      for (const workflowIds of [[ids[0]!], [ids[0]!, ids[0]!]]) {
        const invalid = await f.app.inject({ method: 'PUT',
          url: `/api/management/workspaces/${f.workspaceId}/workflows/order`,
          headers: { authorization: `Bearer ${f.owner.token}` }, payload: { ...input, workflowIds } })
        expect(invalid.statusCode).toBe(400)
      }
      const mismatch = await f.app.inject({ method: 'PUT',
        url: `/api/management/workspaces/${f.workspaceId}/workflows/order`,
        headers: { authorization: `Bearer ${f.owner.token}` }, payload: { ...input, workspaceId: foreignWorkspace } })
      expect(mismatch.statusCode).toBe(400)
      expect(mismatch.json()).toMatchObject({ error: { code: 'RESOURCE_ID_MISMATCH' } })
      // The scope check fails before the command starts, so only the generic HTTP handler audits each denial.
      for (const caller of [reader, incomplete, writeOnly]) {
        const audit = await f.database.pool.query<{ source: string; action: string; target_key: string }>(
          "select source, action, target_key from management_audit where principal_id = $1 and outcome = 'denied'",
          [caller.principal.id],
        )
        expect(audit.rows).toEqual([{ source: 'http', action: 'ACCESS_DENIED',
          target_key: `/api/management/workspaces/${f.workspaceId}/workflows/order` }])
      }
    } finally {
      await f.close()
    }
  }, 60_000)
})
