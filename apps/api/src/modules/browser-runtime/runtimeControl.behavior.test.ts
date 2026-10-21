import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { startBrowserRuntimeControl } from './runtimeControl.js'

it('drains and resumes the owning browser through a long private state directory', async () => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(parent, 'browser-control-'))
  const stateDirectory = join(directory, 'private-state-'.repeat(12))
  const root = join(stateDirectory, 'browser')
  await mkdir(root, { recursive: true, mode: 0o700 })
  const host = { stopAdmission: vi.fn(), resumeAdmission: vi.fn(), activeSessionCount: () => 0,
    closeIdleProfiles: vi.fn(async () => undefined) }
  const failures = vi.fn()
  let control: Awaited<ReturnType<typeof startBrowserRuntimeControl>> | undefined
  try {
    control = await startBrowserRuntimeControl(root, host, async () => undefined, failures)
    const { requestProductionBrowserDrain }: { requestProductionBrowserDrain(input: {
      stateDirectory: string; operation: string; commandId: string
    }): Promise<{ state: string }> } = await import(new URL('../../../../../scripts/local-production-runtime.mjs', import.meta.url).href)
    const input = { stateDirectory, commandId: 'update' }
    expect(await requestProductionBrowserDrain({ ...input, operation: 'beginDrain' })).toEqual({ state: 'drained', activeSessions: 0 })
    expect(control.draining()).toBe(true)
    expect(host.stopAdmission).toHaveBeenCalledOnce()
    expect(host.closeIdleProfiles).toHaveBeenCalledOnce()
    expect(await requestProductionBrowserDrain({ ...input, operation: 'cancelDrain' })).toEqual({ state: 'canceled' })
    expect(host.resumeAdmission).toHaveBeenCalledOnce()
    expect(control.draining()).toBe(false)
    expect(failures).not.toHaveBeenCalled()
  } finally {
    await control?.close()
    await rm(directory, { recursive: true, force: true })
  }
})

it('completes a core cutover with failed browser setup and lets a repaired host admit the next drain', async () => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(parent, 'browser-cutover-'))
  const stateDirectory = join(directory, 'state'), appRoot = join(directory, 'app')
  const root = join(stateDirectory, 'browser')
  const previousRelease = join(directory, 'previous'), release = join(directory, 'next')
  for (const path of [root, previousRelease, release]) await mkdir(path, { recursive: true, mode: 0o700 })
  await writeFile(join(previousRelease, 'browser-runtime.json'), JSON.stringify({ runtimeRoot: join(appRoot, 'browser-runtime'),
    state: 'ready', staged: { manifestSha256: 'a'.repeat(64) } }), { mode: 0o600 })
  await writeFile(join(release, 'browser-runtime.json'), JSON.stringify({ runtimeRoot: join(appRoot, 'browser-runtime'),
    state: 'failed', retryable: true, reason: 'Browser prerequisite missing' }), { mode: 0o600 })
  const installer = await import(new URL('../../../../../scripts/local-production-runtime.mjs', import.meta.url).href)
  const failures = vi.fn()
  const host = { stopAdmission: vi.fn(), resumeAdmission: vi.fn(), activeSessionCount: () => 0,
    closeIdleProfiles: vi.fn(async () => undefined) }
  let control: Awaited<ReturnType<typeof startBrowserRuntimeControl>> | undefined
  let selected = previousRelease
  try {
    control = await startBrowserRuntimeControl(root, host, async () => undefined, failures)
    await installer.runReleaseCutover({ release, previousRelease, stateFile: join(directory, 'cutover.json'), steps: {
      browserRuntime: installer.productionBrowserRuntimeLifecycle({ appRoot, stateDirectory }),
      pendingMigrations: async () => [],
      stop: async () => { expect(control!.draining()).toBe(true); await control!.close(); control = undefined },
      migrate: async () => undefined, upgradeLauncher: async () => undefined, enable: async () => undefined,
      activate: async (value: string) => { selected = value }, start: async () => undefined,
      ready: async () => { expect(selected).toBe(release) },
    } })
    expect(selected).toBe(release)
    const repaired = { ...host, stopAdmission: vi.fn(), resumeAdmission: vi.fn() }
    control = await startBrowserRuntimeControl(root, repaired, async () => undefined, failures)
    expect(control.draining()).toBe(false)
    expect(repaired.stopAdmission).not.toHaveBeenCalled()
    expect(await installer.requestProductionBrowserDrain({ stateDirectory, operation: 'beginDrain', commandId: 'next-update' }))
      .toEqual({ state: 'drained', activeSessions: 0 })
    await installer.requestProductionBrowserDrain({ stateDirectory, operation: 'cancelDrain', commandId: 'next-update' })
    expect(failures).not.toHaveBeenCalled()
  } finally { await control?.close(); await rm(directory, { recursive: true, force: true }) }
})

it('does not clear a stopped host drain owned by another cutover when browser setup failed', async () => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(parent, 'browser-drain-owner-'))
  const stateDirectory = join(directory, 'state'), root = join(stateDirectory, 'browser'), appRoot = join(directory, 'app')
  const release = join(directory, 'release')
  await mkdir(root, { recursive: true, mode: 0o700 }); await mkdir(release, { mode: 0o700 })
  await writeFile(join(release, 'browser-runtime.json'), JSON.stringify({ runtimeRoot: join(appRoot, 'browser-runtime'),
    state: 'failed', retryable: true, reason: 'Browser prerequisite missing' }), { mode: 0o600 })
  const installer = await import(new URL('../../../../../scripts/local-production-runtime.mjs', import.meta.url).href)
  const host = { stopAdmission: vi.fn(), resumeAdmission: vi.fn(), activeSessionCount: () => 0,
    closeIdleProfiles: async () => undefined }
  let control: Awaited<ReturnType<typeof startBrowserRuntimeControl>> | undefined
  try {
    control = await startBrowserRuntimeControl(root, host, async () => undefined, error => { throw error })
    await installer.requestProductionBrowserDrain({ stateDirectory, operation: 'beginDrain', commandId: 'owner' })
    await control.close(); control = undefined
    const lifecycle = installer.productionBrowserRuntimeLifecycle({ appRoot, stateDirectory })
    await expect(lifecycle.activate(release, 'another-update')).rejects.toThrow('Another runtime update owns this drain')
    control = await startBrowserRuntimeControl(root, host, async () => undefined, error => { throw error })
    expect(control.draining()).toBe(true)
    await control.close(); control = undefined
    expect(await lifecycle.activate(release, 'owner')).toMatchObject({ changed: false, state: 'failed' })
    control = await startBrowserRuntimeControl(root, host, async () => undefined, error => { throw error })
    expect(control.draining()).toBe(false)
  } finally { await control?.close(); await rm(directory, { recursive: true, force: true }) }
})
