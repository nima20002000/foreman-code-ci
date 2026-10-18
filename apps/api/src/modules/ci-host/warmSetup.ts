import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

export function pnpmFetchRecords(cache: string): string {
  return join(cache, 'locks', 'pnpm-fetch')
}

async function dependencyInputs(source: string) {
  const files = ['pnpm-lock.yaml', 'package.json', 'pnpm-workspace.yaml', '.npmrc', '.pnpmfile.cjs']
    .filter(file => existsSync(join(source, file)))
  const directories = existsSync(join(source, 'patches')) ? ['patches'] : []
  while (directories.length) {
    const directory = directories.pop()!
    for (const entry of await readdir(join(source, directory), { withFileTypes: true })) {
      const file = join(directory, entry.name)
      if (entry.isDirectory()) directories.push(file)
      else files.push(file)
    }
  }
  const hash = createHash('sha256').update(process.version).update('\0').update(process.platform)
    .update('\0').update(process.arch)
  for (const file of files.sort()) hash.update(file).update('\0').update(await readFile(join(source, file))).update('\0')
  return { key: hash.digest('hex'), files }
}

/** Prefetches in an isolated tree so pnpm fetch cannot purge a live checkout's modules or hoist settings. */
export async function pnpmInstall(source: string, cache: string, messageFile: string,
  options: { offlineOnly?: boolean } = {}): Promise<string[]> {
  const { key, files } = await dependencyInputs(source)
  const staging = join(cache, 'pnpm-fetch', key)
  const records = pnpmFetchRecords(cache)
  const complete = join(records, key)
  const store = ` --store-dir ${shellQuote(join(cache, 'pnpm-store'))}`
    + ` --cache-dir ${shellQuote(join(cache, 'pnpm-metadata'))}`
  const fetch = `corepack pnpm fetch --frozen-lockfile --config.confirm-modules-purge=false${store}`
  const install = `corepack pnpm install --frozen-lockfile --config.confirm-modules-purge=false`
    + store
  const ready = `[ -f ${shellQuote(complete)} ]`
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
    `mkdir -p ${shellQuote(records)} || finish $?`,
    `touch -- ${shellQuote(complete)} || finish $?`,
    `${install} --offline || finish $?`,
    '}',
    'flock -u "$cache_lock"',
    'exec {cache_lock}>&-',
    '}',
  ]
}
