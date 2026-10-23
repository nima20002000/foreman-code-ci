import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { ensureCommit, systemGitWorktreePorts } from './gitWorktree.js'
import { makeStale } from '../../../test/helpers/interruptedGitFetch.js'

async function fixture(stallRepack = false) {
  const root = await mkdtemp(join(persistentFixtureRoot, 'git-clone-health-'))
  const origin = join(root, 'origin')
  await mkdir(origin, { mode: 0o700 })
  const environment: NodeJS.ProcessEnv = { ...gitFixtureEnvironment(), HOME: join(root, 'home') }
  const repacking = join(root, 'repacking')
  if (stallRepack) {
    const bin = join(root, 'bin')
    await mkdir(bin)
    await writeFile(join(bin, 'git'), `#!/bin/sh
case " $* " in *' repack '*) echo started > '${repacking}'; exec sleep 60;; esac
exec /usr/bin/git "$@"
`, { mode: 0o700 })
    environment.PATH = `${bin}:${environment.PATH}`
  }
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args,
    { cwd, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git(origin, 'init', '--template=', '-q', '-b', 'main')
  let serial = 0
  const commit = async () => {
    await writeFile(join(origin, 'source.txt'), `source ${serial++}`)
    git(origin, 'add', '.')
    git(origin, 'commit', '-qm', 'source')
    return git(origin, 'rev-parse', 'HEAD')
  }
  const first = await commit()
  const system = systemGitWorktreePorts(environment)
  const ports = { cloneDirectory: system.cloneDirectory, git: (args: string[],
    options: Parameters<typeof system.git>[1]) => system.git(args.map(arg =>
    arg === 'https://github.com/fixture/project.git' ? `file://${origin}` : arg), options) }
  const clone = await ensureCommit(ports, 'fixture/project', first, AbortSignal.timeout(10_000))
  return { root, origin, environment, git, commit, first, ports, clone, common: join(clone, '.git'), repacking }
}

it.each(['fresh', 'old'])('recovers %s abandoned shallow and GC locks before fetching', async age => {
  const f = await fixture()
  try {
    const names = ['shallow.lock', 'gc.pid.lock']
    for (const name of names) await writeFile(join(f.common, name), 'abandoned')
    if (age === 'old') await makeStale(f.common, names)
    const successor = await f.commit()
    await expect(ensureCommit(f.ports, 'fixture/project', successor, AbortSignal.timeout(2500))).resolves.toBe(f.clone)
    for (const name of names) await expect(readFile(join(f.common, name))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.git(f.clone, 'show', `${successor}:source.txt`)).toBe('source 1')
    expect(f.git(f.clone, 'rev-parse', 'HEAD')).toBe(f.first)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

it('preserves even old shallow and GC locks while a repository fetch is alive', async () => {
  const f = await fixture()
  const ready = join(f.root, 'writer-ready')
  const upload = join(f.root, 'upload-pack')
  await writeFile(upload, `#!/bin/sh\necho ready > '${ready}'\nexec sleep 60\n`, { mode: 0o700 })
  const writer = spawn('git', ['fetch', `--upload-pack=${upload}`, 'origin'],
    { cwd: f.clone, env: f.environment, detached: true, stdio: 'ignore' })
  const closed = once(writer, 'exit')
  try {
    await vi.waitFor(async () => expect(await readFile(ready, 'utf8')).toContain('ready'))
    for (const name of ['shallow.lock', 'gc.pid.lock']) await writeFile(join(f.common, name), 'live')
    await makeStale(f.common, ['shallow.lock', 'gc.pid.lock'])
    const successor = await f.commit()
    await expect(ensureCommit(f.ports, 'fixture/project', successor, AbortSignal.timeout(1500))).rejects.toThrow()
    for (const name of ['shallow.lock', 'gc.pid.lock']) expect(await readFile(join(f.common, name), 'utf8')).toBe('live')
  } finally {
    process.kill(-writer.pid!, 'SIGTERM')
    await closed
    await rm(f.root, { recursive: true, force: true })
  }
})

it.each([false, true])('bounds pack maintenance and retains source and Agent commits (stalled repack: %s)', async stalled => {
  const f = await fixture(stalled)
  try {
    const commits = [f.first]
    f.git(f.clone, 'branch', 'foreman/agent', f.first)
    // Seed distinct real packs cheaply, without doing scores of network fetches in the fixture.
    for (let index = 0; index < 65; index++) {
      const commit = await f.commit()
      commits.push(commit)
      const pack = execFileSync('git', ['pack-objects', '--stdout', '--revs'],
        { cwd: f.origin, env: f.environment, input: `${commit}\n^${commits.at(-2)!}\n` })
      execFileSync('git', ['index-pack', '--stdin'], { cwd: f.clone, env: f.environment, input: pack, stdio: ['pipe', 'pipe', 'pipe'] })
    }
    const packs = async () => (await readdir(join(f.common, 'objects', 'pack'))).filter(name => name.endsWith('.pack'))
    expect((await packs()).length).toBeGreaterThan(64)
    const successor = await f.commit()
    const started = Date.now()
    await ensureCommit(f.ports, 'fixture/project', successor, AbortSignal.timeout(10_000))
    expect(Date.now() - started).toBeLessThan(8000)
    if (stalled) expect(await readFile(f.repacking, 'utf8')).toContain('started')
    else expect((await packs()).length).toBeLessThan(64)
    for (const commit of [...commits, successor]) expect(f.git(f.clone, 'cat-file', '-t', commit)).toBe('commit')
    expect(f.git(f.clone, 'rev-parse', 'foreman/agent')).toBe(f.first)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
