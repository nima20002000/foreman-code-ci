import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { copyFile, cp, mkdir, readFile, readdir, readlink, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { copyApiRuntime } from '../../../../scripts/copy-api-runtime.mjs'
import { cachedTestFixture, testFixtureCacheRoot } from '../../../../scripts/test-fixture-cache.mjs'
import { measureIntegrationPhase, reportIntegrationPhase } from './integrationPhase.js'

const repository = fileURLToPath(new URL('../../../..', import.meta.url))
const execute = promisify(execFile)
const require = createRequire(join(repository, 'apps/worker/package.json'))
const compiler = require('esbuild') as {
  version: string
  build(options: {
    entryPoints: string[]
    outbase: string
    outdir: string
    platform: 'node'
    format: 'esm'
    target: 'es2022'
    bundle: false
    tsconfigRaw: { compilerOptions: { useDefineForClassFields: true } }
  }): Promise<unknown>
}

async function sources(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sources(path))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !entry.name.includes('.test.')) {
      files.push(path)
    }
  }
  return files
}

async function artifactInputs() {
  const paths = [
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
    'apps/api/package.json', 'apps/web/package.json', 'apps/worker/package.json',
    'apps/api/test/helpers/testPool.mjs', 'apps/api/test/fixtures/remote-review-main.mjs',
    'apps/api/test/helpers/installedRestartArtifact.ts',
    'node_modules/.modules.yaml', 'node_modules/.pnpm/lock.yaml',
  ]
  const inputs: (string | Buffer)[] = [process.platform, process.arch, process.version, compiler.version]
  async function append(path: string) {
    const entries = await readdir(join(repository, path), { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === 'node_modules') continue
      const child = join(path, entry.name)
      if (entry.isDirectory()) await append(child)
      else inputs.push(child, await readFile(join(repository, child)))
    }
  }
  for (const path of paths) {
    inputs.push(path, await readFile(join(repository, path)))
  }
  for (const path of ['scripts', 'apps/api/src', 'apps/worker/src', 'apps/worker/artifacts/ci-runtime',
    'packages/contracts']) {
    await append(path)
  }
  return inputs
}

export async function copyRestartDependencyDirectory(sourceDirectory: string, destination: string) {
  await mkdir(destination, { recursive: true, mode: 0o700 })
  for (const entry of await readdir(sourceDirectory)) {
    if (entry === '.cache') continue
    await cp(join(sourceDirectory, entry), join(destination, entry), {
      recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE,
      filter: path => !relative(sourceDirectory, path).split(sep).includes('.cache'),
    })
  }
}

async function productionDependencyBlocks() {
  const store = join(repository, 'node_modules/.pnpm')
  const contracts = await realpath(join(repository, 'packages/contracts'))
  const blocks = new Set<string>()
  const pending: string[] = []
  async function include(alias: string) {
    const packageDirectory = await realpath(alias)
    if (packageDirectory === contracts) return
    const location = relative(store, packageDirectory)
    if (location === '..' || location.startsWith(`..${sep}`) || isAbsolute(location)) {
      throw new Error('Installed restart dependency is outside the pinned package store.')
    }
    const block = location.split(sep)[0]!
    if (blocks.has(block)) return
    blocks.add(block)
    pending.push(block)
  }
  async function includeSiblingAliases(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) await include(path)
      else if (entry.isDirectory() && entry.name.startsWith('@')) await includeSiblingAliases(path)
    }
  }
  for (const path of ['apps/api', 'packages/contracts']) {
    const directory = join(repository, path)
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
    }
    for (const dependency of Object.keys(manifest.dependencies)) {
      await include(join(directory, 'node_modules', dependency))
    }
  }
  for (let index = 0; index < pending.length; index++) {
    await includeSiblingAliases(join(store, pending[index]!, 'node_modules'))
  }
  const available = (await readdir(store, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name !== 'node_modules').length
  console.info('[installed-restart-dependencies]', JSON.stringify({
    selectedBlocks: blocks.size, availableBlocks: available,
  }))
  return blocks
}

async function copyProductionDependencyStore(release: string) {
  const blocks = await measureIntegrationPhase('installed restart dependency selection', productionDependencyBlocks)
  const source = join(repository, 'node_modules/.pnpm')
  const destination = join(release, 'node_modules/.pnpm')
  await mkdir(destination, { recursive: true, mode: 0o700 })
  const copiedRoot = await realpath(destination)
  const sources: string[] = []
  for (const block of [...blocks, 'node_modules']) {
    const directory = await realpath(join(source, block))
    const location = relative(directory, copiedRoot)
    const nested = location !== '..' && !location.startsWith(`..${sep}`) && !isAbsolute(location)
    if (nested) throw new Error('Installed restart package copy destination is inside its source block.')
    sources.push(directory)
  }
  await measureIntegrationPhase('installed restart package blocks copy', () => execute('cp', [
    '--recursive', '--no-dereference', '--reflink=auto', '--target-directory', destination, '--', ...sources,
  ]))
  await copyFile(join(source, 'lock.yaml'), join(destination, 'lock.yaml'))
}

async function copyInstalledDependencies(release: string) {
  await copyProductionDependencyStore(release)
  const copies = [
    ['apps/api/node_modules', 'apps/api/node_modules'],
    ['packages/contracts', 'packages/contracts'],
  ] as const
  for (const [source, destination] of copies) {
    await copyRestartDependencyDirectory(join(repository, source), join(release, destination))
  }
  async function checkLinks(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await checkLinks(path)
      else if (entry.isSymbolicLink()) {
        const target = resolve(dirname(path), await readlink(path))
        const location = relative(release, target)
        if (location === '..' || location.startsWith(`..${sep}`) || isAbsolute(location)) {
          throw new Error('Installed restart dependency link leaves the isolated release.')
        }
      }
    }
  }
  await measureIntegrationPhase('installed restart dependency links', () => checkLinks(release))
  const contracts = join(release, 'packages/contracts')
  const manifest = JSON.parse(await readFile(join(contracts, 'package.json'), 'utf8')) as {
    exports: Record<string, string | { import: string }>
  }
  for (const exported of Object.values(manifest.exports)) {
    const path = await realpath(join(contracts, typeof exported === 'string' ? exported : exported.import))
    const location = relative(release, path)
    if (location === '..' || location.startsWith(`..${sep}`) || isAbsolute(location)) {
      throw new Error('Installed restart contracts runtime export leaves the isolated release.')
    }
    if (!(await stat(path)).isFile()) throw new Error('Installed restart contracts runtime export is missing.')
  }
}

async function buildArtifact(directory: string) {
  const release = join(directory, 'release')
  const api = join(release, 'apps/api')
  await measureIntegrationPhase('installed restart controls copy', async () => {
    await mkdir(api, { recursive: true, mode: 0o700 })
    await copyFile(join(repository, 'apps/api/package.json'), join(api, 'package.json'))
    await cp(join(repository, 'scripts'), join(release, 'scripts'), { recursive: true })
  })
  await measureIntegrationPhase('installed restart dependency snapshot', () => copyInstalledDependencies(release))
  await mkdir(join(api, 'test/helpers'), { recursive: true })
  await copyFile(join(repository, 'apps/api/test/helpers/testPool.mjs'), join(api, 'test/helpers/testPool.mjs'))
  const source = join(repository, 'apps/api/src')
  await measureIntegrationPhase('installed restart API transpile', async () => {
    await cp(source, join(api, 'dist'), { recursive: true, filter: path => !path.endsWith('.ts') })
    await compiler.build({
      entryPoints: await sources(source), outbase: source, outdir: join(api, 'dist'),
      platform: 'node', format: 'esm', target: 'es2022', bundle: false,
      tsconfigRaw: { compilerOptions: { useDefineForClassFields: true } },
    })
  })
  await measureIntegrationPhase('installed restart runtime copy', async () => {
    await copyApiRuntime(repository, join(api, 'dist'))
    await cp(join(repository, 'apps/worker/src'), join(release, 'apps/worker/src'), { recursive: true })
    await copyFile(join(repository, 'package.json'), join(release, 'package.json'))
    const fixture = await readFile(new URL('../fixtures/remote-review-main.mjs', import.meta.url), 'utf8')
    await writeFile(join(api, 'dist/restart-fixture.js'),
      fixture.replaceAll('../../src/', './').replaceAll('.ts\'', '.js\''))
  })
}

export async function installedRestartArtifact() {
  const inputs = await measureIntegrationPhase('installed restart artifact inputs', artifactInputs)
  const cacheStarted = performance.now()
  reportIntegrationPhase('installed restart cache lookup started', 0)
  const cached = await measureIntegrationPhase('installed restart artifact', () => cachedTestFixture(
    testFixtureCacheRoot(), 'installed-api-restart', inputs, async directory => {
      reportIntegrationPhase('installed restart cache wait', performance.now() - cacheStarted)
      await buildArtifact(directory)
    },
  ))
  return join(cached, 'release')
}
