import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DomainError } from '@foreman-code/contracts-node/server-kit'
import { BrowserVirtualDisplay } from './virtualDisplay.js'

export interface HostBrowserRuntimeDirectory {
  directory: string
  aliasDirectory: string | null
  temporaryDirectory: string
}

/** Platform operations supplied by the host, shared with its other managed processes. */
export interface HostBrowserPorts {
  spawn(binary: string, args: string[], options: SpawnOptions): ChildProcess
  environment(): NodeJS.ProcessEnv
  temporaryDirectory(): string | undefined
  findVirtualDisplay(): Promise<string | null>
  processAlive(pid: number, birthId?: string | null): boolean
  processBirthId(pid: number): string | null
  writePrivateJson(directory: string, name: string, value: unknown): Promise<void>
  createRuntimeDirectory(parent: string): Promise<HostBrowserRuntimeDirectory | null>
  removeRuntimeDirectory(directory: HostBrowserRuntimeDirectory | null | undefined): Promise<void>
}

/** The host owns Chromium processes and their shared display; the API owns their CDP sessions. */
export class HostBrowser {
  private readonly display: BrowserVirtualDisplay
  constructor(private readonly actionDirectory: string, private readonly ports: HostBrowserPorts) {
    this.display = new BrowserVirtualDisplay(actionDirectory, ports)
  }

  closeVirtualDisplay(): Promise<void> { return this.display.close() }

  async launch(input: { executable: string; directory: string; token: string; headless: boolean }) {
    const { executable, directory, token, headless } = input
    // A new process must not restore the previous process's unowned tabs.
    await rm(join(directory, 'Default', 'Sessions'), { recursive: true, force: true })
    const display = headless && process.platform === 'linux' ? await this.display.ensure() : undefined
    const args = [`--user-data-dir=${directory}`, `--foreman-browser-owner=${token}`,
      '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--no-first-run', '--no-default-browser-check',
      // Chromium sets navigator.webdriver for any remote-debugged browser; sites read it as a bot signal.
      '--disable-blink-features=AutomationControlled', '--disable-background-networking',
      // Hidden browsers otherwise start at 800x600, which sites treat as a tablet or phone.
      ...(display ? ['--ozone-platform=x11', '--window-position=0,0', '--window-size=1440,900']
        : headless ? ['--headless=new', '--window-size=1440,900'] : []), 'about:blank']
    // Chromium's own profile lock remains authoritative; no lock removal or sandbox bypass.
    const runtimeDirectory = await this.ports.createRuntimeDirectory(this.actionDirectory)
    const env: NodeJS.ProcessEnv = { ...this.ports.environment(), TMPDIR: runtimeDirectory?.temporaryDirectory ?? this.ports.temporaryDirectory() }
    if (display) { env.DISPLAY = display; delete env.WAYLAND_DISPLAY }
    const child = this.ports.spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], env })
    // Keep only Chromium's last fatal line, so a launch failure names its own cause.
    let fatal = ''
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      const line = chunk.split('\n').reverse().find(value => value.includes(':FATAL:'))
      if (line) fatal = line.replace(/^\[[^\]]*\]\s*/, '').slice(0, 400)
    })
    child.once('exit', () => {
      void this.ports.removeRuntimeDirectory(runtimeDirectory).catch(error => console.error('Managed browser runtime directory cleanup failed', error))
    })
    let failed: Error | undefined
    child.once('error', error => { failed = error })
    const birthId = child.pid ? this.ports.processBirthId(child.pid) : null
    return {
      process: child, runtimeDirectory, birthId,
      assertRunning: () => {
        // A crash ends with a signal and leaves exitCode null.
        if (failed || child.exitCode !== null || child.signalCode !== null) {
          throw failed ?? new Error(`Browser launch exited${fatal ? `: ${fatal}` : ''}`)
        }
      },
      abort: async (error: unknown): Promise<never> => {
        child.kill('SIGTERM')
        if (!child.pid || !this.ports.processAlive(child.pid, birthId)) await this.ports.removeRuntimeDirectory(runtimeDirectory)
        const exited = child.exitCode !== null || child.signalCode !== null
        if (exited && fatal) throw new DomainError('BROWSER_LAUNCH_FAILED',
          `The managed browser exited while starting: ${fatal}`, 409, { retryable: false }, { cause: error })
        throw new DomainError('BROWSER_RUNTIME_MISSING', 'The managed browser could not start. Check runtime setup and the profile lock.', 503, undefined, { cause: error })
      },
    }
  }
}
