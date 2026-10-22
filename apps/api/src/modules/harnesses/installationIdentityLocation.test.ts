import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { discoverLauncher } from './hostDiscovery.js'
import { packageRelativeLauncher } from './claudeSdk/bootstrap.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

async function installedPackage(root: string, dependencyFolder: string, payload: string) {
  const directory = join(root, dependencyFolder, 'api/node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-x64@0.3.284/node_modules/@anthropic-ai/claude-agent-sdk-linux-x64')
  await mkdir(directory, { recursive: true })
  const launcher = join(directory, 'claude')
  const module = join(directory, 'sdk.mjs')
  await writeFile(launcher, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 2, 3]), { mode: 0o700 })
  await writeFile(module, payload)
  return { launcher, module }
}

it('keeps one installation identity when a release installs the same SDK in another dependency folder', async () => {
  const temporaryRoot = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(temporaryRoot, { recursive: true })
  const root = await mkdtemp(join(temporaryRoot, 'installation-location-'))
  directories.push(root)
  const environment = { generation: 'main', provenance: 'systemd' as const, cwd: root, path: '' }
  const first = await installedPackage(root, '1b8248da3921c7d6d7aadb05bce75163', 'export {}')
  const second = await installedPackage(root, '311b171573a79c4463d87c10a7b4cd5b', 'export {}')
  const changed = await installedPackage(root, 'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0', 'export const changed = true')

  const discovered = await Promise.all([first, second, changed].map(({ launcher, module }) =>
    discoverLauncher(launcher, environment, [module])))
  expect(discovered.map(value => value.status)).toEqual(['installed', 'installed', 'installed'])
  expect(discovered[1]!.fingerprint).toBe(discovered[0]!.fingerprint)
  expect(discovered[2]!.fingerprint).not.toBe(discovered[0]!.fingerprint)
  expect(packageRelativeLauncher(second.launcher)).toBe(packageRelativeLauncher(first.launcher))
  expect(packageRelativeLauncher(first.launcher)).toBe(
    '@anthropic-ai/claude-agent-sdk-linux-x64/claude')
})
