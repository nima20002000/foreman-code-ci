import { execFile } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { parse, stringify } from 'yaml'
import { cachedTestFixture, testFixtureCacheRoot } from '../../../../scripts/test-fixture-cache.mjs'

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
  const installation = await cachedTestFixture(testFixtureCacheRoot(), 'provider-exporter',
    [...inputs, platform, process.arch, process.version], async directory => {
      const store = join(directory, 'store')
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
      console.info('[provider-schemas] Installing the locked exporter with its required native package.')
      await execute('corepack', ['pnpm', 'install', '--frozen-lockfile', '--ignore-scripts',
        '--store-dir', store], { cwd: directory })
      // clone-or-copy installations remain independent of the staging store after publication.
      await rm(store, { recursive: true, force: true })
    })
  return join(installation, 'node_modules/@openai/codex/bin/codex.js')
}
