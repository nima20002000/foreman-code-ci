import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { cp, glob, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, matchesGlob, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { parse, stringify } from 'yaml'
import { pnpmInstall, shellQuote } from '../src/modules/ci-host/warmSetup.js'

const execute = promisify(execFile)
const scripts = fileURLToPath(new URL('../../../scripts/', import.meta.url))
const platform = process.platform === 'android' ? 'linux' : process.platform
const target = `${platform}-${process.arch}`
const version = '0.154.0'
const nativeVersion = `${version}-${target}`
const nativeName = `@openai/codex-${target}`
const triples: Record<string, string> = {
  'linux-x64': 'x86_64-unknown-linux-musl', 'linux-arm64': 'aarch64-unknown-linux-musl',
  'darwin-x64': 'x86_64-apple-darwin', 'darwin-arm64': 'aarch64-apple-darwin',
}

async function fixture() {
  const base = join(homedir(), '.cache/foreman-tmp')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'native-store-'))
  const source = join(root, 'source')
  const downloads: string[] = []
  const requests: string[] = []
  const archives = new Map<string, Buffer>()
  let published = '2020-01-01T00:00:00.000Z'
  let unavailable = false
  const server = createServer((request, response) => {
    const url = decodeURIComponent(request.url ?? '')
    requests.push(url)
    if (unavailable) {
      response.setHeader('Connection', 'close')
      response.writeHead(503)
      response.end('Registry unavailable')
      return
    }
    const tarball = url.slice(url.lastIndexOf('/'))
    if (archives.has(tarball)) {
      downloads.push(tarball)
      response.end(archives.get(tarball))
      return
    }
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ name: '@openai/codex', 'dist-tags': { latest: version },
      time: { [version]: '2020-01-01T00:00:00.000Z', [nativeVersion]: published },
      versions: Object.fromEntries([version, nativeVersion].map(value => [value, {
        name: '@openai/codex', version: value,
        dist: { tarball: `${registry}/codex-${value}.tgz`, integrity: integrity(value) },
        ...(value === version ? { bin: { codex: 'bin/codex.js' },
          optionalDependencies: { [nativeName]: `npm:@openai/codex@${nativeVersion}` } } : {}),
      }])) }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Registry did not bind a TCP port.')
  const registry = `http://127.0.0.1:${address.port}`
  const integrity = (value: string) => 'sha512-' + createHash('sha512')
    .update(archives.get(`/codex-${value}.tgz`)!).digest('base64')
  for (const value of [version, nativeVersion]) {
    const directory = join(root, value, 'package')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'package.json'), JSON.stringify({ name: '@openai/codex', version: value,
      ...(value === version ? { bin: { codex: 'bin/codex.js' },
        optionalDependencies: { [nativeName]: `npm:@openai/codex@${nativeVersion}` } } : {}),
    }))
    const executable = value === version ? 'bin/codex.js' : `vendor/${triples[target]}/bin/codex`
    await mkdir(dirname(join(directory, executable)), { recursive: true })
    await writeFile(join(directory, executable), '#!/usr/bin/env node\nconsole.log("native fixture")\n', { mode: 0o755 })
    const archive = join(root, `codex-${value}.tgz`)
    await execute('tar', ['-czf', archive, '-C', dirname(directory), 'package'])
    archives.set(`/codex-${value}.tgz`, await readFile(archive))
  }
  await mkdir(join(source, 'apps/api'), { recursive: true })
  await mkdir(join(source, 'scripts'))
  for (const script of ['ci-native-payloads.mjs', 'ci-package-paths.mjs']) {
    await symlink(join(scripts, script), join(source, 'scripts', script))
  }
  await writeFile(join(source, 'package.json'), '{"private":true,"packageManager":"pnpm@11.27.0"}')
  await writeFile(join(source, 'apps/api/package.json'), JSON.stringify({ dependencies: { '@openai/codex': version } }))
  await writeFile(join(source, '.npmrc'), `registry=${registry}/\n@openai:registry=${registry}/\nfetch-retries=0\n`)
  await writeFile(join(source, 'pnpm-workspace.yaml'), stringify({ packages: ['apps/*'],
    minimumReleaseAge: 2880, minimumReleaseAgeStrict: true, minimumReleaseAgeIgnoreMissingTime: false }))
  await writeFile(join(source, 'pnpm-lock.yaml'), stringify({ lockfileVersion: '9.0',
    settings: { autoInstallPeers: true, excludeLinksFromLockfile: false },
    importers: { '.': {}, 'apps/api': { dependencies: { '@openai/codex': { specifier: version, version } } } },
    packages: Object.fromEntries([version, nativeVersion].map(value => [`@openai/codex@${value}`, {
      resolution: { integrity: integrity(value) }, ...(value === version ? { hasBin: true } : {}),
    }])),
    snapshots: { [`@openai/codex@${version}`]: {
      optionalDependencies: { [nativeName]: `@openai/codex@${nativeVersion}` },
    }, [`@openai/codex@${nativeVersion}`]: { optional: true } },
  }))
  const cache = join(root, 'cache')
  const metadata = (entry: string) => entry === 'packages' ? join(source, '.logs/pnpm-metadata')
    : join(cache, 'pnpm-metadata')
  const run = async (entry: string) => {
    if (entry === 'packages') return execute(process.execPath, [join(scripts, 'ci-packages.mjs'), 'install', source], {
      cwd: source, env: { ...process.env, CI_PNPM_STORE_CACHE_HIT: 'true' },
    })
    const shell = ['finish() { exit "$1"; }', ...await pnpmInstall(source, cache, join(root, 'message'))].join('\n')
    return execute('/bin/bash', ['-ec', shell], { cwd: source, env: { ...process.env, BASH_ENV: '' } })
  }
  return { root, source, downloads, requests, run, metadata,
    outage: () => { unavailable = true }, recent: () => { published = new Date().toISOString() },
    store: (entry: string) => entry === 'packages' ? join(source, 'node_modules/.pnpm-store') : join(cache, 'pnpm-store'),
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await rm(root, { recursive: true, force: true })
    },
  }
}

for (const entry of ['packages', 'warm setup']) {
  it(`${entry} repairs only the native package when unrelated tarballs have been evicted`, async () => {
    const f = await fixture()
    try {
      await execute('corepack', ['pnpm', 'install', '--frozen-lockfile', '--store-dir', f.store(entry),
        '--cache-dir', f.metadata(entry)], { cwd: f.source })
      await f.run(entry)
      await rm(f.store(entry), { recursive: true })
      await execute('corepack', ['pnpm', 'store', 'add', `@openai/codex@${nativeVersion}`,
        '--store-dir', f.store(entry), `--config.cache-dir=${f.metadata(entry)}`], { cwd: f.source })
      const native = join(f.source, 'node_modules/.pnpm', `@openai+codex@${nativeVersion}`)
      await rm(native, { recursive: true })
      await mkdir(join(native, 'node_modules'), { recursive: true })
      f.requests.length = 0
      f.outage()
      await expect(f.run(entry)).resolves.toMatchObject({ stderr: expect.any(String) })
      expect(f.requests).toEqual([])
      await execute(process.execPath, [join(scripts, 'ci-native-payloads.mjs'), f.source])
    } finally {
      await f.close()
    }
  })

  it(`${entry} provisions the store even when the installed native payload is healthy`, async () => {
    const f = await fixture()
    try {
      await execute('corepack', ['pnpm', 'install', '--frozen-lockfile', '--store-dir', f.store(entry),
        '--cache-dir', f.metadata(entry)], { cwd: f.source })
      await f.run(entry)
      await rm(f.store(entry), { recursive: true })
      f.downloads.length = 0
      await expect(f.run(entry)).resolves.toMatchObject({ stderr: expect.any(String) })
      expect(f.downloads).toContain(`/codex-${nativeVersion}.tgz`)
      await execute(process.execPath, [join(scripts, 'ci-native-payloads.mjs'), f.source])
    } finally {
      await f.close()
    }
  })

  it(`${entry} provisions a lockfile-pinned native payload missing from the CI store`, async () => {
    const f = await fixture()
    try {
      await execute('corepack', ['pnpm', 'install', '--frozen-lockfile', '--no-optional', '--store-dir', f.store(entry),
        '--cache-dir', f.metadata(entry)],
        { cwd: f.source })
      await rm(join(f.source, 'node_modules/.pnpm'), { recursive: true })
      await rm(join(f.source, 'node_modules/.modules.yaml'))
      await rm(join(f.source, 'apps/api/node_modules'), { recursive: true })
      expect(f.downloads).not.toContain(`/codex-${nativeVersion}.tgz`)
      await expect(f.run(entry)).resolves.toMatchObject({ stderr: expect.any(String) })
      expect(f.downloads).toContain(`/codex-${nativeVersion}.tgz`)
      await execute(process.execPath, [join(scripts, 'ci-native-payloads.mjs'), f.source])
    } finally {
      await f.close()
    }
  })

  it(`${entry} repairs an empty virtual-store package from the provisioned store offline`, async () => {
    const f = await fixture()
    try {
      await execute('corepack', ['pnpm', 'install', '--frozen-lockfile', '--store-dir', f.store(entry),
        '--cache-dir', f.metadata(entry)], { cwd: f.source })
      await f.run(entry)
      const native = join(f.source, 'node_modules/.pnpm', `@openai+codex@${nativeVersion}`)
      await rm(native, { recursive: true })
      await mkdir(join(native, 'node_modules'), { recursive: true })
      const before = [...f.downloads]
      await expect(f.run(entry)).resolves.toMatchObject({ stderr: expect.any(String) })
      expect(f.downloads).toEqual(before)
      await execute(process.execPath, [join(scripts, 'ci-native-payloads.mjs'), f.source])
    } finally {
      await f.close()
    }
  })

  it(`${entry} rejects provisioning a native payload younger than the release-age floor`, async () => {
    const f = await fixture()
    try {
      await execute('corepack', ['pnpm', 'install', '--frozen-lockfile', '--no-optional', '--store-dir', f.store(entry),
        '--cache-dir', f.metadata(entry)],
        { cwd: f.source })
      await rm(join(f.source, 'node_modules/.pnpm'), { recursive: true })
      await rm(join(f.source, 'node_modules/.modules.yaml'))
      await rm(join(f.source, 'apps/api/node_modules'), { recursive: true })
      f.recent()
      await rm(f.metadata(entry), { recursive: true, force: true })
      await expect(f.run(entry)).rejects.toMatchObject({ code: 1 })
      expect(f.downloads).not.toContain(`/codex-${nativeVersion}.tgz`)
    } finally {
      await f.close()
    }
  })
}

type CacheStep = { id: string; if?: string; uses?: string; with: { path: string } }

async function copyCache(step: CacheStep, source: string, destination: string) {
  const patterns = step.with.path.trim().split('\n').map(pattern => pattern.trim())
  const exclusions = patterns.filter(pattern => pattern.startsWith('!')).map(pattern => pattern.slice(1))
  const included = (path: string) => !exclusions.some(pattern => matchesGlob(path, pattern)
    || matchesGlob(path, `${pattern}/**`))
  for (const pattern of patterns.filter(pattern => !pattern.startsWith('!'))) {
    for await (const path of glob(pattern, { cwd: source })) {
      if (!included(path)) continue
      await mkdir(dirname(join(destination, path)), { recursive: true })
      await cp(join(source, path), join(destination, path), { recursive: true, verbatimSymlinks: true,
        filter: path => included(relative(source, path)) })
    }
  }
}

function cacheStepEnabled(step: CacheStep, hits: Record<string, string>) {
  if (!step.if) return true
  const condition = /^steps\.(\w+)\.outputs\.cache-hit (!=|==) '(true|false)'$/.exec(step.if)
  if (!condition) throw new Error(`Unsupported cache condition: ${step.if}`)
  const [, id, operator, expected] = condition
  return operator === '==' ? hits[id!] === expected : hits[id!] !== expected
}

it('restores GitHub package-hit native store and publication metadata through a registry outage', async () => {
  const f = await fixture()
  try {
    await execute('corepack', ['pnpm', 'install', '--frozen-lockfile', '--store-dir', f.store('packages'),
      '--cache-dir', f.metadata('packages')], { cwd: f.source })
    await f.run('packages')
    console.error('Cache fixture: installed packages primed')
    const workflow = parse(await readFile(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8'))
    const steps = workflow.jobs.ci.steps as (CacheStep & { name?: string; run?: string; env?: Record<string, string> })[]
    const caches = steps.filter(step => ['packages', 'metadata', 'store'].includes(step.id))
    for (const step of caches) await copyCache(step, f.source, join(f.root, 'archives', step.id))
    console.error('Cache fixture: archives saved')
    await rm(join(f.source, 'node_modules'), { recursive: true })
    await rm(join(f.source, 'apps/api/node_modules'), { recursive: true })
    await rm(join(f.source, '.logs'), { recursive: true })
    const hits: Record<string, string> = {}
    for (const step of caches) {
      if (!cacheStepEnabled(step, hits)) continue
      await copyCache(step, join(f.root, 'archives', step.id), f.source)
      hits[step.id] = 'true'
    }
    console.error('Cache fixture: archives restored', hits)
    const install = steps.find(step => step.name === 'Install from cached store')!
    const render = (value: string) => value.replace(/\$\{\{ steps\.(\w+)\.outputs\.cache-hit \}\}/g,
      (_match, id: string) => hits[id] ?? '')
    const command = render(install.run!).replace('node scripts/ci-packages.mjs',
      `${shellQuote(process.execPath)} ${shellQuote(join(scripts, 'ci-packages.mjs'))}`)
    const environment = Object.fromEntries(Object.entries(install.env ?? {}).map(([key, value]) => [key, render(value)]))
    f.requests.length = 0
    f.outage()
    console.error('Cache fixture: running cached install during outage')
    await expect(execute('/bin/bash', ['-ec', command], { cwd: f.source,
      env: { ...process.env, ...environment, BASH_ENV: '' } })).resolves.toMatchObject({ stderr: expect.any(String) })
    expect(f.requests).toEqual([])
    expect(await readFile(join(f.source, '.logs/ci-packages-restored'), 'utf8'))
      .toBe(await readFile(join(f.source, 'node_modules/.ci-packages-key'), 'utf8'))
    await execute(process.execPath, [join(scripts, 'ci-native-payloads.mjs'), f.source])
  } finally {
    await f.close()
  }
})
