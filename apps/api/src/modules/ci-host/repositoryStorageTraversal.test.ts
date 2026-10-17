import { mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ciRepositoryStorageEntries, reclaimCiRepositoryStorage } from './repositoryStorage.js'

const reads = vi.hoisted(() => ({ root: '', active: 0, maximum: 0 }))
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => {
    if (!reads.root || !String(args[0]).startsWith(reads.root)) return actual.lstat(...args)
    reads.active++
    reads.maximum = Math.max(reads.maximum, reads.active)
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      return await actual.lstat(...args)
    } finally { reads.active-- }
  } }
})

const roots: string[] = []
afterEach(async () => {
  reads.root = ''
  reads.active = 0
  reads.maximum = 0
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'ci-storage-traversal-'))
  roots.push(root)
  const slot = join(root, 'slots/fixture/site/0')
  await mkdir(join(root, 'git/fixture/site/.git'), { recursive: true })
  for (let directory = 0; directory < 8; directory++) {
    const path = join(slot, 'src/node_modules', `package-${directory}`)
    await mkdir(path, { recursive: true })
    for (let file = 0; file < 8; file++) await writeFile(join(path, `file-${file}`), 'payload')
  }
  return { root, slot }
}

it.each(['accounting', 'reclamation'] as const)(
  'uses bounded overlapping filesystem reads for repository %s under filesystem contention', async phase => {
    const f = await fixture()
    if (phase === 'accounting') reads.root = f.root
    const entries = await ciRepositoryStorageEntries(f.root)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.bytes).toBe(64 * Buffer.byteLength('payload'))
    if (phase === 'reclamation') {
      reads.root = f.root
      await expect(reclaimCiRepositoryStorage(f.root, entries[0]!, () => new Set<string>()))
        .resolves.toContain(f.slot)
      await expect(access(f.slot)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(reads.maximum).toBeGreaterThan(1)
    expect(reads.maximum).toBeLessThanOrEqual(32)
    expect(reads.active).toBe(0)
  },
)

it.each(['edit', 'addition'] as const)('preserves repository storage changed by a %s after accounting', async change => {
  const f = await fixture()
  const entries = await ciRepositoryStorageEntries(f.root)
  const file = join(f.slot, 'src/node_modules/package-0', change === 'edit' ? 'file-0' : 'added')
  await writeFile(file, 'updated payload')
  await expect(reclaimCiRepositoryStorage(f.root, entries[0]!, () => new Set<string>())).resolves.toBeUndefined()
  expect(await readFile(file, 'utf8')).toBe('updated payload')
})
