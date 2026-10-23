import { randomUUID } from 'node:crypto'
import * as c from '@foreman-code/contracts/management'
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

it('rejects a Kanban layout body that names a different workflow than its URL and writes nothing', async () => {
  const database = await migratedDatabase()
  const { pool } = database
  const access = new PostgresAccessService(pool), commands = new PostgresCommandCoordinator(pool)
  const workspaces = new WorkspaceManagementService(pool, commands, new WorkspaceLocationService(pool, commands))
  const workflows = new WorkflowManagementService(pool, commands)
  const services = { commands, workspaces, workflows } as unknown as OperatorServices
  const app = buildApp({ logger: false, readiness: {
    database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined },
  }, operator: { access, services } })
  try {
    const owner = await access.issue({ name: 'Kanban owner', audience: 'operator', expiresAt: new Date(Date.now() + 120_000),
      grants: [{ actions: [...c.ManagementActionSchema.options], scope: {} }] })
    const workspaceId = (await workspaces.create(owner.principal, 'http', { commandId: randomUUID(), name: 'Kanban' })).value.workspace.id
    const first = (await workflows.create(owner.principal, 'http', { workspaceId, name: 'First', commandId: randomUUID() })).value.workflow.id
    const second = (await workflows.create(owner.principal, 'http', { workspaceId, name: 'Second', commandId: randomUUID() })).value.workflow.id
    const path = (workflowId: string) => `/api/management/workspaces/${workspaceId}/workflows/${workflowId}/kanban-layout`
    const headers = { authorization: `Bearer ${owner.token}` }
    const layout = { visible: true, frame: { x: 640, y: -40, width: 720, height: 440 } }

    const mismatched = await app.inject({ method: 'PUT', url: path(first), headers, payload: { workspaceId, workflowId: second, layout } })
    expect(mismatched.statusCode).toBe(400)
    expect(mismatched.json()).toMatchObject({ error: { code: 'RESOURCE_ID_MISMATCH' } })
    for (const workflowId of [first, second]) {
      const read = await app.inject({ method: 'GET', url: path(workflowId), headers })
      expect(read.json()).toMatchObject({ workflowId, layout: { visible: false, frame: null } })
    }
  } finally {
    await app.close()
    await database.close()
  }
}, 30_000)
