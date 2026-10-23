import { randomUUID } from 'node:crypto'
import { ComputerMaintenanceListSchema } from '@foreman-code/contracts/computer-maintenance'
import { COMPUTER_ACCOUNTS_NAMESPACE, type ComputerAccounts } from '@foreman-code/contracts/computer-accounts'
import type { ManagementAction } from '@foreman-code/contracts/management'
import { expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { ComputerAccountsService } from '../src/modules/computers/accounts.js'
import { computerConnectionsReader } from '../src/modules/computers/connections.js'
import { FleetMaintenanceService, type FleetSources } from '../src/modules/computers/fleet.js'
import { fakeComputer } from './helpers/fleetSync.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { computerMaintenanceHttp } from './support/computerMaintenanceHttp.js'

it('reads persisted computer targets and their connections through HTTP with the caller’s read authority', async () => {
  const database = await migratedDatabase()
  const apps: ReturnType<typeof buildApp>[] = []
  try {
    const mainId = (await database.pool.query<{ id: string }>('select id from application_installation')).rows[0]!.id
    const device = { mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1,
      authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat'], publicKeyFingerprint: 'a'.repeat(64) }
    await database.pool.query(`insert into device_registrations (id,main_id,worker_installation_id,public_key,record)
      values($1,$2,$3,'fixture',$4::jsonb)`, [device.deviceId, mainId, device.workerInstallationId, JSON.stringify(device)])
    const access = new PostgresAccessService(database.pool)
    const issue = (name: string, actions: ManagementAction[]) => access.issue({ name, audience: 'operator',
      expiresAt: new Date(Date.now() + 3_600_000), grants: [{ actions, scope: {} }] })
    const reader = await issue('Connections reader', ['settings:read', 'harnesses:read'])
    const limited = await issue('Settings reader', ['settings:read'])
    const denied = await issue('Unrelated reader', ['capabilities:read'])
    const accounts = (signedIn: boolean): ComputerAccounts => ({ observedAt: '2026-10-17T12:00:00.000Z',
      accounts: [{ tool: 'claude', installed: true, signedIn, account: signedIn ? 'reader@example.com' : null, details: [] }] })
    const mainAccounts = accounts(true)
    const deviceAccounts = accounts(false)
    const commands = new PostgresCommandCoordinator(database.pool)
    const computerAccounts = new ComputerAccountsService(database.pool, mainId, () => ({
      capabilities: () => [{ namespace: COMPUTER_ACCOUNTS_NAMESPACE, mainCanRequest: true }],
      request: async () => ({ payload: deviceAccounts }),
    }), commands, async () => mainAccounts)
    const mcpReads: string[] = []
    const connections = computerConnectionsReader(computerAccounts, {
      list: async (_principal, harness, hostRef) => {
        mcpReads.push(`${hostRef.kind}:${harness}`)
        return { presets: { graphql: hostRef.kind === 'main' ? 'installed' : 'missing', linear: 'missing' } }
      },
    })
    const createApp = () => {
      const computerMaintenance = new FleetMaintenanceService(database.pool, mainId, () => undefined, commands,
        fakeComputer().maintenance, { connections } as FleetSources)
      const app = buildApp({ logger: false, operator: {
        access, services: { commands, computerMaintenance } as unknown as OperatorServices,
      }, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } } })
      apps.push(app)
      return app
    }
    const app = createApp()
    const connect = (instance: ReturnType<typeof buildApp>, token: string) => computerMaintenanceHttp(instance, token)
    const read = async (client: ReturnType<typeof connect>) => {
      const response = await client.status()
      expect(response.ok).toBe(true)
      return ComputerMaintenanceListSchema.parse(response.body).computers
    }
    const computers = await read(connect(app, reader.token))
    expect(computers.map(computer => computer.connections)).toEqual([
      { accounts: mainAccounts, mcp: { codex: 'installed', claude: 'installed' } },
      { accounts: deviceAccounts, mcp: { codex: 'missing', claude: 'missing' } },
    ])
    const savedTarget = computers[1]!.target
    expect(savedTarget.applicationInstallationId).toBe(device.workerInstallationId)
    const limitedRead = await read(connect(app, limited.token))
    expect(limitedRead.map(computer => computer.connections?.mcp)).toEqual([
      { codex: null, claude: null }, { codex: null, claude: null },
    ])
    expect(mcpReads).toHaveLength(4)
    const rejection = await connect(app, denied.token).status()
    expect(rejection.ok).toBe(false)
    expect(JSON.stringify(rejection.body)).toContain('ACCESS_DENIED')
    const restarted = connect(createApp(), reader.token)
    const readback = await restarted.status({ target: savedTarget })
    expect(readback.ok).toBe(true)
    expect(ComputerMaintenanceListSchema.parse(readback.body).computers).toEqual([
      expect.objectContaining({ target: savedTarget, connections: computers[1]!.connections }),
    ])
  } finally {
    await Promise.all(apps.map(app => app.close()))
    await database.close()
  }
})
