import { randomUUID } from 'node:crypto'
import { lstat, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import type { NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
import { privateDirectory, writeRecord } from '../harnesses/recovery/storage.js'
import { ownedTestPath } from '../../../test/helpers/testResources.js'
import { createInstalledWorkerAccounts } from './installedWorkerAccounts.js'
import type { AccountIsolationQualification } from './productionSelection.js'

it('finishes the native home of a slot whose first provisioning was interrupted after its record was written', async () => {
  const root = privateDirectory(ownedTestPath(join(process.env.FOREMAN_CODE_TEST_ROOT!, `worker-slot-retry-${randomUUID()}`)))
  try {
    const connection = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
      bootId: randomUUID(), connectionEpoch: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 }
    const target = { hostRef: { kind: 'device' as const, mainId: connection.mainId, deviceId: connection.deviceId },
      applicationInstallationId: connection.workerInstallationId, keyRevision: 1, authorizationRevision: 1 }
    const record: AccountIsolationQualification = { qualificationId: 'worker-storage-proof', provider: 'codex', generation: 1,
      target, expiresAt: '2099-01-01T00:00:00.000Z', isolation: true, storage: 'provider-keyring',
      scope: { kind: 'managed-slots' }, actions: ['status', 'sign-in'],
      override: { instanceId: randomUUID(), instanceRevision: 'profile-revision', revision: 1, presetId: 'preset',
        enabled: true, driverId: 'codex', configuration: DEFAULT_HARNESS_DEFAULTS.codex,
        configurationFingerprint: 'configuration-fingerprint', qualification: 'qualified',
        target: { hostRef: target.hostRef, applicationInstallationId: target.applicationInstallationId,
          harnessInstallationId: 'actual-installation', installationFingerprint: 'actual-fingerprint' } } }
    writeRecord(join(root, 'provider-account-qualifications.json'), { version: 1, records: [record] })
    const installed = createInstalledWorkerAccounts({ stateDirectory: root, configuration: null, current: () => connection, target,
      registry: { reserveLaunch: vi.fn() } as unknown as NativeProcessRegistry,
      request: vi.fn(async () => { throw new Error('No Main request is expected') }) })!
    const id = randomUUID()
    const account = { id, provider: 'codex' as const, name: 'Worker slot', authMode: 'subscription' as const,
      status: 'unavailable' as const, identity: null, revision: 1, isDefault: false,
      binding: { kind: 'slot' as const, provider: 'codex' as const, accountId: id, profileRef: id, bindingRevision: 1, subject: null, target } }
    // The immutable slot record is retained first; the native home was never created (the first attempt failed).
    writeRecord(join(root, 'provider-account-slots', `${id}.json`), account, true)
    expect(await installed.provision!(account)).toMatchObject({ id })
    expect((await lstat(join(root, 'provider-account-slots', 'native', id, 'home'))).isDirectory()).toBe(true)
    await installed.native.close()
  } finally { await rm(root, { recursive: true, force: true }) }
})
