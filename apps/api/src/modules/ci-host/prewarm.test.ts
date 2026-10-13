import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect, it } from 'vitest'
import type { CiHostRequest } from '@foreman-code/contracts'
import type { CiCommits, HostCiComputer, HostCiEndpoint } from './service.js'
import { CiPrewarmService } from './prewarm.js'

function fleet() {
  let commit = 'a'.repeat(40)
  let queued = false
  let busy = false
  const requests: { computer: string; request: CiHostRequest }[] = []
  const host: HostCiComputer = { key: 'builder', label: 'Builder', priority: 0,
    hostRef: { kind: 'device', mainId: 'main', deviceId: 'device' } }
  const cloud: HostCiComputer = { key: 'cloud', label: 'Cloud', priority: 0,
    hostRef: { kind: 'cloud', mainId: 'main', provider: 'github' } }
  const computers = [host, { ...host, key: 'other' }, cloud]
  const pool = { query: async (sql: string) => ({ rows: sql.includes('workspaces')
    ? [{ record: { id: randomUUID(), name: 'Workspace', repository: { provider: 'github', owner: 'example',
      name: 'project', defaultBranch: 'feature' } } }] : [{ busy: queued }] }) } as unknown as pg.Pool
  const commits: Pick<CiCommits, 'heads'> = { heads: async () => [
    { branch: 'main', commit }, { branch: 'audit/integration', commit },
  ] }
  const endpoint: HostCiEndpoint = { computers: async () => computers,
    request: async (computer, request) => {
      requests.push({ computer: computer.key, request })
      if (request.operation === 'status') return { operation: 'status', ready: true, prewarmSupported: true,
        slotsUsed: Number(busy), cpuCount: 8, memoryBytes: 16 * 2 ** 30, runs: [], reasons: [] }
      if (request.operation !== 'start') throw new Error('Unexpected request')
      return { operation: 'start', run: { runId: request.runId, state: 'passed', warmup: true, step: null,
        exitCode: 0, startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), logBytes: 0, message: null } }
    } }
  return { service: new CiPrewarmService(pool, commits, endpoint), requests,
    advance: () => { commit = 'b'.repeat(40) }, queue: (value: boolean) => { queued = value },
    busy: (value: boolean) => { busy = value } }
}

it('warms each observed commit once on each enabled build computer, excluding cloud slots', async () => {
  const f = fleet()
  await f.service.poll()
  await f.service.poll()
  const starts = () => f.requests.filter(item => item.request.operation === 'start')
  expect(starts()).toHaveLength(2)
  expect(starts().map(item => item.computer)).toEqual(['builder', 'other'])
  expect(starts()[0]?.request).toMatchObject({ warmup: true, suite: 'install', commit: 'a'.repeat(40) })
  f.advance()
  await f.service.poll()
  expect(starts()).toHaveLength(4)
})

it('waits while real CI is queued or active, then warms the latest pending head', async () => {
  const f = fleet()
  f.queue(true)
  await f.service.poll()
  expect(f.requests).toHaveLength(0)
  f.queue(false)
  f.busy(true)
  await f.service.poll()
  expect(f.requests.every(item => item.request.operation === 'status')).toBe(true)
  f.advance()
  f.busy(false)
  await f.service.poll()
  expect(f.requests.filter(item => item.request.operation === 'start')).toHaveLength(2)
  expect(f.requests.at(-1)?.request).toMatchObject({ commit: 'b'.repeat(40) })
})
