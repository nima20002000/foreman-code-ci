import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { pnpmInstall } from './warmSetup.js'

async function runWarmInstall(root: string, bin: string, environment: NodeJS.ProcessEnv) {
  const script = ['finish() { exit "$1"; }',
    ...await pnpmInstall(root, join(root, 'cache'), join(root, 'message'))].join('\n')
  await promisify(execFile)('/bin/bash', ['-c', script], {
    cwd: root, env: { ...environment, BASH_ENV: '', PATH: `${bin}:/usr/bin:/bin` },
  })
}

it.each([false, true])(
  'installs warm dependencies while the shared online refill lock is unavailable (runner shell startup: %s)',
  async (runnerShellStartup) => {
    const base = join(homedir(), '.cache', 'foreman-tmp')
    await mkdir(base, { recursive: true })
    const root = await mkdtemp(join(base, 'warm-install-'))
    try {
      const bin = join(root, 'bin')
      await mkdir(bin)
      const calls = join(root, 'calls')
      await writeFile(join(root, 'package.json'), '{"packageManager":"pnpm@11.27.0"}\n')
      await writeFile(join(root, 'pnpm-lock.yaml'), 'fixture lockfile\n')
      await writeFile(join(bin, 'corepack'), `#!${process.execPath}\n`
        + `require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n')\n`,
      { mode: 0o700 })
      const environment = { ...process.env }
      if (runnerShellStartup) {
        const runnerBin = join(root, 'runner-bin')
        await mkdir(runnerBin)
        await writeFile(join(runnerBin, 'corepack'), '#!/bin/sh\necho unexpected-runner-corepack >&2\nexit 23\n',
          { mode: 0o700 })
        const shellEnvironment = join(root, 'shell-environment')
        await writeFile(shellEnvironment, 'export PATH="$RUNNER_BIN:$PATH"\n')
        environment.BASH_ENV = shellEnvironment
        environment.RUNNER_BIN = runnerBin
      }
      await runWarmInstall(root, bin, environment)
      const commands = async () => (await readFile(calls, 'utf8')).trim().split('\n')
        .map(line => JSON.parse(line) as string[])
      expect(await commands()).toEqual([
        expect.arrayContaining(['pnpm', 'fetch', '--offline', '--frozen-lockfile']),
        expect.arrayContaining(['pnpm', 'install', '--offline', '--frozen-lockfile']),
      ])
      await writeFile(calls, '')
      const holder = spawn('/usr/bin/flock', ['--exclusive', join(root, 'cache/locks/install.lock'),
        '/bin/sh', '-c', 'printf "locked\\n"; read -r release'])
      const closed = once(holder, 'close')
      try {
        const [ready] = await once(holder.stdout, 'data')
        expect(String(ready)).toContain('locked')
        // Fail immediately if a warm checkout unexpectedly tries to acquire the occupied refill lock.
        await writeFile(join(bin, 'flock'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
        await runWarmInstall(root, bin, environment)
        expect(await commands()).toEqual([
          expect.arrayContaining(['pnpm', 'install', '--offline', '--frozen-lockfile']),
        ])
      } finally {
        holder.stdin.end('release\n')
        await closed
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
