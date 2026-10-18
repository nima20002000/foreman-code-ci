import { execFile } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { parse, stringify } from 'yaml'
import { cachedTestFixture, testFixtureCacheRoot } from '../../../../scripts/test-fixture-cache.mjs'
import { readCiPackagePaths } from '../../../../scripts/ci-package-paths.mjs'

interface PackageLock {
  lockfileVersion: string
  settings: Record<string, unknown>
  importers: Record<string, { dependencies: Record<string, { specifier: string; version: string }> }>
  packages: Record<string, { resolution: { integrity: string } }>
  snapshots: Record<string, { optional?: boolean; optionalDependencies?: Record<string, string> }>
}

const execute = promisify(execFile)

/** The schema exporter needs its platform package even when pnpm skips a missing optional dependency. */
export async function pinnedProviderExporter(launcherVersion: string): Promise<string> {
  const inputs = await Promise.all([
    readFile(new URL('../../../../pnpm-lock.yaml', import.meta.url)),
    readFile(new URL('../../../../pnpm-workspace.yaml', import.meta.url)),
    readFile(new URL('../../../../package.json', import.meta.url)),
  ])
  const lock = parse(inputs[0]!.toString('utf8')) as PackageLock
  const workspace = parse(inputs[1]!.toString('utf8')) as Record<string, unknown>
  const { packageManager } = JSON.parse(inputs[2]!.toString('utf8')) as { packageManager: string }
  const provider = lock.importers['apps/api']!.dependencies['@openai/codex']!
  if (provider.version !== launcherVersion) {
    throw new Error('The installed provider launcher does not match the repository lockfile.')
  }
  const providerKey = `@openai/codex@${provider.version}`
  const platform = process.platform === 'android' ? 'linux' : process.platform
  const nativeName = `@openai/codex-${platform}-${process.arch}`
  const nativeKey = lock.snapshots[providerKey]?.optionalDependencies?.[nativeName]
  if (!nativeKey || !lock.packages[nativeKey]?.resolution.integrity) {
    throw new Error(`The pinned provider has no locked exporter for ${platform}/${process.arch}.`)
  }
  const dependencies = {
    '@openai/codex': provider,
    [nativeName]: { specifier: `npm:${nativeKey}`, version: nativeKey },
  }
  const providerKeys = new Set([providerKey, ...Object.values(lock.snapshots[providerKey]!.optionalDependencies!)])
  const paths = readCiPackagePaths(fileURLToPath(new URL('../../../../', import.meta.url)))
  const environment = { ...process.env,
    PNPM_CONFIG_STORE_DIR: process.env.PNPM_CONFIG_STORE_DIR ?? paths.storeDir,
    PNPM_CONFIG_CACHE_DIR: process.env.PNPM_CONFIG_CACHE_DIR ?? paths.cacheDir,
  }
  const installation = await cachedTestFixture(testFixtureCacheRoot(), 'provider-exporter',
    [...inputs, platform, process.arch, process.version, 'offline-prefetched-store'], async directory => {
      const manifest = { private: true, packageManager,
        dependencies: Object.fromEntries(Object.entries(dependencies).map(([name, entry]) => [name, entry.specifier])) }
      const policy: Record<string, unknown> = { ...workspace, packages: [] }
      delete policy.patchedDependencies
      await writeFile(join(directory, 'package.json'), JSON.stringify(manifest))
      await writeFile(join(directory, 'pnpm-workspace.yaml'), stringify(policy))
      await writeFile(join(directory, 'pnpm-lock.yaml'), stringify({
        lockfileVersion: lock.lockfileVersion,
        settings: lock.settings,
        importers: { '.': { dependencies } },
        packages: Object.fromEntries([...providerKeys].map(key => [key, lock.packages[key]])),
        snapshots: Object.fromEntries([...providerKeys].map(key => [key, key === nativeKey ? {} : lock.snapshots[key]])),
      }))
      console.info('[provider-schemas] Installing the locked exporter offline from the CI pnpm store.')
      await execute('corepack', ['pnpm', 'install', '--frozen-lockfile', '--offline'], {
        cwd: directory, env: environment,
      })
    })
  return join(installation, 'node_modules/@openai/codex/bin/codex.js')
}
