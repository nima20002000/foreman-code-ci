import { beforeAll, describe, expect, it } from 'vitest'
import { assertInstalledWorkflowRestart } from './helpers/installedWorkflowRestart.js'
import { installationUpdateFixture } from './helpers/harnessInstallationUpdate.js'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deployProductionApi } from '../../../scripts/local-production-runtime.mjs'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'

describe('installed Main-local workflows across systemd restart', () => {
  let recovered: Awaited<ReturnType<typeof assertInstalledWorkflowRestart>>
  const setupPhases = new Map<string, number>()
  beforeAll(async () => {
    const fixture = await installationUpdateFixture({
      workflow: 'interval',
      executionHost: 'main',
      installedMainService: true,
      reportPhase: (phase, elapsedMs) => {
        setupPhases.set(phase, elapsedMs)
        if (phase === 'source repository and workflow seed') {
          // Leave the three-minute file budget for native admission, restart and settlement.
          expect(elapsedMs).toBeLessThan(45_000)
        }
      },
    })
    try {
      recovered = await assertInstalledWorkflowRestart('admitting interval', fixture)
    } finally {
      await fixture.close()
    }
  }, 600_000)

  it('packages the installed API within the restart scenario setup budget', () => {
    expect(setupPhases.get('source repository and workflow seed')).toBeLessThan(45_000)
  })

  it('reattaches graph work and its admitting interval check, then closes their processes', () => {
    expect(recovered.run.executionState).toBe('running')
  })

  it('persists both original turn admissions before recovering the blocked interval session', () => {
    const active = recovered.executions.filter(execution => execution.state === 'running')
    expect(active).toHaveLength(2)
    for (const execution of active) {
      expect(recovered.activity.some(activity => activity.harnessExecutionId === execution.id
        && activity.payload.nativeEventType === 'turn.started')).toBe(true)
    }
  })

  it('deploys a cold dependency cache once for concurrent installed API releases', async () => {
    const directory = await privateFixtureDirectory('parallel-api-releases-')
    const source = join(directory, 'source')
    try {
      await mkdir(join(source, 'apps/api/dist'), { recursive: true })
      await mkdir(join(source, 'packages/contracts/dist'), { recursive: true })
      await writeFile(join(source, 'pnpm-lock.yaml'), 'lock: fixture\n')
      await writeFile(join(source, 'apps/api/package.json'), '{"name":"@foreman-code/api"}')
      await writeFile(join(source, 'packages/contracts/package.json'), '{"name":"@foreman-code/contracts"}')
      await writeFile(join(source, 'packages/contracts/dist/index.js'), 'export const fixture = true\n')
      let deployments = 0
      const run = async (_command: string, args: string[]) => {
        if (!args.includes('deploy')) return
        deployments++
        const destination = args.at(-1)!
        await mkdir(join(destination, 'node_modules/@foreman-code'), { recursive: true })
        await mkdir(join(destination, 'node_modules/contracts/dist'), { recursive: true })
        await writeFile(join(destination, 'node_modules/contracts/package.json'),
          '{"name":"@foreman-code/contracts"}')
        await symlink('../contracts', join(destination, 'node_modules/@foreman-code/contracts'))
        await writeFile(join(destination, 'package.json'), '{"name":"@foreman-code/api"}')
      }
      const destinations = [join(directory, 'first'), join(directory, 'second')]
      await Promise.all(destinations.map(destination => deployProductionApi(run, destination, {
        dependencies: { root: join(directory, 'dependencies'), source },
      })))
      expect(deployments).toBe(1)
      for (const destination of destinations) {
        expect(JSON.parse(await readFile(join(destination, 'package.json'), 'utf8')))
          .toEqual({ name: '@foreman-code/api' })
      }
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
