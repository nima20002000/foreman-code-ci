import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { HostCiRunner, systemHostCiPorts, type HostCiPorts } from './runner.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function computer({ prepareDatabase = false, cpuCount = 8 } = {}) {
  const base = process.env.FOREMAN_CODE_TEST_ROOT ?? process.env.TMPDIR
    ?? join(homedir(), '.cache/foreman-code/tests')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'warm-host-'))
  roots.push(root)
  const origin = join(root, 'origin')
  const bin = join(root, 'bin')
  const calls = join(root, 'calls.jsonl')
  const offlineFailure = join(root, 'offline-failure')
  await mkdir(origin)
  await mkdir(bin)
  await writeFile(join(origin, 'package.json'), JSON.stringify({ scripts: { lint: 'fixture' } }))
  await writeFile(join(origin, 'pnpm-lock.yaml'), 'fixture-lock-one')
  await mkdir(join(origin, 'scripts'))
  await writeFile(join(origin, 'scripts/ci-suite.sh'),
    '#!/bin/bash\nif [ "$1" = prepare ]; then ' + (prepareDatabase ? 'corepack pnpm db:up' : 'true')
      + '; else corepack pnpm lint; fi\n')
  await writeFile(join(origin, '.gitignore'), 'node_modules/\nignored-output/\n')
  const environment = gitFixtureEnvironment()
  const git = (...args: string[]) => execFileSync('git', args, { cwd: origin, env: environment, encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'main')
  git('add', '.')
  git('commit', '-qm', 'fixture')
  await writeFile(join(bin, 'corepack'), `#!${process.execPath}
const fs = require('node:fs')
const path = require('node:path')
const args = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + '\\n')
if (args[1] === 'db:up') {
  if (!fs.existsSync('node_modules/dependency')) {
    console.error('Database preparation attempted to reinstall unfinished dependencies')
    process.exit(8)
  }
} else if (args[1] === 'install') {
  if (${prepareDatabase}) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
  if (args.includes('--offline') && fs.existsSync(${JSON.stringify(offlineFailure)})) process.exit(7)
  const storeIndex = args.indexOf('--store-dir')
  const store = storeIndex < 0 ? '.fixture-store' : args[storeIndex + 1]
  const metadataIndex = args.indexOf('--cache-dir')
  const metadata = path.join(metadataIndex < 0 ? '.fixture-metadata' : args[metadataIndex + 1], 'release-age')
  const seed = path.join(store, require('node:crypto').createHash('sha256').update(fs.readFileSync('pnpm-lock.yaml')).digest('hex'))
  if (args.includes('--offline') && (!fs.existsSync(seed) || !fs.existsSync(metadata))) process.exit(7)
  fs.mkdirSync(store, { recursive: true })
  fs.writeFileSync(seed, 'pristine')
  fs.mkdirSync(path.dirname(metadata), { recursive: true })
  fs.writeFileSync(metadata, 'verified package publication time')
  fs.mkdirSync('node_modules', { recursive: true })
  if (!fs.existsSync('node_modules/dependency')) fs.linkSync(seed, 'node_modules/dependency')
} else {
  if (${cpuCount} > 8) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150)
  console.log('dependency=' + fs.readFileSync('node_modules/dependency', 'utf8'))
  fs.writeFileSync('suite-output', 'unfinished output')
}
`, { mode: 0o755 })
  await writeFile(join(bin, 'cp'), `#!/bin/bash
printf '%s\\n' "$*" >> '${join(root, 'copies')}'
exec /bin/cp "$@"
`, { mode: 0o755 })
  await writeFile(join(bin, 'git'), `#!${process.execPath}
const { spawnSync } = require('node:child_process')
const args = process.argv.slice(2).map(arg => arg.startsWith('https://') ? ${JSON.stringify(origin)} : arg)
const result = spawnSync('/usr/bin/git', args, { stdio: 'inherit' })
process.exit(result.status ?? 1)
`, { mode: 0o755 })
  const system = systemHostCiPorts()
  const launched = new Map<string, Promise<unknown>>()
  const checkouts: string[] = []
  const hostCommands: { file: string; args: readonly string[] }[] = []
  const ports: HostCiPorts = { ...system, cpus: cpuCount, memoryBytes: 16 * 2 ** 30,
    availableMemoryBytes: () => 16 * 2 ** 30,
    run: async (file, args, options) => {
      hostCommands.push({ file, args })
      if (file === 'gh') return { code: 0, stdout: '', stderr: '' }
      if (file === 'git' && (args.includes('clone') || args.includes('remote'))) {
        return system.run(file, args.map(arg => arg.startsWith('https://') ? origin : arg), options)
      }
      if (file === 'systemd-run') {
        const cwd = args.find(arg => arg.startsWith('--working-directory='))!.slice('--working-directory='.length)
        const env = Object.fromEntries(args.filter(arg => arg.startsWith('--setenv='))
          .map(arg => arg.slice('--setenv='.length).split(/=(.*)/s).slice(0, 2)))
        checkouts.push(cwd)
        launched.set(args.at(-1)!, system.run('/bin/bash', [args.at(-1)!], { cwd, env }))
        return { code: 0, stdout: '', stderr: '' }
      }
      if (file === 'systemctl') return { code: 0, stdout: 'active', stderr: '' }
      return system.run(file, args, options)
    } }
  const runner = new HostCiRunner(join(root, 'runner'), ports, { ...environment, PATH: `${bin}:${process.env.PATH}` })
  async function run({ warmup = false, restart = false } = {}) {
    const runId = randomUUID()
    const host = restart
      ? new HostCiRunner(join(root, 'runner'), ports, { ...environment, PATH: `${bin}:${process.env.PATH}` }) : runner
    await host.handle({ operation: 'start', runId, repository: 'example/project', commit: git('rev-parse', 'HEAD'),
      suite: warmup ? 'install' : 'lint', ...(warmup ? { warmup } : { part: 'lint-api', scope: 'affected', files: [] }) })
    await vi.waitFor(() => expect(launched.has(join(root, 'runner/runs', runId, 'run.sh'))).toBe(true))
    await launched.get(join(root, 'runner/runs', runId, 'run.sh'))
    return host.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 65_536 })
  }
  const commands = async () => (await readFile(calls, 'utf8')).trim().split('\n')
    .map(line => JSON.parse(line) as string[])
  const failOffline = () => writeFile(offlineFailure, 'store unavailable')
  const copies = async () => existsSync(join(root, 'copies')) ? readFile(join(root, 'copies'), 'utf8') : ''
  const update = async (file: string, contents: string) => {
    await mkdir(dirname(join(origin, file)), { recursive: true })
    await writeFile(join(origin, file), contents)
    git('add', '.')
    git('commit', '-qm', 'fixture update')
  }
  return { run, commands, origin, git, failOffline, copies, checkouts, hostCommands, update }
}

it('runs consecutive parts in the same checkout with zero installs or copies when inputs are unchanged', async () => {
  const fixture = await computer()
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' } })
  const firstCommands = await fixture.commands()
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' } })
  await expect(fixture.run({ restart: true })).resolves.toMatchObject({ run: { state: 'passed' } })
  expect((await fixture.commands()).filter(args => args[1] === 'install'))
    .toEqual(firstCommands.filter(args => args[1] === 'install'))
  expect(new Set(fixture.checkouts).size).toBe(1)
  expect(await fixture.copies()).toBe('')
})

it.each(['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc', '.pnpmfile.cjs', 'apps/api/package.json'])('installs once when %s changes and records successful inputs', async file => {
  const fixture = await computer()
  await fixture.run()
  const firstCount = (await fixture.commands()).length
  await fixture.update(file, 'changed inputs')
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' } })
  const commands = (await fixture.commands()).slice(firstCount)
  const installs = commands.filter(args => args[1] === 'install')
  expect(installs.filter(args => args.includes('--offline'))).toHaveLength(1)
  expect(installs.filter(args => !args.includes('--offline'))).toHaveLength(file === 'pnpm-lock.yaml' ? 1 : 0)
  const installedCount = (await fixture.commands()).length
  await fixture.run()
  expect((await fixture.commands()).slice(installedCount).filter(args => args[1] === 'install')).toEqual([])
})

it('cleans tracked changes, untracked files, ignored files and nested repositories left by a crashed job', async () => {
  const fixture = await computer()
  await fixture.run()
  const source = fixture.checkouts[0]!
  await writeFile(join(source, 'package.json'), 'broken manifest')
  await writeFile(join(source, 'untracked-output'), 'partial result')
  await mkdir(join(source, 'ignored-output'))
  await writeFile(join(source, 'ignored-output/partial'), 'partial result')
  execFileSync('git', ['init', '-q', join(source, 'nested-repository')])
  const installed = (await fixture.commands()).filter(args => args[1] === 'install')
  await expect(fixture.run({ restart: true })).resolves.toMatchObject({ run: { state: 'passed' } })
  expect(JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))).toHaveProperty('scripts.lint')
  for (const name of ['untracked-output', 'ignored-output', 'nested-repository']) {
    expect(existsSync(join(source, name))).toBe(false)
  }
  expect(await readFile(join(source, 'node_modules/dependency'), 'utf8')).toBe('pristine')
  expect((await fixture.commands()).filter(args => args[1] === 'install')).toEqual(installed)
})

it('keeps release-age metadata for offline installs in another slot without dependency copies', async () => {
  const fixture = await computer({ cpuCount: 16 })
  await fixture.run()
  await expect(Promise.all([fixture.run(), fixture.run()])).resolves.toMatchObject([
    { run: { state: 'passed' } }, { run: { state: 'passed' } },
  ])
  expect((await fixture.commands()).filter(args => args[1] === 'install' && !args.includes('--offline'))).toHaveLength(1)
  expect(await fixture.copies()).toBe('')
})

it('refills an unavailable store online once for changed inputs, then skips installs', async () => {
  const fixture = await computer()
  await fixture.run()
  await fixture.failOffline()
  await fixture.update('pnpm-lock.yaml', 'different lock')
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' } })
  const commands = await fixture.commands()
  await fixture.run()
  expect((await fixture.commands()).filter(args => args[1] === 'install'))
    .toEqual(commands.filter(args => args[1] === 'install'))
  expect(commands.filter(args => args[1] === 'install' && !args.includes('--offline'))).toHaveLength(2)
})

it('prewarms every idle slot with install only and the next part skips installation', async () => {
  const fixture = await computer({ cpuCount: 16 })
  await expect(fixture.run({ warmup: true })).resolves.toMatchObject({ run: { state: 'passed' } })
  const warmed = await fixture.commands()
  expect(warmed.every(args => args[1] === 'install')).toBe(true)
  expect(new Set(fixture.checkouts).size).toBe(1)
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' } })
  expect((await fixture.commands()).filter(args => args[1] === 'install')).toEqual(warmed)
})

it('waits for dependencies before database preparation can trigger another install', async () => {
  const fixture = await computer({ prepareDatabase: true })
  await expect(fixture.run()).resolves.toMatchObject({ run: { state: 'passed' } })
  expect(await fixture.commands()).toContainEqual(['pnpm', 'db:up'])
})
