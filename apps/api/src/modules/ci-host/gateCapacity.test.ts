import { expect, it } from 'vitest'
import { planCiGate } from './gate.js'
import type { HostCiComputer, HostCiEndpoint } from './serviceTypes.js'

function fleet(): HostCiEndpoint {
  const computers: HostCiComputer[] = [
    { key: 'builder', label: 'Build computer', priority: 10, hostRef: { kind: 'main', mainId: 'fixture' } },
    ...Array.from({ length: 14 }, (_, slot) => ({ key: `github:${slot}`, label: `GitHub ${slot}`, priority: 30,
      hostRef: { kind: 'cloud' as const, mainId: 'fixture', provider: 'github' as const, slot },
      userSystemd: { supported: true, reason: null } })),
  ]
  return { computers: async () => computers,
    request: async computer => ({ operation: 'status', ready: true, reasons: [], runs: [],
      cpuCount: computer.hostRef.kind === 'cloud' ? 4 : 5, memoryBytes: 16 * 2 ** 30,
      slotsUsed: 0, slotsTotal: 1 }),
  }
}

const unitFiles = ['apps/api/src', 'apps/web/src'].flatMap((directory, index) =>
  Array.from({ length: index === 0 ? 24 : 8 }, (_, file) => `${directory}/feature-${file}.test.ts`))
const unit = { files: unitFiles, durations: Object.fromEntries(unitFiles.map(file => [file, 50_000])), heavy: [] }

it('refuses a large host-only integration plan when checks consume all eligible cloud slots', async () => {
  const files = Array.from({ length: 901 }, (_, index) => `apps/api/test/feature-${index}.integration.test.ts`)
  await expect(planCiGate({ suite: 'integration', scope: 'full', gate: true },
    { files, durations: Object.fromEntries(files.map(file => [file, 30_000])) }, unit, {}, fleet()))
    .rejects.toMatchObject({ code: 'CI_GATE_CAPACITY_REQUIRED', details: { retryable: true } })
})

it('keeps a small host-only plan that finishes before cloud checks can release an executor', async () => {
  const files = ['apps/api/test/first.integration.test.ts', 'apps/api/test/second.integration.test.ts']
  const parts = await planCiGate({ suite: 'integration', scope: 'full', gate: true },
    { files, durations: Object.fromEntries(files.map(file => [file, 10_000])) }, unit, {}, fleet())
  const integration = parts.filter(part => part.suite === 'integration')
  expect(integration).toHaveLength(1)
  expect(integration[0]).toMatchObject({ plannedHostKey: 'builder' })
  expect(integration[0]!.files.sort()).toEqual([...files].sort())
})
