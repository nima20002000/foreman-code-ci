import { execFile } from 'node:child_process'
import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import ts from 'typescript'
import { deployProductionApi } from '../../../../scripts/local-production-runtime.mjs'
import { copyApiRuntime } from '../../../../scripts/copy-api-runtime.mjs'
import { cachedTestFixture, testFixtureCacheRoot } from '../../../../scripts/test-fixture-cache.mjs'
import { measureIntegrationPhase, reportIntegrationPhase } from './integrationPhase.js'

const execute = promisify(execFile)
const repository = fileURLToPath(new URL('../../../..', import.meta.url))

async function sources(directory: string): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await sources(path))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !entry.name.includes('.test.')) files.push(path)
  }
  return files
}

async function artifactInputs() {
  const paths = [
    'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
    'apps/api/package.json', 'apps/web/package.json', 'apps/worker/package.json',
    'apps/api/test/helpers/testPool.mjs', 'apps/api/test/fixtures/remote-review-main.mjs',
    'apps/api/test/helpers/installedRestartArtifact.ts',
  ]
  const inputs: (string | Buffer)[] = [process.platform, process.arch, process.version, ts.version]
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

async function buildArtifact(directory: string) {
  const release = join(directory, 'release')
  const api = join(release, 'apps/api')
  await measureIntegrationPhase('installed restart controls copy', async () => {
    await mkdir(dirname(api), { recursive: true, mode: 0o700 })
    await cp(join(repository, 'scripts'), join(release, 'scripts'), { recursive: true })
    await cp(join(repository, 'packages/contracts/src'), join(release, 'packages/contracts/src'), { recursive: true })
  })
  // Legacy pnpm deployment changes its source workspace's dependency selection.
  const deployment = join(directory, 'deployment-source')
  await measureIntegrationPhase('installed restart deployment workspace', async () => {
    await mkdir(join(deployment, 'scripts'), { recursive: true, mode: 0o700 })
    for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
      await copyFile(join(repository, name), join(deployment, name))
    }
    await copyFile(join(repository, 'scripts/require-pnpm.mjs'), join(deployment, 'scripts/require-pnpm.mjs'))
    for (const name of ['api', 'web', 'worker']) {
      await mkdir(join(deployment, 'apps', name), { recursive: true })
      await copyFile(join(repository, 'apps', name, 'package.json'), join(deployment, 'apps', name, 'package.json'))
    }
    await cp(join(repository, 'packages/contracts'), join(deployment, 'packages/contracts'), {
      recursive: true, filter: path => path !== join(repository, 'packages/contracts/node_modules'),
    })
  })
  await measureIntegrationPhase('installed restart deployment and package freeze', () => deployProductionApi(
    async (command: string, args: string[]) => {
      // The disposable deployment workspace is discarded, so it needs no dependency restoration.
      if (args.includes('install')) return
      try {
        await measureIntegrationPhase('installed restart pnpm deployment', () => execute(command, [...args, '--offline'], {
          cwd: deployment, maxBuffer: 4 * 1024 * 1024, timeout: 30_000,
          env: { ...process.env, CI: 'true' },
        }))
      } catch (error) {
        const output = error as Error & { stdout?: string; stderr?: string; code?: unknown; signal?: unknown }
        throw new Error(`${output.message} (code ${output.code}, signal ${output.signal})\n`
          + `${output.stderr ?? ''}\n${output.stdout ?? ''}`, { cause: error })
      }
    }, api,
  ))
  await mkdir(join(api, 'test/helpers'), { recursive: true })
  await copyFile(join(repository, 'apps/api/test/helpers/testPool.mjs'), join(api, 'test/helpers/testPool.mjs'))
  const source = join(repository, 'apps/api/src')
  await measureIntegrationPhase('installed restart API transpile', async () => {
    await cp(source, join(api, 'dist'), { recursive: true, filter: path => !path.endsWith('.ts') })
    for (const path of await sources(source)) {
      const output = join(api, 'dist', relative(source, path).replace(/\.ts$/, '.js'))
      const compiled = ts.transpileModule(await readFile(path, 'utf8'), { compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, esModuleInterop: true,
      } })
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, compiled.outputText)
    }
  })
  await measureIntegrationPhase('installed restart runtime copy', async () => {
    await copyApiRuntime(repository, join(api, 'dist'))
    await cp(join(repository, 'apps/worker/src'), join(release, 'apps/worker/src'), { recursive: true })
    await copyFile(join(repository, 'package.json'), join(release, 'package.json'))
    const fixture = await readFile(new URL('../fixtures/remote-review-main.mjs', import.meta.url), 'utf8')
    await writeFile(join(api, 'dist/restart-fixture.js'),
      fixture.replaceAll('../../src/', './').replaceAll('.ts\'', '.js\''))
  })
  await measureIntegrationPhase('installed restart deployment cleanup', () => rm(deployment, { recursive: true }))
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
