import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { CiIntegrationCoverageSchema, type CiCoverageSelection, type IntegrationCoverage } from '@foreman-code/contracts'
import { compactIntegrationCoverage, completeIntegrationCoverage } from '@foreman-code/contracts/ci-coverage'
import { ciInfrastructureFile } from '@foreman-code/contracts/ci-import-graph'
import type { CiCommits } from './serviceTypes.js'

export class IntegrationCoverageStore {
  private readonly writes = new Map<string, Promise<void>>()
  private selections = new WeakMap<object, Map<string, Promise<CiCoverageSelection>>>()

  constructor(private readonly root = join(homedir(), '.cache/foreman-code/integration-coverage')) {}

  private directory(repository: string) {
    return join(this.root, createHash('sha256').update(repository).digest('hex'))
  }

  /** CI partitions report independently; serialize merges so the last partition cannot erase its siblings. */
  async record(repository: string, commit: string, fragment: IntegrationCoverage) {
    const path = join(this.directory(repository), `${commit}.json`)
    const previous = this.writes.get(path) ?? Promise.resolve()
    const pending = previous.then(async () => {
      const parsed = CiIntegrationCoverageSchema.parse({ ...fragment, commit })
      const saved = await this.read(path)
      const coverage = { ...saved?.coverage }
      for (const [file, files] of Object.entries(parsed.coverage)) {
        coverage[file] = [...new Set([...(coverage[file] ?? []), ...files])].sort()
      }
      const staticTests = [...new Set([...(saved?.staticTests ?? []), ...(parsed.staticTests ?? [])])].sort()
      const merged = CiIntegrationCoverageSchema.parse({ ...parsed, coverage, staticTests })
      await mkdir(this.directory(repository), { recursive: true })
      await writeFile(`${path}.writing`, JSON.stringify(merged))
      await rename(`${path}.writing`, path)
      this.selections = new WeakMap()
    })
    this.writes.set(path, pending)
    try { await pending }
    finally { if (this.writes.get(path) === pending) this.writes.delete(path) }
  }

  private async read(path: string): Promise<IntegrationCoverage | undefined> {
    try { return CiIntegrationCoverageSchema.parse(JSON.parse(await readFile(path, 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  selection(repository: string, commit: string, commits: Pick<CiCommits, 'isAncestor' | 'testTree'>) {
    const key = `${repository}:${commit}`
    let cache = this.selections.get(commits)
    if (!cache) {
      cache = new Map()
      this.selections.set(commits, cache)
    }
    const saved = cache.get(key)
    if (saved) return saved
    const pending = this.select(repository, commit, commits).catch(error => {
      cache.delete(key)
      throw error
    })
    cache.set(key, pending)
    if (cache.size > 32) cache.delete(cache.keys().next().value!)
    return pending
  }

  private async select(repository: string, commit: string, commits: Pick<CiCommits, 'isAncestor' | 'testTree'>)
    : Promise<CiCoverageSelection> {
    const fallback = (reason: string): CiCoverageSelection => ({ changedFiles: [], reason })
    if (!commits.isAncestor || !commits.testTree) return fallback('Repository ancestry or source trees are unavailable.')
    let paths: string[]
    try { paths = await readdir(this.directory(repository)) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback('No integration coverage artifacts are available.')
      throw error
    }
    let newest: IntegrationCoverage | undefined
    for (const path of paths.filter(path => /^[a-f0-9]{40}(?:[a-f0-9]{24})?\.json$/.test(path))) {
      const map = await this.read(join(this.directory(repository), path))
      if (!completeIntegrationCoverage(map) || !await commits.isAncestor(repository, map.commit, commit)) continue
      if (!newest || await commits.isAncestor(repository, newest.commit, map.commit)) newest = map
    }
    if (!newest) return fallback('No complete coverage map from an ancestor commit is available.')
    const [before, after] = await Promise.all([
      commits.testTree(repository, newest.commit), commits.testTree(repository, commit),
    ])
    const changedFiles = [...new Set([...before.blobs.keys(), ...after.blobs.keys()])]
      .filter(file => before.blobs.get(file) !== after.blobs.get(file)).sort()
    if (changedFiles.some(ciInfrastructureFile)) return fallback('Coverage map predates lockfile or CI infrastructure changes.')
    const map = gzipSync(JSON.stringify(compactIntegrationCoverage(newest))).toString('base64')
    if (map.length > 700_000) return fallback('Coverage map exceeds the device report limit.')
    return { map, changedFiles }
  }
}
