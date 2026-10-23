import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'

it('pages through every readable workspace when one grant is also restricted to a computer', async () => {
  const db = await currentDatabase()
  const commands = new PostgresCommandCoordinator(db.pool)
  const service = new WorkspaceManagementService(db.pool, commands, new WorkspaceLocationService(db.pool, commands))
  try {
    const { principal: admin } = await new PostgresAccessService(db.pool).issue({ name: 'Workspace creator', audience: 'operator',
      expiresAt: new Date(Date.now() + 120_000), grants: [{ actions: ['workspaces:create', 'workspaces:read'], scope: {} }] })
    const created = []
    for (const name of ['First', 'Second', 'Third']) {
      created.push((await service.create(admin, 'http', { name, commandId: randomUUID() })).value.workspace.id)
    }
    const [first, second, third] = created.sort()
    // The second grant names a computer, so it can never authorize a workspace-level read.
    const { principal } = await new PostgresAccessService(db.pool).issue({ name: 'Mixed scope reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 120_000), grants: [
        { actions: ['workspaces:read'], scope: { workspaceIds: [first!, third!] } },
        { actions: ['workspaces:read'], scope: { workspaceIds: [second!], mainIds: [randomUUID()] } },
      ] })
    const seen: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 5; page++) {
      const result = await service.list(principal, { limit: 1, includeArchived: false, ...(cursor ? { cursor } : {}) })
      seen.push(...result.items.map(item => item.workspace.id))
      if (!result.pageInfo.nextCursor) break
      cursor = result.pageInfo.nextCursor
    }
    expect(seen).toEqual([first, third])
  } finally { await db.close() }
})
