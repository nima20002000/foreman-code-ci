import { expect, it, vi } from 'vitest'
import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'

it.each([1, 100])('uses a constant five domain queries to archive %i workflows', async (size) => {
  const workflows = Array.from({ length: size }, (_, index) => ({ workflowId: `workflow-${index}`, expectedRevision: 0 }))
  // The five statements are the workspace lock, the workspace read, the workflow read, the active-run check and the
  // archive write. The workspace read binds only the workspace id; the workflow read is the first statement binding the
  // workflow ids.
  let withIds = 0
  const query = vi.fn(async (_sql: string, values: unknown[] = []) => {
    if (values.length === 1 && values[0] === 'workspace') return { rows: [{ archived_at: null }] }
    if (values.length === 2 && ++withIds === 1) return { rows: workflows.map((item) => ({ id: item.workflowId, revision: '0' })) }
    return { rows: [] }
  })
  const client = { query } as unknown as pg.PoolClient
  const commands = { execute: async (input: { perform: (client: pg.PoolClient) => Promise<unknown> }) => input.perform(client) } as unknown as PostgresCommandCoordinator
  const service = new WorkflowManagementService({} as pg.Pool, commands)
  const principal: ManagementPrincipal = { id: 'operator', name: 'Operator', audience: 'operator', revokedAt: null,
    expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['workflows:archive'], scope: {} }] }
  const result = await service.archiveBatch(principal, 'http', { workspaceId: 'workspace', commandId: 'batch-query-count', workflows })
  expect(query).toHaveBeenCalledTimes(5)
  expect(result).toMatchObject({ workflowIds: workflows.map((item) => item.workflowId).sort() })
  expect(query.mock.calls.at(-1)![1]).toEqual(['workspace', workflows.map((item) => item.workflowId).sort()])
})
