import { computerMaintenanceHttp } from './support/computerMaintenanceHttp.js'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  COMPUTER_MAINTENANCE_NAMESPACE, WORKER_UPDATE_NAMESPACE, ComputerMaintenanceListSchema, ComputerMaintenanceStartResultSchema,
  MaintenanceRequestSchema, MaintenanceStatusSchema, type MaintenanceStatus, type MaintenanceTask,
} from '@foreman-code/contracts/computer-maintenance'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { ComputerMaintenance, type MaintenancePorts } from '../src/modules/computers/maintenance.js'
import { fakeComputer } from './helpers/fleetSync.js'
import { FleetMaintenanceService } from '../src/modules/computers/fleet.js'
import { currentDatabase } from './helpers/database.js'

const initialStatus = (): MaintenanceStatus => ({
  observedAt: new Date().toISOString(),
  harnesses: [],
  system: { packageUpdates: null, rebootRequired: false, sudo: false, disk: null },
  tasks: [],
  worker: { currentVersion: '0.0.55', targetVersion: '0.0.56', state: 'pending', lastError: null },
})

async function fixture() {
  const storage = process.env.FOREMAN_CODE_TEST_ROOT ?? join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(storage, { recursive: true })
  const directory = await mkdtemp(join(storage, 'worker-update-mcp-'))
  const workerFile = join(directory, 'worker.json')
  await writeFile(workerFile, JSON.stringify(initialStatus()))
  const db = await currentDatabase()
  const pool = db.pool
  const access = new PostgresAccessService(pool)
  const mainId = (await pool.query('select id from application_installation where singleton=true')).rows[0]!.id
  const registration = {
    mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1,
    authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat'],
    publicKeyFingerprint: 'a'.repeat(64),
  }
  const saveRegistration = async (record: typeof registration) => {
    await pool.query(`insert into device_registrations(id,main_id,worker_installation_id,public_key,record)
      values($1,$2,$3,$4,$5) on conflict(id) do update set record=excluded.record`,
    [record.deviceId, mainId, record.workerInstallationId, 'worker-transport-fixture', record])
  }
  await saveRegistration(registration)
  const writerCredential = await access.issue({ name: 'Maintainer', audience: 'operator',
    grants: [{ actions: ['settings:read', 'settings:update', 'capabilities:read'], scope: {} }],
    expiresAt: new Date(Date.now() + 600000) })
  const readerCredential = await access.issue({ name: 'Reader', audience: 'operator',
    grants: [{ actions: ['settings:read', 'capabilities:read'], scope: {} }],
    expiresAt: new Date(Date.now() + 600000) })
  const scopedCredential = await access.issue({ name: 'Scoped writer', audience: 'operator',
    grants: [{ actions: ['settings:read', 'settings:update'], scope: { workspaceIds: ['workspace'] } }],
    expiresAt: new Date(Date.now() + 600000) })
  const credentials = { writer: writerCredential, reader: readerCredential, scoped: scopedCredential }
  const writer = writerCredential.principal
  const reader = readerCredential.principal
  const scoped = scopedCredential.principal
  const readAudits = async () => (await pool.query(`select principal_id as "principalId", source, action, outcome
    from management_audit order by sequence`)).rows
  let starts = 0
  let mainStarts = 0
  let updateSupported = true
  const computer = fakeComputer()
  let updatePorts: MaintenancePorts['workerUpdate']
  let workerMaintenance: ComputerMaintenance | undefined
  const readWorker = async () => MaintenanceStatusSchema.parse(JSON.parse(await readFile(workerFile, 'utf8')))
  const saveWorker = async (status: MaintenanceStatus) => writeFile(workerFile, JSON.stringify(status))
  const createCommands = () => new PostgresCommandCoordinator(pool)
  const local = {
    status: async () => {
      const status = initialStatus()
      delete status.worker
      return status
    },
    start: async () => { mainStarts++; throw new Error('Main must not receive a Worker update.') },
  } as unknown as ComputerMaintenance
  const createFleet = (commands: PostgresCommandCoordinator) => new FleetMaintenanceService(pool, mainId, () => ({
    capabilities: () => [
      { namespace: COMPUTER_MAINTENANCE_NAMESPACE, mainCanRequest: true },
      ...(updateSupported ? [{ namespace: WORKER_UPDATE_NAMESPACE, mainCanRequest: false }] : []),
    ],
    request: async (_deviceId, _namespace, raw) => {
      const request = MaintenanceRequestSchema.parse(raw)
      const status = workerMaintenance ? await workerMaintenance.status(AbortSignal.timeout(2000)) : await readWorker()
      if (request.operation === 'status') return { payload: { operation: 'status', status } }
      if (workerMaintenance) {
        starts++
        return { payload: { operation: 'start', task: await workerMaintenance.start(request.task, request.commandId) } }
      }
      const previous = status.tasks.find(task => task.id === request.commandId)
      if (previous) return { payload: { operation: 'start', task: previous } }
      starts++
      const task: MaintenanceTask = { id: request.commandId, kind: request.task.kind, state: 'running',
        startedAt: new Date().toISOString(), finishedAt: null, summary: 'Waiting for active work.', outputTail: '' }
      status.tasks.push(task)
      status.worker = { currentVersion: '0.0.55', targetVersion: '0.0.56', state: 'draining', lastError: null }
      await saveWorker(status)
      return { payload: { operation: 'start', task } }
    },
  }), commands, local, {
    codexUserMcpServers: async () => ({}), claudeUserMcpServers: async () => ({}),
    codexPlugins: async () => [], codexMarketplaces: async () => [],
    claudePlugins: async () => ({ plugins: [], marketplaces: [] }),
  })
  const commands = createCommands()
  const services = { computerMaintenance: createFleet(commands), commands } as unknown as OperatorServices
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access: new PostgresAccessService(pool), services },
  })
  const connect = (token: string) => computerMaintenanceHttp(app, credentials[token as keyof typeof credentials]?.token ?? token)
  return {
    app, connect, registration, saveRegistration, writer, reader, scoped, readAudits, pool, readWorker, saveWorker, directory,
    mountUpdater: (ports: NonNullable<MaintenancePorts['workerUpdate']>) => {
      updatePorts = ports
      workerMaintenance = new ComputerMaintenance({ ...computer.ports, workerUpdate: ports })
    },
    counts: () => ({ starts, mainStarts }),
    withoutUpdateExtension: () => { updateSupported = false },
    recreate: () => {
      if (updatePorts) workerMaintenance = new ComputerMaintenance({ ...computer.ports, workerUpdate: updatePorts })
      services.commands = createCommands()
      services.computerMaintenance = createFleet(services.commands)
    },
    close: async () => {
      await app.close()
      await db.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

const readStatus = async (client: ReturnType<typeof computerMaintenanceHttp>) =>
  ComputerMaintenanceListSchema.parse((await client.status({ refresh: true })).body)

describe('Worker updates through the authenticated HTTP API', () => {
  it('starts paired Workers, replays saved targets and outcomes, and retries a rolled-back update', async () => {
    const f = await fixture()
    try {
      const operator = f.connect('writer')
      const input = { commandId: randomUUID(), task: { kind: 'update-worker' } }
      const first = ComputerMaintenanceStartResultSchema.parse((await operator.start(input)).body)
      expect(first.computers).toHaveLength(1)
      expect(first.computers[0]).toMatchObject({ target: { hostRef: { deviceId: f.registration.deviceId } },
        task: { kind: 'update-worker', state: 'running' }, error: null })
      expect((await readStatus(operator)).computers[1]?.status?.worker).toMatchObject({ state: 'draining' })
      const retained = await f.readWorker()
      retained.tasks[0] = { ...retained.tasks[0]!, state: 'failed', finishedAt: new Date().toISOString(),
        summary: 'New release failed; previous release restored.' }
      retained.worker = { currentVersion: '0.0.55', targetVersion: '0.0.56', state: 'rolled-back', lastError: 'Start failed.' }
      await f.saveWorker(retained)
      await f.saveRegistration({ ...f.registration, deviceId: randomUUID(), workerInstallationId: randomUUID() })
      const receipts = (await f.pool.query(`select operation, result from management_command_receipts
        where principal_id=$1 and command_id=$2 order by operation`, [f.writer.id, input.commandId])).rows
      expect(receipts).toEqual([
        { operation: 'computers.maintenance.plan', result: expect.objectContaining({ targets: [first.computers[0]!.target] }) },
        { operation: 'computers.maintenance.start', result: first },
      ])
      f.recreate()
      const afterRestart = f.connect('writer')
      const replay = ComputerMaintenanceStartResultSchema.parse((await afterRestart.start(input)).body)
      expect(replay.computers).toHaveLength(1)
      expect(replay.computers[0]?.task).toMatchObject({ id: first.computers[0]?.task?.id, state: 'failed' })
      expect((await readStatus(afterRestart)).computers[1]?.status?.worker).toEqual(retained.worker)
      expect(f.counts()).toEqual({ starts: 1, mainStarts: 0 })
      const retry = await afterRestart.start({
        commandId: randomUUID(), task: { kind: 'update-worker' }, targets: [first.computers[0]!.target],
      })
      expect(ComputerMaintenanceStartResultSchema.parse(retry.body).computers[0]?.task)
        .toMatchObject({ kind: 'update-worker', state: 'running' })
      expect(f.counts()).toEqual({ starts: 2, mainStarts: 0 })
      expect((await f.readAudits()).filter(audit => audit.action === 'computers.maintenance.start')).toEqual([
        { principalId: f.writer.id, source: 'http', action: 'computers.maintenance.start', outcome: 'succeeded' },
        { principalId: f.writer.id, source: 'http', action: 'computers.maintenance.start', outcome: 'succeeded' },
      ])
    } finally { await f.close() }
  })

  it('denies invalid, read-only and workspace-scoped callers without starting an update', async () => {
    const f = await fixture()
    try {
      for (const token of ['reader', 'scoped']) {
        const caller = f.connect(token)
        const denied = await caller.start({ commandId: randomUUID(), task: { kind: 'update-worker' } })
        expect(denied.ok).toBe(false)
        expect(JSON.stringify(denied.body)).toContain('ACCESS_DENIED')
      }
      const invalid = await f.connect('invalid').start({ commandId: randomUUID(), task: { kind: 'update-worker' } })
      expect(invalid.statusCode).toBe(401)
      expect(f.counts()).toEqual({ starts: 0, mainStarts: 0 })
      // Each denied caller is audited twice: by the service under the tool name, then by the generic HTTP handler.
      const denial = (principalId: string | null, action: string) => ({ principalId, source: 'http', action, outcome: 'denied' })
      expect((await f.readAudits()).filter(audit => audit.outcome === 'denied')).toEqual([
        denial(f.reader.id, 'computers_maintenance_start'), denial(f.reader.id, 'ACCESS_DENIED'),
        denial(f.scoped.id, 'computers_maintenance_start'), denial(f.scoped.id, 'ACCESS_DENIED'),
        denial(null, 'AUTH_INVALID'),
      ])
      expect((await readStatus(f.connect('reader'))).computers[1]?.status?.worker)
        .toMatchObject({ currentVersion: '0.0.55', targetVersion: '0.0.56', state: 'pending', lastError: null })
    } finally { await f.close() }
  })

  it('reports Main as unsupported and preserves command identity and current pairing checks', async () => {
    const f = await fixture()
    try {
      const operator = f.connect('writer')
      const targets = (await readStatus(operator)).computers.map(computer => computer.target)
      const main = ComputerMaintenanceStartResultSchema.parse((await operator.start({
        commandId: randomUUID(), task: { kind: 'update-worker' }, targets: [targets[0]],
      })).body)
      expect(main.computers[0]).toMatchObject({ task: null, error: expect.stringContaining('production:install') })
      const input = { commandId: randomUUID(), task: { kind: 'update-worker' }, targets: [targets[1]] }
      expect((await operator.start(input)).ok).toBe(true)
      const changed = await operator.start({ ...input, targets })
      expect(changed.ok).toBe(false)
      expect(JSON.stringify(changed.body)).toContain('COMMAND_ID_CONFLICT')
      await f.saveRegistration({ ...f.registration, authorizationRevision: 2 })
      const stale = ComputerMaintenanceStartResultSchema.parse(
        (await operator.start({ ...input, commandId: randomUUID() })).body)
      expect(stale.computers[0]).toMatchObject({ task: null, error: expect.stringContaining('not paired') })
      expect(f.counts()).toEqual({ starts: 1, mainStarts: 0 })
      f.withoutUpdateExtension()
      const legacy = ComputerMaintenanceStartResultSchema.parse(
        (await operator.start({ commandId: randomUUID(), task: { kind: 'update-worker' } })).body)
      expect(legacy.computers[0]).toMatchObject({ task: null, error: expect.stringContaining('updater-enabled Worker') })
      expect(f.counts()).toEqual({ starts: 1, mainStarts: 0 })
    } finally { await f.close() }
  })
})


it('reports concrete updater failures through authenticated HTTP and persists them for a read-only caller', async () => {
  const f = await fixture()
  const { WorkerUpdater } = await import(new URL('../../worker/src/update.mjs', import.meta.url).href)
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  const bytes = Buffer.from('export {}\n')
  const target = { os: 'ubuntu', osRelease: '24.04', arch: 'x64', libc: 'glibc-2.39', node: 'v22.23.3' }
  const manifest = { format: 1, version: '1.1.0', commit: 'a'.repeat(40), lockfileSha256: 'b'.repeat(64),
    packageManager: 'pnpm@11.27.0', protocolVersion: 1, identityFormat: 1, target,
    files: [{ path: 'src/cli.mjs', size: bytes.length, sha256: hash(bytes) }] }
  const manifestBytes = Buffer.from(JSON.stringify(manifest))
  const release = { version: manifest.version, manifest, manifestSha256: hash(manifestBytes),
    github: { repository: 'example/worker', tag: `worker-${manifest.commit}` } }
  const bundle = join(f.directory, 'bundle')
  await mkdir(join(bundle, 'src'), { recursive: true })
  await writeFile(join(bundle, 'manifest.json'), manifestBytes)
  await writeFile(join(bundle, 'src/cli.mjs'), bytes)
  const updater = await new WorkerUpdater({ stateDirectory: f.directory, version: '1.0.0',
    manifestSha256: 'c'.repeat(64), workerInstallationId: f.registration.workerInstallationId,
    facts: { ...target, rootPersistent: true, homePersistent: true, storagePersistent: true },
    assertStateOwnership: () => {}, locateLaunch: async () => ({ root: f.directory }), drain: async () => {}, resume: () => {},
    fetchAsset: async ({ github, destination }: { github: unknown; destination: string }) => {
      expect(github).toEqual(release.github)
      execFileSync('tar', ['-czf', destination, '-C', bundle, '.'])
    },
    stage: async () => { throw Object.assign(new Error('staging command exited 1'), { stderr: 'dependency-helper missing' }) },
    connection: () => ({ captureRequest: () => ({ request: async (payload: {
      operation: string; path: string; offset: number;
    }) => {
      if (payload.operation === 'release') return { payload: { operation: 'release', release } }
      if (payload.operation === 'ci-smoke') return { payload: { operation: 'ci-smoke', ciSmoke: null } }
      throw new Error(`Unexpected Main request: ${payload.operation}`)
    } }) }),
  }).initialize()
  try {
    f.mountUpdater({ status: () => updater.status(), start: () => updater.start({ retry: true }) })
    const writer = f.connect('writer')
    const input = { commandId: randomUUID(), task: { kind: 'update-worker' } }
    const started = ComputerMaintenanceStartResultSchema.parse((await writer.start(input)).body)
    const taskId = started.computers[0]!.task!.id
    const task = await vi.waitFor(async () => {
      const value = (await readStatus(writer)).computers.find(computer => computer.target.hostRef.kind === 'device')
        ?.status?.tasks.find(candidate => candidate.id === taskId)
      if (value?.state !== 'failed') throw new Error('maintenance task has not failed yet')
      return value
    }, { timeout: 5_000, interval: 5 })
    expect(task).toMatchObject({ state: 'failed', summary: expect.stringContaining('dependency-helper missing') })
    expect(task!.summary).toContain('installing')
    f.recreate()
    const reader = f.connect('reader')
    const retained = (await readStatus(reader)).computers.find(computer => computer.target.hostRef.kind === 'device')!
    expect(retained.status!.tasks.find(value => value.id === taskId)).toEqual(task)
    expect(retained.status!.worker!.lastError).toContain('dependency-helper missing')
    const denied = await reader.start(input)
    expect(denied.ok).toBe(false)
    expect(f.counts().starts).toBe(1)
  } finally {
    await updater.close()
    await f.close()
  }
})
