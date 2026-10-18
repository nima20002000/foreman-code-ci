import { join } from 'node:path'

export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

/** Fetches the full lockfile before installing each checkout. Clone-or-copy keeps suite mutations out of the store. */
export function pnpmInstall(cache: string, messageFile: string, options: { offlineOnly?: boolean } = {}): string[] {
  const store = ` --store-dir ${shellQuote(join(cache, 'pnpm-store'))}`
    + ` --cache-dir ${shellQuote(join(cache, 'pnpm-metadata'))}`
  const fetch = `corepack pnpm fetch --frozen-lockfile --config.confirm-modules-purge=false${store}`
  const install = `corepack pnpm install --frozen-lockfile --config.confirm-modules-purge=false`
    + store
  if (options.offlineOnly) return [
    `export npm_config_cache_dir=${shellQuote(join(cache, 'pnpm-metadata'))}`,
    `${fetch} --offline || finish $?`,
    `${install} --offline || finish $?`,
  ]
  return [
    `export npm_config_cache_dir=${shellQuote(join(cache, 'pnpm-metadata'))}`,
    // An installed checkout can outlive evicted store entries needed by deployment fixtures.
    // Check the full lockfile offline; only an online store refill needs the repository lock.
    `${fetch} --offline && ${install} --offline || {`,
    `mkdir -p ${shellQuote(join(cache, 'locks'))}`,
    `exec {cache_lock}>${shellQuote(join(cache, 'locks', 'install.lock'))}`,
    'flock --wait 600 "$cache_lock" || {',
    `  printf '%s\\n' ${shellQuote(JSON.stringify({ message:
      'CI_INSTALL_LOCK_DEADLINE_EXCEEDED: install lock unavailable after 600 seconds.' }))} > ${shellQuote(messageFile)}`,
    '  finish 124',
    '}',
    // Dependency snapshots from the previous per-run copy scheme are no longer read.
    `rm -rf ${shellQuote(join(cache, 'modules'))}`,
    // Recheck after waiting: another checkout may have filled the missing store entries.
    `${fetch} --offline && ${install} --offline || {`,
    // A warmed store can still miss metadata (pruned or partial cache); refill it online instead of failing the job.
    `  echo '[ci-cache] filling store online'`,
    `  ${fetch} --prefer-offline || finish $?`,
    `  ${install} --offline || finish $?`,
    '}',
    'flock -u "$cache_lock"',
    'exec {cache_lock}>&-',
    '}',
  ]
}
