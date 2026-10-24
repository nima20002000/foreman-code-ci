import { mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readInstalledWorkflowConfiguration } from './installedWorkflowConfiguration.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, open: vi.fn(actual.open) }
})

const configuration = (expectedVersion: string) => ({ schemaVersion: 1, codexBinary: '/installed/codex',
  expectedVersion, payloadPaths: [], appMcpLauncher: '/installed/app-mcp.mjs' })

let directory: string | undefined
afterEach(async () => {
  vi.mocked(fs.open).mockReset()
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

// The Worker's selection refresh publishes workflow-runtime.json by atomic rename while profile checks read it.
describe('installed workflow configuration read during an atomic replacement', () => {
  it.each(['stat', 'readFile'] as const)('returns the published selection when the file is replaced at %s',
    async method => {
      directory = await realpath(await mkdtemp(join(tmpdir(), 'workflow-runtime-')))
      const path = join(directory, 'workflow-runtime.json')
      await writeFile(path, JSON.stringify(configuration('0.154.0')), { mode: 0o600 })
      const location = { path, ownerUid: process.getuid!() }
      const actualOpen = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open
      let replaced = false
      vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof actualOpen>) => {
        const handle = await actualOpen(...args)
        return new Proxy(handle, { get(target, property) {
          const value = Reflect.get(target, property, target) as unknown
          if (typeof value !== 'function') return value
          if (property !== method || replaced) return value.bind(target)
          return async (...values: unknown[]) => {
            replaced = true
            // Timestamps are tick-grained; let the replacement land in a later tick, as it does in production.
            await new Promise(resolve => setTimeout(resolve, 25))
            await writeFile(`${path}.next`, JSON.stringify(configuration('0.156.1')), { mode: 0o600 })
            await rename(`${path}.next`, path)
            return (value as (...input: unknown[]) => unknown).apply(target, values)
          }
        } })
      })
      await expect(readInstalledWorkflowConfiguration(location)).resolves.toEqual(configuration('0.156.1'))
      expect(replaced).toBe(true)
    })
})
