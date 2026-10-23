import { randomUUID } from 'node:crypto'
import { WorkflowKanbanLayoutReadSchema } from '@foreman-code/contracts'
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

it('shows, moves and hides a workflow Kanban through authenticated HTTP, denying a read-only caller', async () => {
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
    const expiresAt = new Date(Date.now() + 120_000)
    const owner = await access.issue({ name: 'Kanban owner', audience: 'operator', expiresAt,
      grants: [{ actions: [...c.ManagementActionSchema.options], scope: {} }] })
    const workspaceId = (await workspaces.create(owner.principal, 'http', { commandId: randomUUID(), name: 'Kanban' })).value.workspace.id
    const created = await workflows.create(owner.principal, 'http', { workspaceId, name: 'Release', commandId: randomUUID() })
    const workflowId = created.value.workflow.id
    const scope = { workspaceId, workflowId }
    const path = `/api/management/workspaces/${workspaceId}/workflows/${workflowId}/kanban-layout`
    const reader = await access.issue({ name: 'Kanban reader', audience: 'operator', expiresAt,
      grants: [{ actions: ['workflows:read'], scope: { workspaceIds: [workspaceId] } }] })
    const read = async (token: string) => {
      const response = await app.inject({ method: 'GET', url: path, headers: { authorization: `Bearer ${token}` } })
      expect(response.statusCode).toBe(200)
      return WorkflowKanbanLayoutReadSchema.parse(response.json())
    }
    const write = (token: string, layout: unknown) => app.inject({ method: 'PUT', url: path,
      headers: { authorization: `Bearer ${token}` }, payload: { layout } })

    expect(await read(owner.token)).toEqual({ ...scope, layout: { visible: false, frame: null } })

    const shown = { visible: true, frame: { x: 640, y: -40, width: 720, height: 440 } }
    const saved = await write(owner.token, shown)
    expect(saved.statusCode).toBe(200)
    expect(WorkflowKanbanLayoutReadSchema.parse(saved.json())).toEqual({ ...scope, layout: shown })

    expect((await write(reader.token, { visible: false, frame: shown.frame })).statusCode).toBe(403)
    expect(await read(reader.token)).toEqual({ ...scope, layout: shown })

    // Removing from the Board hides it, keeping its place; the workflow itself is unchanged.
    const hidden = await write(owner.token, { ...shown, visible: false })
    expect(hidden.statusCode).toBe(200)
    expect(await read(reader.token)).toEqual({ ...scope, layout: { ...shown, visible: false } })
    const workflow = await workflows.get(owner.principal, workspaceId, workflowId)
    expect(workflow.revision).toBe(created.value.revision)
    expect((await pool.query(`select count(*) from management_audit where action = 'workflow.kanban_layout.set'
      and outcome = 'succeeded'`)).rows[0].count).toBe('2')

    const invalid = await write(owner.token, { visible: true, frame: { x: 0, y: 0, width: 10, height: 10 } })
    expect(invalid.statusCode).toBe(400)
    const unknown = await app.inject({ method: 'GET', headers: { authorization: `Bearer ${owner.token}` },
      url: `/api/management/workspaces/${workspaceId}/workflows/missing-workflow/kanban-layout` })
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json()).toMatchObject({ error: { code: 'WORKFLOW_NOT_FOUND' } })
  } finally {
    await app.close()
    await database.close()
  }
}, 30_000)
