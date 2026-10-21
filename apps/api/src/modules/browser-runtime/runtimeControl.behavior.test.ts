import { mkdir, mkdtemp, rm } from 'node:fs/promises'
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
