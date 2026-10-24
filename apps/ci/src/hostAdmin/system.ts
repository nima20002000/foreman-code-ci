import { DomainError } from '@foreman-code/contracts-node/server-kit'

/** What OS administration needs from the computer it runs on. Maintenance ports satisfy it. */
export interface HostSystemPorts {
  /** Absolute executable path, or null when not installed. */
  find(name: string): Promise<string | null>
  run(binary: string, args: string[], options: {
    signal: AbortSignal; timeoutMs: number; environment?: NodeJS.ProcessEnv | undefined
  }): Promise<{ code: number | null; stdout: string; stderr: string }>
  exists(path: string): Promise<boolean>
  /** Runs fn after ms; a restart uses it so the reply reaches Main before the computer goes down. */
  later(fn: () => void, ms: number): void
}

/** Runs one command of a task and records its output; a failing exit throws unless the step allows it. */
export type HostStep = (binary: string, args: string[], label: string,
  options?: { timeoutMs?: number; allowFailure?: boolean; environment?: NodeJS.ProcessEnv | undefined })
  => Promise<{ code: number | null; stdout: string; stderr: string }>

const APT = ['env', 'LC_ALL=C', 'DEBIAN_FRONTEND=noninteractive', 'NEEDRESTART_MODE=a', 'apt-get', '-y', '-q',
  '-o', 'Dpkg::Options::=--force-confdef', '-o', 'Dpkg::Options::=--force-confold']
const REBOOT_REQUIRED = '/var/run/reboot-required'

/** OS packages and restarts of one computer: Main for itself, a paired computer's agent for Main's requests. */
export class HostSystem {
  constructor(private readonly ports: HostSystemPorts) {}

  rebootRequired(): Promise<boolean> {
    return this.ports.exists(REBOOT_REQUIRED)
  }

  /** Whether `sudo -n` works; false only for a clear refusal, a failed inspection throws. */
  async sudo(signal: AbortSignal): Promise<boolean> {
    const result = await this.ports.run('sudo', ['-n', 'true'], { signal, timeoutMs: 10_000 })
    if (result.code === 0) return true
    if (result.code === 1 && /a password is required|not allowed to execute|not in the sudoers/iu.test(result.stderr)) return false
    throw new DomainError('COMPUTER_PRIVILEGE_CHECK_UNAVAILABLE', `Sudo inspection failed (exit ${result.code}).`, 503)
  }

  /** Pending updates (including held-back ones) and the ones that can be installed now; null without apt-get. */
  async packageUpdates(signal: AbortSignal): Promise<{ pending: number; installable: number } | null> {
    const apt = await this.ports.find('apt-get')
    if (!apt) return null
    const result = await this.ports.run(apt, ['-s', '-o', 'Debug::NoLocking=1', '--with-new-pkgs', 'upgrade'],
      { signal, timeoutMs: 60_000 })
    if (result.code !== 0) throw new DomainError('COMPUTER_PACKAGE_UPDATES_UNAVAILABLE',
      `Package updates inspection failed (exit ${result.code}).`, 503)
    const counts = result.stdout.match(/(\d+) upgraded, (\d+) newly installed, \d+ to remove and (\d+) not upgraded\./u)
    if (!counts) throw new DomainError('COMPUTER_PACKAGE_UPDATES_UNAVAILABLE',
      'Package updates inspection returned invalid output.', 503)
    return { pending: Number(counts[1]) + Number(counts[3]), installable: Number(counts[1]) + Number(counts[2]) }
  }

  /** apt-get update and upgrade; returns the summary a task reports. */
  async update(step: HostStep, signal: AbortSignal): Promise<string> {
    await this.requireSudo(signal)
    await step('sudo', ['-n', ...APT, 'update'], 'apt-get update')
    const upgrade = await step('sudo', ['-n', ...APT, '--with-new-pkgs', 'upgrade'], 'apt-get upgrade --with-new-pkgs')
    const upgraded = upgrade.stdout.match(/(\d+) upgraded/u)?.[1]
    if (!upgraded) throw new Error('The package upgrade result could not be read; check pending updates before retrying.')
    const remaining = await this.packageUpdates(signal)
    if (!remaining) throw new Error(`${upgraded} packages upgraded, but remaining updates could not be verified.`)
    if (remaining.installable > 0) {
      throw new Error(`${upgraded} packages upgraded; ${remaining.installable} installable updates remain.`)
    }
    const reboot = await this.rebootRequired()
    const pending = remaining.pending ? ` · ${remaining.pending} updates pending (deferred or held by APT)` : ' · no pending updates'
    return `${upgraded} packages upgraded${pending}${reboot ? ' · restart needed' : ''}`
  }

  /** Restarts the computer a few seconds after `announce` has recorded that it will. */
  async restart(step: HostStep, signal: AbortSignal, announce: () => Promise<void>): Promise<string> {
    await this.requireSudo(signal)
    await announce()
    await new Promise<void>(resolve => { this.ports.later(resolve, 3_000) })
    await step('sudo', ['-n', 'systemctl', 'reboot'], 'Restart command', { timeoutMs: 60_000 })
    return 'Restart command accepted. Waiting for this computer to reconnect.'
  }

  private async requireSudo(signal: AbortSignal): Promise<void> {
    if (!await this.sudo(signal)) throw new Error('This computer needs passwordless sudo for OS updates and restarts.')
  }
}
