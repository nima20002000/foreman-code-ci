import { lstat, readFile, readlink, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

function missingMetadata(error: unknown): undefined {
  const code = (error as NodeJS.ErrnoException).code
  if (code === 'ENOENT' || code === 'ENOTDIR') return undefined
  throw error
}

/** Missing metadata still names a dependency; resolve its existing ancestors and symlink targets. */
async function canonicalDependencyPath(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (error) {
    missingMetadata(error)
  }
  const parent = dirname(path)
  const details = await lstat(path).catch(missingMetadata)
  if (details?.isSymbolicLink()) {
    return canonicalDependencyPath(resolve(parent, await readlink(path)))
  }
  return join(await canonicalDependencyPath(parent), basename(path))
}

async function gitDirectories(root: string): Promise<string[]> {
  let directory = root
  for (;;) {
    const marker = join(directory, '.git')
    const details = await lstat(marker).catch(missingMetadata)
    if (details) {
      const target = details.isSymbolicLink() ? await stat(marker).catch(missingMetadata) : details
      let gitDirectory = marker
      if (target?.isFile()) {
        const content = await readFile(marker, 'utf8')
        if (!content.startsWith('gitdir: ') || !content.slice(8).trimEnd()) {
          throw new Error('The worktree Git directory reference is invalid.')
        }
        gitDirectory = resolve(directory, content.slice(8).trimEnd())
      }
      gitDirectory = await canonicalDependencyPath(gitDirectory)
      const common = await readFile(join(gitDirectory, 'commondir'), 'utf8').catch(missingMetadata)
      const dependencies = [gitDirectory]
      if (common !== undefined) {
        if (!common.trimEnd()) throw new Error('The worktree Git common-directory reference is empty.')
        dependencies.push(await canonicalDependencyPath(resolve(gitDirectory, common.trimEnd())))
      }
      return dependencies
    }
    const parent = dirname(directory)
    if (parent === directory) return []
    directory = parent
  }
}

/** Git metadata paths remain protected even when Git cannot open the repository. */
export async function withGitDirectoryDependencies(paths: string[]): Promise<string[]> {
  const dependencies = new Set(paths.filter(Boolean))
  for (const path of [...dependencies]) {
    const root = await canonicalDependencyPath(resolve(path))
    dependencies.add(root)
    for (const directory of await gitDirectories(root)) dependencies.add(directory)
  }
  return [...dependencies]
}
