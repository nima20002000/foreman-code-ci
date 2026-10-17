import { readClaudePlugins } from '../../src/modules/computers/claudePlugins.js'
import { installedPlugins } from '../../src/modules/computers/maintenance.js'
import { fakeComputer } from './fleetSync.js'

export const fleetPluginId = 'notes@official'

/** Native CLI fixture with independently published and installed plugin versions. */
export function versionedComputer() {
  const computer = fakeComputer()
  const versions = { codex: new Map<string, string>(), claude: new Map<string, string>() }
  let published = '1.0.0'
  let retainVersion = false
  const run = computer.ports.run
  computer.ports.run = async (binary, args, options) => {
    const result = await run(binary, args, options)
    const harness = binary.endsWith('codex') ? 'codex' : 'claude'
    if (args[0] !== 'plugin' || result.code !== 0) return result
    if (args[1] === 'list') {
      const listed = JSON.parse(result.stdout) as { installed: Record<string, unknown>[] }
      listed.installed = listed.installed.map(plugin => ({
        ...plugin, version: versions[harness].get(String(plugin.pluginId ?? plugin.id)) ?? null,
      }))
      return { ...result, stdout: JSON.stringify(listed) }
    }
    if (['add', 'install', 'update'].includes(args[1]!) && !retainVersion) {
      versions[harness].set(args[2]!, published)
    }
    if (['remove', 'uninstall'].includes(args[1]!) && !retainVersion) versions[harness].delete(args[2]!)
    return result
  }
  return {
    ...computer, versions,
    publish: (version: string) => { published = version },
    retainInstalledVersion: () => { retainVersion = true },
    sources: {
      codexPlugins: () => installedPlugins(computer.ports, '/fake/codex', AbortSignal.timeout(1000)),
      claudePlugins: () => readClaudePlugins(computer.ports, AbortSignal.timeout(1000)),
    },
  }
}
