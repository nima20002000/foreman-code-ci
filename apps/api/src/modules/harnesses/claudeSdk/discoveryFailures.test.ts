import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { logger } from '../../diagnostics/logger.js'

const sdk = vi.hoisted(() => ({ failure: undefined as Error | undefined }))
vi.mock('node:module', async importOriginal => {
  const actual = await importOriginal<typeof import('node:module')>()
  // Only the installed Claude SDK and its native package resolve to the fixture; everything else loads normally.
  const createRequire = (from: string | URL) => {
    const real = actual.createRequire(from)
    const resolve = (name: string, options?: { paths?: string[] }) =>
      name === '@anthropic-ai/claude-agent-sdk' ? '/opt/fixture/node_modules/.pnpm/sdk/sdk.mjs'
        : name.startsWith('@anthropic-ai/claude-agent-sdk-') ? '/opt/fixture/claude' : real.resolve(name, options)
    return Object.assign((id: string) => real(id), real, { resolve })
  }
  return { ...actual, createRequire }
})
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, realpath: async (path: string) => path }
})
vi.mock('./currentPin.js', () => ({
  createClaudeCurrentPinResolver: vi.fn(),
  discoverInstalledClaudeSdk: async () => { throw sdk.failure },
}))

afterEach(() => { vi.restoreAllMocks() })

function captureWarnings() {
  const lines: Array<{ fields: Record<string, unknown>; message: string }> = []
  vi.spyOn(logger, 'child').mockImplementation((bindings) => {
    const record = (fields: Record<string, unknown>, message: string) => { lines.push({ fields: { ...bindings, ...fields }, message }) }
    return { warn: record, error: record, info: () => undefined } as unknown as ReturnType<typeof logger.child>
  })
  return lines
}

it('records why Claude discovery failed and logs each distinct failure once', async () => {
  const { ProductionHarnessRegistry } = await import('../productionRegistry.js')
  const { createClaudeProductionDiscovery } = await import('./bootstrap.js')
  const lines = captureWarnings()
  const mainId = '6f4c1f0e-2b7a-4c55-9d3e-8a1b2c3d4e5f'
  const host = { kind: 'main' as const, mainId }
  const discovery = createClaudeProductionDiscovery({
    registry: () => { throw new Error('Passive discovery must not use the registry') },
    factories: () => { throw new Error('Passive discovery must not use native factories') },
    workingDirectory: '/opt/fixture',
  })
  const registry = new ProductionHarnessRegistry({} as never, { codexBinary: 'codex' },
    async () => ({ revision: 1, defaults: DEFAULT_HARNESS_DEFAULTS }), {} as never, () => null, { PATH: '/usr/bin' }, {
      launcher: async (requested, environment) => ({ requested, resolvedLauncher: null, fingerprint: null, status: 'missing',
        interpreter: null, diagnostics: [], environment, checkedAt: '2026-10-23T00:00:00.000Z' }),
      payloads: async () => ({ complete: false, paths: [] }),
      claude: discovery.discover,
    })
  sdk.failure = Object.assign(new Error('permission denied, open lock.yaml'), { code: 'EACCES' })
  try {
    await registry.initialize(mainId)
    await registry.refreshMain()
    await registry.refreshMain()
    const claude = registry.installations.list().find(record => record.driverId === 'claude')!
    expect(claude.installed).toBe(false)
    expect(claude.launcher.diagnostics).toContainEqual(expect.stringContaining('permission denied, open lock.yaml'))
    const failures = () => lines.filter(line => line.fields.operation === 'discover Claude installation')
    expect(failures()).toHaveLength(1)
    expect(failures()[0]!.fields).toMatchObject({ component: 'harness', code: 'EACCES', host,
      harnessInstallationId: commandInputHash({ hostRef: host, driverId: 'claude', launcher: '/opt/fixture/claude' }),
      err: sdk.failure })
    sdk.failure = new Error('Installed Claude SDK resolution integrity is unavailable.')
    await registry.refreshMain()
    await registry.refreshMain()
    expect(failures()).toHaveLength(2)
    expect(failures()[1]!.fields).toMatchObject({ err: sdk.failure })
  } finally { registry.stop() }
})
