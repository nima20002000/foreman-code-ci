import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { MaintenanceTask } from '@foreman-code/contracts/computer-maintenance'
import { MaintenanceCommandStore } from './maintenanceCommandStore.js'
import { MaintenanceTaskStore } from './maintenanceTaskStore.js'

const task = (): MaintenanceTask => ({ id: randomUUID(), kind: 'restart', state: 'running',
  startedAt: '2026-01-01T00:00:00.000Z', finishedAt: null, summary: 'Restarting', outputTail: '' })
const hash = `sha256:${'a'.repeat(64)}`

function ports() {
  const files = new Map<string, string>()
  let failNext = false
  return {
    failNextWrite() { failNext = true },
    ports: {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      readText: vi.fn(async (path: string) => files.get(path) ?? null),
      writePrivateText: vi.fn(async (path: string, text: string) => {
        if (failNext) { failNext = false; throw new Error('EIO: disk write failed') }
        files.set(path, text)
      }),
    },
  }
}

it('keeps saving maintenance tasks after one write failed', async () => {
  const f = ports()
  const store = new MaintenanceTaskStore('/state/tasks.json', f.ports)
  f.failNextWrite()
  await expect(store.save([task()])).rejects.toThrow('EIO')
  await expect(store.flushed()).rejects.toThrow('EIO')
  await store.save([task()])
  await store.flushed()
  expect(await store.load()).toHaveLength(1)
})

it('keeps saving and reading maintenance commands after one write failed', async () => {
  const f = ports()
  const store = new MaintenanceCommandStore('/state/commands', f.ports)
  const command = randomUUID()
  f.failNextWrite()
  await expect(store.save(command, hash, task())).rejects.toThrow('EIO')
  await expect(store.flushed()).rejects.toThrow('EIO')
  await expect(store.read(command)).resolves.toBeUndefined()
  await store.save(command, hash, task())
  await store.flushed()
  expect((await store.read(command))?.requestHash).toBe(hash)
})
