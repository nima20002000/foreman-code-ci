import { lstat, readdir } from 'node:fs/promises'
import { join } from 'node:path'

interface StorageDirectory {
  path: string
  device: number
  inode: number
  modifiedAt: number
  changedAt: number
}

export interface RepositoryStorageSnapshot {
  paths: string[]
  files: string[]
  directories: StorageDirectory[]
  bytes: number
  usedAt: number
}

async function metadata(path: string) {
  return lstat(path).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
}

/** One pool covers the entire tree, so nested directories cannot multiply filesystem concurrency. */
async function visitStorage(paths: readonly string[], visit: (path: string) => Promise<string[]>) {
  const queue = [...paths]
  const waiting: (() => void)[] = []
  let active = 0
  let failure: { error: unknown } | undefined
  const work = async () => {
    for (;;) {
      const path = failure ? undefined : queue.pop()
      if (path === undefined) {
        if (!active || failure) return
        await new Promise<void>(resolve => waiting.push(resolve))
        continue
      }
      active++
      try {
        const children = await visit(path)
        for (const child of children) queue.push(child)
      } catch (error) { failure ??= { error } }
      finally {
        active--
        for (const wake of waiting.splice(0)) wake()
      }
    }
  }
  await Promise.all(Array.from({ length: 32 }, work))
  if (failure) throw failure.error
}

export async function readRepositoryStorage(paths: string[]): Promise<RepositoryStorageSnapshot> {
  const snapshot: RepositoryStorageSnapshot = { paths, files: [], directories: [], bytes: 0, usedAt: 0 }
  await visitStorage(paths, async path => {
    const info = await metadata(path)
    if (!info) return []
    if (!info.isDirectory()) {
      snapshot.bytes += info.size
      snapshot.usedAt = Math.max(snapshot.usedAt, info.atimeMs, info.mtimeMs)
      snapshot.files.push(path)
      return []
    }
    snapshot.directories.push({ path, device: info.dev, inode: info.ino,
      modifiedAt: info.mtimeMs, changedAt: info.ctimeMs })
    const names = await readdir(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    })
    return names.map(name => join(path, name))
  })
  return snapshot
}

/** Recheck the recorded inventory without enumerating dependency trees a second time under exclusive locks. */
export async function repositoryStorageChanged(snapshot: RepositoryStorageSnapshot, paths: string[]) {
  const originalPaths = new Set(snapshot.paths)
  if (paths.length !== originalPaths.size || paths.some(path => !originalPaths.has(path))) return true
  const directories = new Map(snapshot.directories.map(directory => [directory.path, directory]))
  let changed = false
  await visitStorage([...snapshot.files, ...directories.keys()], async path => {
    if (changed) return []
    const info = await metadata(path)
    const directory = directories.get(path)
    if (directory) {
      if (!info?.isDirectory() || info.dev !== directory.device || info.ino !== directory.inode
        || info.mtimeMs !== directory.modifiedAt || info.ctimeMs !== directory.changedAt) changed = true
    } else if (info && Math.max(info.atimeMs, info.mtimeMs) > snapshot.usedAt) changed = true
    return []
  })
  return changed
}
