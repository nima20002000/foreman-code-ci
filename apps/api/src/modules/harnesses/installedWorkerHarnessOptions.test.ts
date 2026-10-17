import { afterEach, expect, it, vi } from 'vitest'
import { workerHarnessCatalogFixture } from '../../../test/helpers/workerHarnessCatalog.js'
import { createInstalledWorkerHarnessOptions } from './installedWorkerHarnessOptions.js'
import { readNativeCodexModelCatalog } from './codexModelCatalog.js'
import { qualifyCodex } from './codexProtocol.js'
import { loadOfficialClaudeSdk } from './claudeSdk/official.js'
import { DomainError } from '../errors.js'

vi.mock('./codexProtocol.js', async importOriginal => ({ ...await importOriginal<typeof import('./codexProtocol.js')>(),
  qualifyCodex: vi.fn((await import('../../../test/helpers/workerHarnessCatalog.js')).catalogCodexQualification),
  assertCodexUnchanged: async () => {} }))
vi.mock('./codexModelCatalog.js', async importOriginal => ({ ...await importOriginal<typeof import('./codexModelCatalog.js')>(),
  readNativeCodexModelCatalog: vi.fn((await import('../../../test/helpers/workerHarnessCatalog.js')).catalogCodexModels) }))
vi.mock('./claudeSdk/official.js', () => ({ loadOfficialClaudeSdk: vi.fn(async (profile: string) =>
  (await import('../../../test/helpers/workerHarnessCatalog.js')).catalogClaudeClient(profile)) }))
vi.mock('./process.js', async importOriginal => ({ ...await importOriginal<typeof import('./process.js')>(),
  runCommand: async () => ({ stdout: '2.1.284 (Claude Code)', stderr: '', exitCode: 0 }) }))

afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers() })

it('keeps a shared catalog load alive when its first reader is cancelled', async () => {
  const f = await workerHarnessCatalogFixture()
  const catalog = createInstalledWorkerHarnessOptions(f.input)
  let finishNative!: (value: Awaited<ReturnType<typeof readNativeCodexModelCatalog>>) => void
  const native = new Promise<Awaited<ReturnType<typeof readNativeCodexModelCatalog>>>(resolve => { finishNative = resolve })
  vi.mocked(readNativeCodexModelCatalog).mockImplementationOnce(() => native)
  const controller = new AbortController()
  const first = catalog.discover(f.request('codex'), f.context(controller.signal))
  const firstRejected = expect(first).rejects.toThrow('First reader left')
  try {
    await vi.waitFor(() => expect(readNativeCodexModelCatalog).toHaveBeenCalledOnce())
    const calls = f.current.mock.calls.length
    const second = catalog.discover(f.request('codex'), f.context())
    await vi.waitFor(() => expect(f.current.mock.calls.length).toBeGreaterThanOrEqual(calls + 3))
    controller.abort(new Error('First reader left'))
    await firstRejected
    finishNative({ models: [{ slug: 'shared-model' }] })
    await expect(second).resolves.toMatchObject({ models: [{ id: 'shared-model' }] })
    expect(readNativeCodexModelCatalog).toHaveBeenCalledOnce()
  } finally {
    finishNative({ models: [] })
    await catalog.close()
    await f.close()
  }
})

it.each(['codex', 'claude'] as const)('changes the native %s catalog when its login changes before cache expiry', async harness => {
  const f = await workerHarnessCatalogFixture()
  const catalog = createInstalledWorkerHarnessOptions(f.input)
  try {
    await expect(catalog.discover(f.request(harness), f.context()))
      .resolves.toMatchObject({ authenticated: true, models: [{ id: 'first-model' }] })
    await expect(catalog.discover(f.request(harness), f.context()))
      .resolves.toMatchObject({ models: [{ id: 'first-model' }] })
    const reads = harness === 'codex' ? vi.mocked(readNativeCodexModelCatalog) : vi.mocked(loadOfficialClaudeSdk)
    expect(reads).toHaveBeenCalledOnce()
    await f.setLogin(harness, 'second')
    await expect(catalog.discover(f.request(harness), f.context()))
      .resolves.toMatchObject({ authenticated: true, models: [{ id: 'second-model' }] })
    expect(reads).toHaveBeenCalledTimes(2)
    await f.setLogin(harness, null)
    const signedOut = catalog.discover(f.request(harness), f.context())
    if (harness === 'codex') await expect(signedOut).rejects.toMatchObject({ code: 'CODEX_SIGNED_OUT' })
    else await expect(signedOut).resolves.toMatchObject({ authenticated: false, models: [] })
  } finally { await catalog.close(); await f.close() }
})

it.each(['codex', 'claude'] as const)('does not retain a stale %s success after authentication refresh fails', async harness => {
  const f = await workerHarnessCatalogFixture()
  const catalog = createInstalledWorkerHarnessOptions(f.input)
  try {
    await expect(catalog.discover(f.request(harness), f.context()))
      .resolves.toMatchObject({ authenticated: true, models: [{ id: 'first-model' }] })
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 300_001)
    const failure = new DomainError('PROVIDER_AUTHENTICATION_REQUIRED', 'The native session expired.', 409)
    if (harness === 'codex') vi.mocked(qualifyCodex).mockRejectedValue(failure)
    else vi.mocked(loadOfficialClaudeSdk).mockRejectedValue(failure)
    await expect(catalog.discover(f.request(harness), f.context())).rejects.toBe(failure)
    await expect(catalog.discover(f.request(harness), f.context())).rejects.toBe(failure)
  } finally { await catalog.close(); await f.close() }
})
