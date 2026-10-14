import { beforeAll, describe, expect, it } from 'vitest'
import { RuntimeBuildIdentitySchema } from '@foreman-code/contracts'
import { createRuntimeBuildIdentity } from '@foreman-code/contracts/runtime-build-identity-node'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { installationUpdateFixture } from './helpers/harnessInstallationUpdate.js'
import { assertInstalledWorkflowRestart } from './helpers/installedWorkflowRestart.js'
import { useInstalledRestartFixture } from './helpers/installedRestartFixture.js'
import { readUntil } from './helpers/observableCondition.js'

describe('installed Main-local workflows across systemd restart', () => {
  let fixture: Awaited<ReturnType<typeof installationUpdateFixture>> | undefined
  const repository = fileURLToPath(new URL('../../../', import.meta.url))
  const readBuildIdentity = () => fetch(new URL('/api/runtime/build-identity/v1', fixture!.origin()), {
    headers: { authorization: `Bearer ${fixture!.writer.token}` },
  })

  const installedFixture = useInstalledRestartFixture()
  beforeAll(() => { fixture = installedFixture() })

  it('reattaches graph work and its active check, then closes their processes', async () => {
    await fixture!.provider.blockModels({ workingDirectory: join(fixture!.directory, 'main-runtime') })
    let recovered = false
    const recovery = assertInstalledWorkflowRestart('active', fixture!).then(() => { recovered = true })
    try {
      await readUntil(async () => recovered, value => value, {
        timeoutMs: 60_000,
        description: 'recovery while unchanged profile checks are unavailable',
      })
    } finally {
      await fixture!.provider.releaseModels()
      await recovery
    }
  }, 600_000)

  it('serves the packaged build identity after workflow recovery', async () => {
    const response = await readBuildIdentity()
    expect(response.status).toBe(200)
    const identity = RuntimeBuildIdentitySchema.parse(await response.json())
    expect(identity).toEqual(createRuntimeBuildIdentity(repository))
  })
})
