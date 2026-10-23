import type { ComputerActivity } from '@foreman-code/contracts/computer-activity'
import { useComputerUtilizations } from '../../shared/api/computerActivity'
import { metricView, sampleClock, useMonotonicElapsed } from '../resource-telemetry'
import { computerLoad } from './computerLoad'

/** Keep cached readings as last known when activity or telemetry cannot refresh. */
export function useComputerFleetReadings(computers: ComputerActivity[], fresh: boolean) {
  const queries = useComputerUtilizations(computers.map(computer => ({ target: computer.target, online: fresh && computer.online })))
  const firstReceived = queries.find(query => query.data)?.data?.receivedMonoMs
  const elapsed = useMonotonicElapsed(firstReceived)
  const now = (firstReceived ?? performance.now()) + elapsed
  return computers.map((computer, index) => {
    const received = queries[index]?.data
    const sample = computer.online && received?.result.kind === 'sample' ? received.result.sample : undefined
    const age = received ? Math.max(0, now - received.receivedMonoMs) + received.requestDurationMs : 0
    const cpu = sample?.cpu.state === 'fresh' ? sample.cpu.value : null
    const memory = sample?.memory.state === 'fresh' ? sample.memory.value : null
    const current = fresh && !queries[index]?.isError
    const stale = { cpu: !current || !sample || metricView('CPU', sample, age).status !== 'fresh',
      memory: !current || !sample || metricView('RAM', sample, age).status !== 'fresh' }
    const storage = current && sample?.storage && sampleClock(sample, age).freshRemainingMs > 0 ? sample.storage : null
    const level = computerLoad({ online: fresh ? computer.online : null,
      cpuPercent: !stale.cpu ? cpu?.hostCapacityPercent ?? null : null,
      memoryPercent: !stale.memory && memory?.totalBytes ? memory.bytes / memory.totalBytes * 100 : null,
      diskUsedPercent: storage?.totalBytes ? (storage.totalBytes - storage.availableBytes) / storage.totalBytes * 100 : null,
      workloads: computer.agents.length + computer.jobs.length })
    return { computer, cpu, memory, level, stale }
  })
}
