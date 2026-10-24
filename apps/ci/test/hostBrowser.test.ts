import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { mkdtemp, mkdir, access, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createHostAdministration, type HostBrowserPorts } from '../src/hostAdmin/index.js'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))) })

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'host-browser-'))
  directories.push(directory)
  const child = Object.assign(new EventEmitter(), {
    pid: 123, stderr: new PassThrough(), exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(() => true),
  })
  const runtimeDirectory = { directory: join(directory, 'runtime'), aliasDirectory: null, temporaryDirectory: join(directory, 'runtime/tmp') }
  const ports: HostBrowserPorts = {
    spawn: vi.fn(() => child as unknown as ChildProcess), environment: () => ({ DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0' }),
    temporaryDirectory: () => '/fallback', findVirtualDisplay: vi.fn(async () => null),
    processAlive: () => false, processBirthId: () => 'birth', writePrivateJson: vi.fn(async () => undefined),
    createRuntimeDirectory: async () => runtimeDirectory, removeRuntimeDirectory: vi.fn(async () => undefined),
  }
  return { directory, child, runtimeDirectory, ports, browser: createHostAdministration({ browser: ports, actionDirectory: directory }).browser,
    input: { executable: '/chromium', directory, token: 'owner', headless: false } }
}

it('launches visible Chromium with the owner, private temp directory and fresh tabs', async () => {
  const f = await fixture()
  const sessions = join(f.directory, 'Default', 'Sessions')
  await mkdir(sessions, { recursive: true })
  await writeFile(join(sessions, 'old-session'), 'old')
  const launched = await f.browser.launch(f.input)
  expect(launched.process.pid).toBe(123)
  expect(launched.birthId).toBe('birth')
  expect(f.ports.spawn).toHaveBeenCalledWith('/chromium', [
    `--user-data-dir=${f.directory}`, '--foreman-browser-owner=owner',
    '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled', '--disable-background-networking', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'], env: { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', TMPDIR: f.runtimeDirectory.temporaryDirectory } })
  await expect(access(sessions)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.ports.findVirtualDisplay).not.toHaveBeenCalled()
  f.child.emit('exit', 0)
  expect(f.ports.removeRuntimeDirectory).toHaveBeenCalledWith(f.runtimeDirectory)
})

it('preserves fatal launch errors and cleans up failed Chromium processes', async () => {
  const f = await fixture()
  const launched = await f.browser.launch(f.input)
  f.child.stderr.write('[123:FATAL:profile_lock] profile is in use\n')
  f.child.signalCode = 'SIGABRT'
  expect(() => launched.assertRunning()).toThrow('profile is in use')
  const cause = new Error('endpoint unavailable')
  await expect(launched.abort(cause)).rejects.toMatchObject({
    code: 'BROWSER_LAUNCH_FAILED', status: 409, details: { retryable: false }, cause,
  })
  expect(f.child.kill).toHaveBeenCalledWith('SIGTERM')
  expect(f.ports.removeRuntimeDirectory).toHaveBeenCalledWith(f.runtimeDirectory)
})

it('preserves setup errors when a Chromium process cannot start', async () => {
  const f = await fixture()
  const launched = await f.browser.launch(f.input)
  const cause = new Error('executable missing')
  f.child.emit('error', cause)
  expect(() => launched.assertRunning()).toThrow(cause)
  await expect(launched.abort(cause)).rejects.toMatchObject({ code: 'BROWSER_RUNTIME_MISSING', status: 503, cause })
})

it.runIf(process.platform === 'linux')('reports the existing missing-Xvfb error before starting hidden Chromium', async () => {
  const f = await fixture()
  await expect(f.browser.launch({ ...f.input, headless: true })).rejects.toMatchObject({ code: 'BROWSER_RUNTIME_MISSING', status: 503 })
  expect(f.ports.spawn).not.toHaveBeenCalled()
})
