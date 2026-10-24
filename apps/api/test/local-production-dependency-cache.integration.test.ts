import { execFile, type ExecFileOptions } from 'node:child_process'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { removeFixtureDirectory } from './helpers/testResources.js'

it('reuses installed dependencies across contracts rebuilds while keeping rollback releases immutable', async () => {
  const script = new URL('../../../scripts/local-production-runtime.mjs', import.meta.url).href
  const { deployProductionApi, installProductionDependencies, pruneApiDependencies } = await import(script)
  const execute = promisify(execFile)
  const parent = process.env.FOREMAN_CODE_TEST_ROOT ?? join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'production-dependency-cache-'))
  const source = join(directory, 'workspace')
  const api = join(source, 'apps/api')
  const contracts = join(source, 'packages/contracts')
  const ci = join(source, 'apps/ci')
  const nodeContracts = join(source, 'packages/contracts-node')
  const valuePackage = join(source, 'packages/value')
  const environment = { ...process.env, npm_config_offline: 'true', npm_config_update_notifier: 'false',
    COREPACK_ENABLE_NETWORK: '0' }
  let deploys = 0
  const run = async (command: string, args: string[], options: ExecFileOptions = {}) => {
    if (args.includes('deploy')) deploys += 1
    return execute(command, args, { ...options, cwd: source, env: environment,
      timeout: 20_000, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 })
  }
  const callRelease = async (destination: string) => {
    const { stdout } = await execute(process.execPath, ['--input-type=module', '-e',
      'const api = await import(process.argv[1]); console.log(api.value());',
      pathToFileURL(join(destination, 'dist/index.js')).href])
    return stdout.trim()
  }
  try {
    await mkdir(join(api, 'dist'), { recursive: true })
    await mkdir(join(contracts, 'dist'), { recursive: true })
    await mkdir(join(ci, 'dist'), { recursive: true })
    await mkdir(join(nodeContracts, 'dist'), { recursive: true })
    await mkdir(valuePackage, { recursive: true })
    await writeFile(join(valuePackage, 'package.json'), JSON.stringify({
      name: 'cache-value', version: '1.0.0', type: 'module', main: 'index.js', files: ['index.js'],
    }))
    await writeFile(join(valuePackage, 'index.js'), 'export const identity = value => value;\n')
    await writeFile(join(source, 'package.json'), JSON.stringify({
      name: 'production-cache-fixture', private: true, packageManager: 'pnpm@11.27.0',
    }))
    await writeFile(join(source, 'pnpm-workspace.yaml'), [
      'packages:', '  - apps/*', '  - packages/*', 'autoInstallPeers: false',
      'minimumReleaseAge: 2880', 'minimumReleaseAgeStrict: true', 'minimumReleaseAgeIgnoreMissingTime: false',
    ].join('\n') + '\n')
    await writeFile(join(api, 'package.json'), JSON.stringify({
      name: '@foreman-code/api', private: true, version: '1.0.0', type: 'module', files: ['dist'],
      dependencies: { '@foreman-code/contracts-node': 'workspace:*', '@foreman-code/contracts': 'workspace:*', '@foreman-code/ci': 'workspace:*', 'cache-value': 'workspace:*' },
    }))
    await writeFile(join(contracts, 'package.json'), JSON.stringify({
      name: '@foreman-code/contracts', private: true, version: '1.0.0', type: 'module',
      main: 'dist/index.js', files: ['dist'], dependencies: { 'cache-value': 'workspace:*' },
    }))
    await writeFile(join(nodeContracts, 'package.json'), JSON.stringify({
      name: '@foreman-code/contracts-node', private: true, version: '1.0.0', type: 'module',
      main: 'dist/index.js', files: ['dist'], dependencies: { '@foreman-code/contracts': 'workspace:*' },
    }))
    await writeFile(join(nodeContracts, 'dist/index.js'), "export { value } from '@foreman-code/contracts';\n")
    await writeFile(join(ci, 'package.json'), JSON.stringify({
      name: '@foreman-code/ci', private: true, version: '1.0.0', type: 'module',
      main: 'dist/index.js', files: ['dist'], dependencies: { '@foreman-code/contracts-node': 'workspace:*' },
    }))
    // Strict age verification visits every registry entry, even unused entries in an offline install.
    await writeFile(join(source, 'pnpm-lock.yaml'), JSON.stringify({
      lockfileVersion: '9.0', settings: { autoInstallPeers: false, excludeLinksFromLockfile: false }, importers: {
        '.': {}, 'apps/api': { dependencies: {
          '@foreman-code/contracts': { specifier: 'workspace:*', version: 'link:../../packages/contracts' },
          '@foreman-code/contracts-node': { specifier: 'workspace:*', version: 'link:../../packages/contracts-node' },
          '@foreman-code/ci': { specifier: 'workspace:*', version: 'link:../ci' },
          'cache-value': { specifier: 'workspace:*', version: 'link:../../packages/value' },
        } }, 'apps/ci': { dependencies: {
          '@foreman-code/contracts-node': { specifier: 'workspace:*', version: 'link:../../packages/contracts-node' },
        } }, 'packages/contracts': { dependencies: {
          'cache-value': { specifier: 'workspace:*', version: 'link:../value' },
        } }, 'packages/contracts-node': { dependencies: {
          '@foreman-code/contracts': { specifier: 'workspace:*', version: 'link:../contracts' },
        } }, 'packages/value': {},
      },
    }))
    const buildContracts = async (value: string) => writeFile(join(contracts, 'dist/index.js'),
      `import { identity } from 'cache-value'; export const value = () => identity(${JSON.stringify(value)});\n`)
    const buildCi = async (value: string) => writeFile(join(ci, 'dist/index.js'),
      `import { value } from '@foreman-code/contracts-node'; export const result = () => value() + ${JSON.stringify(value)};\n`)
    await buildContracts('first contracts')
    await buildCi(' first CI')
    await writeFile(join(api, 'dist/index.js'),
      "export { result as value } from '@foreman-code/ci';\n")
    await installProductionDependencies(run)
    const dependencies = { root: join(directory, 'api-dependencies'), source }
    const first = join(directory, 'releases/first/apps/api')
    await deployProductionApi(run, first, { dependencies })
    expect(await callRelease(first)).toBe('first contracts first CI')
    await buildContracts('second contracts')
    await buildCi(' second CI')
    const second = join(directory, 'releases/second/apps/api')
    await deployProductionApi(run, second, { dependencies })
    expect(deploys).toBe(1)
    expect(await callRelease(second)).toBe('second contracts second CI')
    expect(await callRelease(first)).toBe('first contracts first CI')
    expect(await realpath(join(first, 'node_modules/cache-value')))
      .toBe(await realpath(join(second, 'node_modules/cache-value')))
    await buildContracts('mutable source')
    await buildCi(' mutable CI')
    expect(await callRelease(second)).toBe('second contracts second CI')
    const removed: string[] = []
    await pruneApiDependencies(dependencies.root, [join(directory, 'releases/second')],
      { removeInBackground: (path: string) => removed.push(path) })
    expect(removed).toEqual([])
    expect(await callRelease(second)).toBe('second contracts second CI')
  } finally {
    await removeFixtureDirectory(directory)
  }
}, 180_000)
