import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { CiRunRecordSchema } from '@foreman-code/contracts'
import { componentLogger } from '../diagnostics/logger.js'
import { withHostCiRunLock } from './runnerLock.js'
import type { CiUnitState } from './unitStates.js'
import { readRepositoryStorage, repositoryStorageChanged,
  type RepositoryStorageSnapshot } from './repositoryStorageUsage.js'

const log = componentLogger('jobs')
const ownershipSchema = CiRunRecordSchema.pick({ repository: true, state: true })

export interface CiRepositoryStorageEntry {
  path: string
  repository: string
  bytes: number
  usedAt: number
  repositoryStorage: true
  snapshot: RepositoryStorageSnapshot
}

async function children(path: string) {
  try { return await readdir(path, { withFileTypes: true }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function repositoryContents(root: string, repository: string) {
  const paths: string[] = []
  for (const area of ['git', 'slots']) {
    const path = join(root, area, ...repository.split('/'))
    for (const child of await children(path)) paths.push(join(path, child.name))
  }
  return paths
}

export async function ciRepositoryStorageEntries(root: string) {
  const repositories = new Set<string>()
  for (const area of ['git', 'slots']) {
    for (const owner of await children(join(root, area))) {
      if (!owner.isDirectory()) continue
      for (const repository of await children(join(root, area, owner.name))) {
        if (repository.isDirectory()) repositories.add(`${owner.name}/${repository.name}`)
      }
    }
  }
  const entries: CiRepositoryStorageEntry[] = []
  for (const repository of repositories) {
    const snapshot = await readRepositoryStorage(await repositoryContents(root, repository))
    entries.push({ path: join(root, 'git', ...repository.split('/')), repository,
      bytes: snapshot.bytes, usedAt: snapshot.usedAt, repositoryStorage: true, snapshot })
  }
  return entries
}

async function runOwnership(path: string): Promise<{ repository: string | null; active: boolean | null }> {
  let raw: unknown
  try { raw = JSON.parse(await readFile(join(path, 'meta.json'), 'utf8')) }
  catch (error) {
    log.warn({ err: error, runDirectory: path }, 'CI storage cleanup found unreadable run metadata; checking ownership locks')
    return { repository: null, active: null }
  }
  const parsed = ownershipSchema.safeParse(raw)
  if (parsed.success) {
    return { repository: parsed.data.repository, active: ['starting', 'running'].includes(parsed.data.state) }
  }
  const repository = ownershipSchema.shape.repository.safeParse(
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>).repository : undefined)
  log.warn({ runDirectory: path }, 'CI storage cleanup found invalid run metadata; checking ownership locks')
  return { repository: repository.success ? repository.data : null, active: null }
}

async function runMayOwnRepository(path: string, repository: string, unitState?: () => Promise<CiUnitState>) {
  const owner = await runOwnership(path)
  if (owner.repository !== null && owner.repository !== repository) return false
  if (owner.active !== null) return owner.active
  try {
    const active = await withHostCiRunLock(path, async () => {
      const current = await runOwnership(path)
      if (current.repository !== null && current.repository !== repository) return false
      if (current.active !== null) return current.active
      // All three ownership locks exclude a new launch while native closure is checked.
      const state = await unitState?.()
      if (state === 'stopped') return false
      log.warn({ runDirectory: path, unitState: state ?? 'unavailable' },
        'CI storage cleanup is preserving a damaged run whose native closure is unconfirmed')
      return true
    }, { nonBlocking: true })
    return active ?? true
  } catch (error) {
    log.warn({ err: error, runDirectory: path }, 'CI storage cleanup could not confirm idle run ownership')
    return true
  }
}

async function repositoryHasActiveRun(root: string, repository: string,
  unitState?: (runId: string) => Promise<CiUnitState>) {
  for (const run of await children(join(root, 'runs'))) {
    if (!run.isDirectory()) continue
    if (await runMayOwnRepository(join(root, 'runs', run.name), repository,
      unitState ? () => unitState(run.name) : undefined)) return true
  }
  return false
}

/** Slot checkouts depend on the clone's objects; reclaim both only while the whole repository is idle. */
export async function reclaimCiRepositoryStorage(root: string,
  entry: CiRepositoryStorageEntry,
  activeRepositories: () => ReadonlySet<string>,
  unitState?: (runId: string) => Promise<CiUnitState>): Promise<string[] | undefined> {
  if (activeRepositories().has(entry.repository)) return
  const cache = join(root, 'cache', ...entry.repository.split('/'))
  await mkdir(cache, { recursive: true, mode: 0o700 })
  await mkdir(entry.path, { recursive: true, mode: 0o700 })
  return withHostCiRunLock(cache, () => withHostCiRunLock(entry.path, async () => {
    // Persisted admissions cover another runner's gap between checkout and native cache-lock acquisition.
    if (activeRepositories().has(entry.repository) || await repositoryHasActiveRun(root, entry.repository, unitState)) return
    const paths = await repositoryContents(root, entry.repository)
    if (await repositoryStorageChanged(entry.snapshot, paths)) return
    for (const path of paths) await rm(path, { recursive: true, force: true })
    // Keep lock directory inodes stable for waiters that opened them before this sweep.
    return paths
  }, { nonBlocking: true }), { nonBlocking: true })
}
