import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, cp, readFile, rm, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { apiServiceTemplate }
  from '../../../../scripts/local-production-runtime.mjs'
import { renderUserService } from '../../../worker/src/service.mjs'
import { installedRestartArtifact } from './installedRestartArtifact.js'
import { measureIntegrationPhase } from './integrationPhase.js'
import { readUntil } from './observableCondition.js'

const execute = promisify(execFile)
const serviceUser = userInfo()

export async function writeRestartServiceUnit(unitPath: string, service: string) {
  await writeFile(unitPath, service, { mode: 0o600 })
}

/** Uses the installer's package layout and unit, with isolated fixture configuration. */
export async function installedRestartService(directory: string, configuration: string,
  environment: NodeJS.ProcessEnv, runtime: string) {
  const app = join(directory, 'installed')
  const release = join(app, 'current')
  const api = join(release, 'apps/api')
  await measureIntegrationPhase('installed restart artifact copy', async () => {
    await cp(await installedRestartArtifact(), release, { recursive: true, verbatimSymlinks: true })
    await copyFile(process.execPath, join(release, 'node'))
    await cp(environment.FOREMAN_CODE_WORKER_ARTIFACT_DIRECTORY!, join(release, 'worker-artifacts'),
      { recursive: true })
  })
  const readyFile = join(directory, 'service-ready.json')
  const preservingFile = `${readyFile}.preserving`
  const unit = `graphql-restart-${randomUUID()}.service`
  const unitPath = join(serviceUser.homedir, '.config/systemd/user', unit)
  const envFile = join(directory, 'service.env')
  const variables = { ...environment, FOREMAN_CODE_RESTART_FIXTURE_READY: readyFile }
  await writeFile(envFile, Object.entries(variables).filter((entry): entry is [string, string] =>
    entry[1] !== undefined).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n'), { mode: 0o600 })
  const template = apiServiceTemplate('')
    .replace('Wants=\nAfter=\n', '')
    .replaceAll('@HOME@/.config/graphql-production/production.env', envFile)
    .replace('apps/api/dist/server.js', `apps/api/dist/restart-fixture.js ${configuration}`)
    .replace(/^ExecStartPost=.*\n/m, '')
    .replace('Restart=always', 'Restart=no')
  const service = renderUserService(template, { node: join(release, 'node'), app,
    state: directory, home: serviceUser.homedir, path: environment.PATH ?? '/usr/bin:/bin' })
  await writeRestartServiceUnit(unitPath, service)
  const systemctl = (...args: string[]) => execute('systemctl', ['--user', ...args], {
    env: { ...process.env, XDG_RUNTIME_DIR: `/run/user/${serviceUser.uid}`,
      DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${serviceUser.uid}/bus` },
  })
  await systemctl('daemon-reload')
  const registry = new (await import('../../src/modules/harnesses/recovery/processRegistry.js')).NativeProcessRegistry(
    join(runtime, 'native-process-registry'))
  async function ready() {
    return readUntil(async () => {
      try {
        return JSON.parse(await readFile(readyFile, 'utf8')) as { pid: number; origin: string }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        const status = (await systemctl('show', unit, '--property=ActiveState', '--value')).stdout.trim()
        if (status === 'failed' || status === 'inactive') {
          throw new Error(`Installed API startup failed: ${unit}`, { cause: error })
        }
        return undefined
      }
    }, value => value !== undefined, { timeoutMs: 120_000, description: 'installed systemd API startup' })
  }
  return {
    unit, registry,
    state: async () => (await systemctl('show', unit, '--property=ActiveState', '--value')).stdout.trim(),
    pid: async () => Number((await systemctl('show', unit, '--property=MainPID', '--value')).stdout.trim()),
    async start() {
      await rm(readyFile, { force: true })
      await systemctl('start', unit)
      return ready()
    },
    async restart() {
      await rm(readyFile, { force: true })
      await rm(preservingFile, { force: true })
      await systemctl('restart', unit)
      return ready()
    },
    waitForPreservation: () => readUntil(async () => {
      try {
        return await readFile(preservingFile, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        return undefined
      }
    }, value => value === 'preserving', { timeoutMs: 10_000, description: 'Main checking restart preservation' }),
    stop: () => systemctl('stop', unit),
    async close() {
      try {
        await systemctl('stop', unit)
        for (const owner of new Set(registry.snapshot().launches.map(launch => launch.owner))) {
          if (!await registry.closeOwner(owner)) throw new Error('Installed fixture native cleanup is unconfirmed.')
        }
      } finally {
        // A failed assertion can leave native children in this fixture's unit.
        // Kill only that unit after the registry has attempted normal cleanup.
        await systemctl('kill', '--kill-whom=all', '--signal=SIGKILL', unit).catch(error => {
          if (!/not running|not loaded|No such process/.test(String(error.stderr))) throw error
        })
        await rm(unitPath, { force: true })
        await systemctl('daemon-reload')
        await systemctl('reset-failed', unit).catch(error => {
          if (!String(error.stderr).includes('not loaded')) throw error
        })
      }
    },
  }
}
