import { expect, it } from 'vitest'
import { createHostAdministration, type HostStep, type HostSystemPorts } from '../src/hostAdmin/index.js'

const signal = new AbortController().signal
const simulation = (pending: string) => `Inst libc6\n${pending}`

function computer(options: { sudo?: 'yes' | 'password' | 'broken'; upgraded?: number; remaining?: string; reboot?: boolean } = {}) {
  const calls: string[] = []
  const ports: HostSystemPorts = {
    find: async name => name === 'apt-get' ? '/usr/bin/apt-get' : null,
    exists: async path => path === '/var/run/reboot-required' && Boolean(options.reboot),
    later: fn => { calls.push('later'); fn() },
    run: async (binary, args) => {
      calls.push([binary, ...args].join(' '))
      if (binary === 'sudo' && args.join(' ') === '-n true') {
        if (options.sudo === 'password') return { code: 1, stdout: '', stderr: 'sudo: a password is required' }
        if (options.sudo === 'broken') return { code: 2, stdout: '', stderr: 'sudo: unexpected' }
        return { code: 0, stdout: '', stderr: '' }
      }
      return { code: 0, stderr: '', stdout: simulation(options.remaining ?? '0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.') }
    },
  }
  const step: HostStep = async (binary, args, label) => {
    calls.push(`step ${label}`)
    const stdout = label.startsWith('apt-get upgrade') ? `${options.upgraded ?? 3} upgraded, 0 newly installed` : ''
    return { code: 0, stdout, stderr: '' }
  }
  return { host: createHostAdministration(ports), step, calls }
}

it('reports pending and installable package updates, and none without apt-get', async () => {
  const { host } = computer({ remaining: '2 upgraded, 1 newly installed, 0 to remove and 4 not upgraded.' })
  expect(await host.system.packageUpdates(signal)).toEqual({ pending: 6, installable: 3 })
  const bare = createHostAdministration({ find: async () => null, exists: async () => false, later: () => {},
    run: async () => { throw new Error('nothing runs without apt-get') } })
  expect(await bare.system.packageUpdates(signal)).toBeNull()
})

it('upgrades packages and summarizes what remains and whether a restart is needed', async () => {
  const { host, step } = computer({ reboot: true, remaining: '0 upgraded, 0 newly installed, 0 to remove and 2 not upgraded.' })
  expect(await host.system.update(step, signal))
    .toBe('3 packages upgraded · 2 updates pending (deferred or held by APT) · restart needed')
})

it('fails an upgrade that leaves installable updates, and one without passwordless sudo', async () => {
  const left = computer({ remaining: '1 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.' })
  await expect(left.host.system.update(left.step, signal)).rejects.toThrow('3 packages upgraded; 1 installable updates remain.')
  const refused = computer({ sudo: 'password' })
  await expect(refused.host.system.update(refused.step, signal)).rejects.toThrow('needs passwordless sudo')
  expect(refused.calls).not.toContain('step apt-get update')
  expect(await refused.host.system.sudo(signal)).toBe(false)
  await expect(computer({ sudo: 'broken' }).host.system.sudo(signal)).rejects.toMatchObject({
    code: 'COMPUTER_PRIVILEGE_CHECK_UNAVAILABLE', status: 503 })
})

it('announces a restart before it waits and reboots', async () => {
  const { host, step, calls } = computer()
  const result = await host.system.restart(step, signal, async () => { calls.push('announce') })
  expect(result).toBe('Restart command accepted. Waiting for this computer to reconnect.')
  expect(calls.filter(call => ['announce', 'later', 'step Restart command'].includes(call)))
    .toEqual(['announce', 'later', 'step Restart command'])
})
