import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { ComputerMaintenance, installedPlugins, systemMaintenancePorts } from '../src/modules/computers/maintenance.js'
import type { MaintenancePorts } from '../src/modules/computers/maintenancePorts.js'

async function marketplace(root: string, versions: { notes: string; independent: string }) {
  await mkdir(join(root, '.claude-plugin'), { recursive: true })
  await writeFile(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'fixture-tools', owner: { name: 'Fixture author' },
    plugins: ['notes', 'independent'].map(name => ({ name, source: `./${name}`, description: 'Local test plugin' })),
  }))
  for (const name of ['notes', 'independent'] as const) {
    await mkdir(join(root, name, '.claude-plugin'), { recursive: true })
    await writeFile(join(root, name, '.claude-plugin', 'plugin.json'), JSON.stringify({
      name, version: versions[name], description: 'Local test plugin',
    }))
  }
}

it('uses the pinned native Codex CLI to install only the selected plugin from its acquired marketplace', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const home = await mkdtemp(join(cache, 'native-plugin-source-'))
  const binary = createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js')
  const original = join(home, 'original')
  const acquired = join(home, 'acquired')
  const environment = { HOME: home, CODEX_HOME: join(home, '.codex'),
    XDG_CACHE_HOME: join(home, 'cache'), PATH: process.env.PATH ?? '' }
  const native = systemMaintenancePorts(environment, { codex: binary })
  const signal = AbortSignal.timeout(25_000)
  const run = async (args: string[]) => {
    const result = await native.run(binary, args, { signal, timeoutMs: 20_000 })
    expect(result, result.stderr).toMatchObject({ code: 0 })
  }
  let maintenance: ComputerMaintenance | undefined
  try {
    await mkdir(environment.CODEX_HOME, { recursive: true })
    await marketplace(original, { notes: '1.0.0', independent: '0.5.0' })
    await marketplace(acquired, { notes: '2.0.0', independent: '9.0.0' })
    await run(['plugin', 'marketplace', 'add', original, '--json'])
    await run(['plugin', 'add', 'notes@fixture-tools', '--json'])
    await run(['plugin', 'add', 'independent@fixture-tools', '--json'])
    const ports: MaintenancePorts = {
      ...native,
      find: async name => {
        if (name === 'codex') return binary
        if (name === 'npm') return '/fixture/npm'
        return null
      },
      run: async (command, args, options) => {
        if (command === '/fixture/npm') return { code: 0, stdout: '0.154.0', stderr: '' }
        if (command === 'sudo') return { code: 1, stdout: '', stderr: 'sudo: a password is required' }
        const stagedHome = options.environment?.CODEX_HOME
        if (stagedHome && args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add') {
          const root = join(stagedHome, 'marketplace')
          await cp(acquired, root, { recursive: true })
          return native.run(command, [...args.slice(0, 3), root, ...args.slice(4)],
            { ...options, signal: AbortSignal.any([signal, options.signal]) })
        }
        return native.run(command, args, { ...options, signal: AbortSignal.any([signal, options.signal]) })
      },
    }
    maintenance = new ComputerMaintenance(ports)
    await maintenance.start({ kind: 'sync-plugins', plugins: ['notes@fixture-tools'],
      pluginVersions: { 'notes@fixture-tools': '2.0.0' },
      marketplaces: [{ name: 'fixture-tools', source: 'owner/fixture-tools' }] })
    await maintenance.drain()
    const status = await maintenance.status(signal)
    expect(status.tasks[0], status.tasks[0]?.summary).toMatchObject({ state: 'succeeded' })
    const installed = await installedPlugins(native, binary, signal)
    expect(installed).toContainEqual({ pluginId: 'notes@fixture-tools', version: '2.0.0' })
    expect(installed).toContainEqual({ pluginId: 'independent@fixture-tools', version: '0.5.0' })
  } finally {
    await maintenance?.drain()
    await rm(home, { recursive: true, force: true })
  }
})
