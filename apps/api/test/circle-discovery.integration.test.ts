import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createDatabase } from '../src/infrastructure/database.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { CircleAccountDirectory } from '@foreman-code/ci/circleAccounts'
import { CircleCiAccounts } from '@foreman-code/ci/circleCiAccounts'
import { CloudCi } from '@foreman-code/ci/cloud'
import { CircleCiProvider, GitHubActionsProvider } from '@foreman-code/ci/cloudProviders'
import { CiDispatchDeadlineError, withCiDispatchDeadline } from '@foreman-code/ci/dispatchDeadline'
import { ProductionHostCiEndpoint } from '@foreman-code/ci/endpoint'
import type { HostCiPorts } from '@foreman-code/ci/runner'
import type { HostCiComputer } from '@foreman-code/ci/serviceTypes'
import { deferred } from './helpers/deferred.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { mainCiContext } from '../src/modules/ci/context.js'

let fixture: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { fixture = await migratedDatabase() }, 60_000)
afterAll(async () => { await fixture?.close() }, 60_000)

it.each(['ended', 'expired'] as const)(
  'discovers all existing primary organizations after the dispatch pass has %s without account setup', async outcome => {
    const database = createDatabase({ connectionString: fixture.databaseUrl, maxConnections: 4, connectionTimeoutMs: 1000 })
    const settings = new PostgresFoundationSettingsRepository(database.pool)
    const registry = { list: async () => (await settings.getCircleAccounts()).value.accounts }
    const entered = deferred()
    const resumeDiscovery = deferred()
    const resumeDispatch = deferred()
    const owners = ['fixture-alpha', 'fixture-beta', 'fixture-gamma']
    let memberships = 0
    const ports: HostCiPorts = {
      now: () => new Date(), cpus: 4, memoryBytes: 2 ** 30,
      run: async (file, args) => {
        if (file === 'gh' && args[0] === 'api') {
          memberships++
          entered.resolve()
          await resumeDiscovery.promise
          return { code: 0, stdout: owners.join('\n'), stderr: '' }
        }
        if (file === 'circleci' && (args[0] === 'project' || args[0] === 'auth')) {
          return { code: 0, stdout: '{}', stderr: '' }
        }
        throw new Error(`Unexpected fixture command: ${file} ${args[0]}`)
      },
    }
    const directory = new CircleAccountDirectory(mainCiContext, ports, registry, {
      configRoot: join(fixture.directory, outcome, 'config'), environment: { CIRCLE_TOKEN: 'fixture-primary-token' },
    })
    const context = async (id: string) => {
      const account = await directory.context(id)
      if (!account) throw new Error('Fixture login is missing')
      return account
    }
    const primaryContext = await context('default')
    const primary = new CircleCiProvider(mainCiContext, primaryContext.ports, { http: primaryContext.http })
    primary.recoveryOnly = true
    const mirrors = async () => 'fixture-alpha/site-ci'
    const clouds = [new CloudCi(mainCiContext, 'fixture-main', new GitHubActionsProvider(mainCiContext, ports), mirrors,
      join(fixture.directory, outcome, 'github')), new CloudCi(mainCiContext, 'fixture-main', primary, mirrors,
      join(fixture.directory, outcome, 'recovery'))]
    const discovery = new CircleCiAccounts(mainCiContext, ports, async () => [await mirrors()], async account => {
      const selected = await context(account.circleAccountId ?? 'default')
      clouds.push(new CloudCi(mainCiContext, 'fixture-main', new CircleCiProvider(mainCiContext, selected.ports, { http: selected.http }, account),
        mirrors, join(fixture.directory, outcome, account.owner)))
    }, { registry, context, explicitPrimary: true })
    let refreshing: Promise<void> | undefined
    const endpoint = new ProductionHostCiEndpoint(mainCiContext, database.pool, 'fixture-main', () => undefined, {
      handle: async () => { throw new Error('Unexpected local executor request') },
    }, clouds, () => { refreshing = discovery.refresh(); return refreshing })
    let initial: HostCiComputer[] = []
    try {
      expect((await settings.getCircleAccounts()).value.accounts).toMatchObject([
        { id: 'default', role: 'primary', organizations: [] },
      ])
      const dispatch = withCiDispatchDeadline(mainCiContext, async () => {
        initial = await endpoint.computers()
        await entered.promise
        if (outcome === 'expired') await resumeDispatch.promise
      })
      if (outcome === 'expired') await expect(dispatch).rejects.toBeInstanceOf(CiDispatchDeadlineError)
      else await dispatch
      expect(initial.every(computer => computer.hostRef.provider === 'github')).toBe(true)
      expect(initial).toHaveLength(20)
      resumeDiscovery.resolve()
      await refreshing

      const computers = await endpoint.computers()
      const circle = computers.filter(computer => computer.hostRef.provider === 'circleci')
      expect(circle).toHaveLength(90)
      expect([...new Set(circle.map(computer => computer.hostRef.account))].sort()).toEqual(owners)
      expect(circle.every(computer => computer.hostRef.circleAccountId === undefined)).toBe(true)
      for (const owner of owners) {
        const computer = circle.find(computer => computer.hostRef.account === owner)!
        expect(await endpoint.request(computer, { operation: 'status' })).toMatchObject({ operation: 'status', ready: true })
      }
      expect(memberships).toBe(1)
      expect((await settings.getCircleAccounts()).value.accounts[0]?.organizations).toEqual([])
    } finally {
      resumeDiscovery.resolve()
      resumeDispatch.resolve()
      await refreshing
      await database.close()
    }
  },
)
