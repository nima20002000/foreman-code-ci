import type pg from 'pg'
import { expect, it } from 'vitest'
import { DeviceApplicationError } from '../../src/modules/devices/deviceApplicationError.js'
import { DomainError } from '../../src/modules/errors.js'
import { ProductionHostCiEndpoint } from '@foreman-code/ci/endpoint'
import type { HostCiComputer } from '@foreman-code/ci/service'

const computer: HostCiComputer = { key: 'fixture:worker', label: 'Paired executor', priority: 1,
  hostRef: { kind: 'device', mainId: 'fixture-main', deviceId: 'fixture-worker' } }
const cancel = { operation: 'cancel', runId: '11111111-1111-4111-8111-111111111111' } as const

function endpoint(error: Error) {
  return new ProductionHostCiEndpoint({} as pg.Pool, 'fixture-main', () => ({
    capabilities: () => [], request: async () => { throw error },
  }), { handle: async () => { throw new Error('Unexpected local execution') } })
}

it('preserves an authenticated worker unknown-run reply as the CI domain error used by retained cleanup', async () => {
  const remote = new DeviceApplicationError('CI_RUN_UNKNOWN')
  await expect(endpoint(remote).request(computer, cancel)).rejects.toBeInstanceOf(DomainError)
  await expect(endpoint(remote).request(computer, cancel)).rejects.toMatchObject({ code: 'CI_RUN_UNKNOWN' })
})

it.each(['transport', 'permission', 'timeout'])('does not turn device %s failures into unknown-run confirmations', async code => {
  const error = new DeviceApplicationError(code)
  await expect(endpoint(error).request(computer, cancel)).rejects.toBe(error)
})
