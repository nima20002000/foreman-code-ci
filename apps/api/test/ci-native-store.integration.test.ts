import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { stringify } from 'yaml'
import { pnpmInstall } from '../src/modules/ci-host/warmSetup.js'

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
  const archives = new Map<string, Buffer>()
  let published = '2020-01-01T00:00:00.000Z'
  const server = createServer((request, response) => {
    const url = decodeURIComponent(request.url ?? '')
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
  await writeFile(join(source, '.npmrc'), `registry=${registry}/\n@openai:registry=${registry}/\n`)
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
  const run = async (entry: string) => {
    if (entry === 'packages') return execute(process.execPath, [join(scripts, 'ci-packages.mjs'), 'install', source], {
      cwd: source, env: { ...process.env, CI_PNPM_STORE_CACHE_HIT: 'true' },
    })
    const shell = ['finish() { exit "$1"; }', ...await pnpmInstall(source, cache, join(root, 'message'))].join('\n')
    return execute('/bin/bash', ['-ec', shell], { cwd: source, env: { ...process.env, BASH_ENV: '' } })
  }
  return { root, source, downloads, run, recent: () => { published = new Date().toISOString() },
    store: (entry: string) => entry === 'packages' ? join(source, 'node_modules/.pnpm-store') : join(cache, 'pnpm-store'),
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
      await rm(root, { recursive: true, force: true })
    },
  }
}

for (const entry of ['packages', 'warm setup']) {
  it(`${entry} provisions a lockfile-pinned native payload missing from the CI store`, async () => {
    const f = await fixture()
    try {
      await execute('corepack', ['pnpm', 'install', '--frozen-lockfile', '--no-optional', '--store-dir', f.store(entry)],
        { cwd: f.source })
      await rm(join(f.source, 'node_modules'), { recursive: true })
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
      await execute('corepack', ['pnpm', 'install', '--frozen-lockfile', '--store-dir', f.store(entry)], { cwd: f.source })
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
      await execute('corepack', ['pnpm', 'install', '--frozen-lockfile', '--no-optional', '--store-dir', f.store(entry)],
        { cwd: f.source })
      await rm(join(f.source, 'node_modules'), { recursive: true })
      await rm(join(f.source, 'apps/api/node_modules'), { recursive: true })
      f.recent()
      await expect(f.run(entry)).rejects.toMatchObject({ code: 1 })
      expect(f.downloads).not.toContain(`/codex-${nativeVersion}.tgz`)
    } finally {
      await f.close()
    }
  })
}
