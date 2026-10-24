import { lstat, readFile, readdir, readlink, realpath, unlink } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { componentLogger } from '../diagnostics/index.js'

/** What an interrupted fetch can leave in the common directory. Other writers' state (refs/heads, HEAD, index and
 * linked worktrees' files) is never touched. */
const FETCH_LOCKS = ['FETCH_HEAD.lock', 'packed-refs.lock']
const REPOSITORY_LOCKS = new Set(['shallow.lock', 'gc.pid.lock'])
const REPOSITORY_WRITERS = new Set(['fetch', 'pull', 'clone', 'fetch-pack', 'receive-pack', 'gc', 'maintenance', 'repack',
  'index-pack', 'pack-objects'])
const FETCH_REF_NAMESPACES = ['refs/remotes', 'refs/foreman']
const TEMPORARY_PACK = /^tmp_(?:pack|idx|rev)_/u
/** Ref transactions and index-pack's close-to-rename last well under a second, and a receiving pack keeps growing. */
const STALE_MS = 5 * 60_000

function absent(error: unknown): boolean {
  return ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
}

async function entries(directory: string, recursive = false): Promise<string[]> {
  try {
    return (await readdir(directory, { withFileTypes: true, recursive }))
      .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
  } catch (error) {
    if (absent(error)) return []
    throw error
  }
}

async function namesRepository(path: string, common: string): Promise<boolean> {
  try {
    let directory = path
    try {
      const pointer = /^gitdir: (.+)\s*$/u.exec(await readFile(path, 'utf8'))
      if (!pointer) return false
      directory = resolve(dirname(path), pointer[1]!.trim())
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EISDIR') throw error
    }
    directory = await realpath(directory)
    return directory === common || resolve(directory, (await readFile(join(directory, 'commondir'), 'utf8')).trim()) === common
  } catch (error) {
    if (absent(error)) return false
    throw error
  }
}

/** Shallow/GC locks contain no reliable owner PID. Inspect live Git writers, including linked worktrees and explicit
 * Git directories; readers and ref-only writers cannot own these locks. Uncertain same-user ownership is kept. */
async function repositoryWriterAlive(common: string): Promise<boolean> {
  for (const pid of (await readdir('/proc')).filter(name => /^\d+$/u.test(name))) {
    const processPath = `/proc/${pid}`
    try {
      if ((await lstat(processPath)).uid !== process.getuid?.()) continue
      if (!/^git(?:-|$)/u.test((await readFile(`${processPath}/comm`, 'utf8')).trim())) continue
      const args = (await readFile(`${processPath}/cmdline`, 'utf8')).split('\0')
      if (!args.some(arg => REPOSITORY_WRITERS.has(basename(arg).replace(/^git-/u, '')))) continue
      const cwd = await readlink(`${processPath}/cwd`)
      const gitDir = (await readFile(`${processPath}/environ`, 'utf8')).split('\0')
        .find(entry => entry.startsWith('GIT_DIR='))?.slice('GIT_DIR='.length)
      const explicit = args.flatMap((arg, index) => arg === '--git-dir' ? [args[index + 1]!]
        : arg.startsWith('--git-dir=') ? [arg.slice('--git-dir='.length)] : [])
      for (const path of [...explicit, ...(gitDir ? [gitDir] : [])]) {
        if (await namesRepository(resolve(cwd, path), common)) return true
      }
      if (cwd === common || cwd.startsWith(common + '/')) return true
      for (let directory = cwd; directory !== dirname(directory); directory = dirname(directory)) {
        if (await namesRepository(join(directory, '.git'), common)) return true
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EACCES' || code === 'EPERM') return true
      if (!absent(error) && code !== 'ESRCH') throw error
    }
  }
  return false
}

/** The caller holds the repository lock, which every Main fetch writer inherits for its whole life, so none of them
 * is alive. Other Git processes (Agents, people) may still write here, so an artifact is abandoned only once it has
 * stayed unchanged past the staleness bound. Shallow/GC locks instead require the absence of a live Git writer.
 * An observed interruption also permits cleaning that fetch's explicit
 * destination locks and its per-worktree FETCH_HEAD lock. Returns the fresh artifacts, which are left alone. */
export async function removeAbandonedFetchArtifacts(common: string,
  interruptedFetch?: { startedAt: number; destinationRefs: string[]; fetchHead: boolean }): Promise<string[]> {
  const refLocks = (await Promise.all(FETCH_REF_NAMESPACES.map(namespace => entries(join(common, namespace), true))))
    .flat().filter(path => path.endsWith('.lock'))
  const packs = (await entries(join(common, 'objects', 'pack'))).filter(path => TEMPORARY_PACK.test(basename(path)))
  const locks = new Set([...FETCH_LOCKS, ...REPOSITORY_LOCKS].map(name => join(common, name)).concat(refLocks))
  const ownLocks = new Set(interruptedFetch?.destinationRefs.map(ref => `${ref}.lock`))
  if (interruptedFetch?.fetchHead) ownLocks.add('FETCH_HEAD.lock')
  const fresh: string[] = []
  let liveWriter: boolean | undefined
  for (const path of [...locks, ...packs]) {
    try {
      const stat = await lstat(path)
      if (!stat.isFile()) continue
      if (REPOSITORY_LOCKS.has(relative(common, path))) {
        liveWriter ??= await repositoryWriterAlive(common)
        if (liveWriter) fresh.push(path)
        else await unlink(path)
        continue
      }
      const interruptedLock = interruptedFetch !== undefined && ownLocks.has(relative(common, path))
        && stat.mtimeMs >= interruptedFetch.startedAt
      if (!interruptedLock && Date.now() - stat.mtimeMs < STALE_MS) fresh.push(path)
      else await unlink(path)
    } catch (error) {
      if (!absent(error)) throw error
    }
  }
  return fresh
}

/** Git cannot fetch past another writer's lock, so wait (recovering locks as they go stale) within `signal`. */
export async function awaitFetchLocks(common: string, signal: AbortSignal): Promise<void> {
  let logged = false
  while ((await removeAbandonedFetchArtifacts(common)).some(path => path.endsWith('.lock'))) {
    if (!logged) componentLogger('byte-transfer').info({ common }, 'Fetch waits for a fresh Git lock in the repository.')
    logged = true
    await delay(1000, undefined, { signal })
  }
}
