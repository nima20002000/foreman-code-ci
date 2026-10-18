import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parse } from 'yaml'

export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

export function pnpmFetchRecord(cache: string): string {
  return join(cache, 'locks', 'pnpm-fetch-key')
}

async function dependencyInputs(source: string) {
  const files = new Set(['pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml', '.npmrc', '.pnpmfile.cjs']
    .filter(file => existsSync(join(source, file))))
  const lock = parse(await readFile(join(source, 'pnpm-lock.yaml'), 'utf8')) as {
    packages?: Record<string, { resolution?: { tarball?: unknown } }>
  } | null
  for (const dependency of Object.values(lock?.packages ?? {})) {
    const tarball = dependency?.resolution?.tarball
    if (typeof tarball !== 'string' || !tarball.startsWith('file:')) continue
    const file = relative(source, resolve(source, tarball.slice('file:'.length)))
    if (isAbsolute(file) || file === '..' || file.startsWith('..' + sep)) {
      throw new Error('CI prefetch requires local tarballs inside the repository.')
    }
    files.add(file)
  }
  const directories = existsSync(join(source, 'patches')) ? ['patches'] : []
  while (directories.length) {
    const directory = directories.pop()!
    for (const entry of await readdir(join(source, directory), { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) directories.push(file)
      else files.add(file)
    }
  }
  const hash = createHash('sha256').update(process.version).update('\0').update(process.platform)
    .update('\0').update(process.arch)
  const inputs = [...files].sort()
  for (const file of inputs) {
    hash.update(file).update('\0')
    for await (const bytes of createReadStream(join(source, file))) hash.update(bytes)
    hash.update('\0')
  }
  return { key: hash.digest('hex'), files: inputs }
}

/** Prefetches in an isolated tree so pnpm fetch cannot purge a live checkout's modules or hoist settings. */
export async function pnpmInstall(source: string, cache: string, messageFile: string,
  options: { offlineOnly?: boolean } = {}): Promise<string[]> {
  const { key, files } = await dependencyInputs(source)
  const staging = join(cache, 'pnpm-fetch', key)
  const complete = pnpmFetchRecord(cache)
  const store = ` --store-dir ${shellQuote(join(cache, 'pnpm-store'))}`
    + ` --cache-dir ${shellQuote(join(cache, 'pnpm-metadata'))}`
  const fetch = `corepack pnpm fetch --frozen-lockfile --config.confirm-modules-purge=false${store}`
  const install = `corepack pnpm install --frozen-lockfile --config.confirm-modules-purge=false`
    + store
  const ready = `[ -f ${shellQuote(complete)} ] && [ "$(< ${shellQuote(complete)})" = ${shellQuote(key)} ]`
  const prefetch = options.offlineOnly ? `${fetch} --offline`
    : `${fetch} --offline || { echo '[ci-cache] filling store online'; ${fetch} --prefer-offline; }`
  return [
    `export npm_config_cache_dir=${shellQuote(join(cache, 'pnpm-metadata'))}`,
    `${ready} && ${install} --offline || {`,
    `mkdir -p ${shellQuote(join(cache, 'locks'))}`,
    `exec {cache_lock}>${shellQuote(join(cache, 'locks', 'install.lock'))}`,
    'flock --wait 600 "$cache_lock" || {',
    `  printf '%s\\n' ${shellQuote(JSON.stringify({ message:
      'CI_INSTALL_LOCK_DEADLINE_EXCEEDED: install lock unavailable after 600 seconds.' }))} > ${shellQuote(messageFile)}`,
    '  finish 124',
    '}',
    // Dependency snapshots from the previous per-run copy scheme are no longer read.
    `rm -rf ${shellQuote(join(cache, 'modules'))}`,
    // Another request may have filled these inputs while this checkout waited for the lock.
    `${ready} && ${install} --offline || {`,
    `rm -rf -- ${shellQuote(staging)} ${shellQuote(complete)} || finish $?`,
    `mkdir -p ${shellQuote(staging)} || finish $?`,
    ...files.flatMap(file => [
      `mkdir -p ${shellQuote(join(staging, dirname(file)))} || finish $?`,
      `cp -- ${shellQuote(join(source, file))} ${shellQuote(join(staging, file))} || finish $?`,
    ]),
    `(cd ${shellQuote(staging)} && { ${prefetch}; })`,
    'prefetch_code=$?',
    `rm -rf -- ${shellQuote(staging)} || finish $?`,
    '[ "$prefetch_code" = 0 ] || finish "$prefetch_code"',
    `printf '%s\\n' ${shellQuote(key)} > ${shellQuote(complete + '.pending')} || finish $?`,
    `mv -- ${shellQuote(complete + '.pending')} ${shellQuote(complete)} || finish $?`,
    `${install} --offline || finish $?`,
    '}',
    'flock -u "$cache_lock"',
    'exec {cache_lock}>&-',
    '}',
  ]
}
