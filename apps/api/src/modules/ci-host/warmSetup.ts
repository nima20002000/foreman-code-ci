import { dirname, join } from 'node:path'

export const shellQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`

const dependencyInputs = [
  "const { execFileSync } = require('node:child_process')",
  "const { createHash } = require('node:crypto')",
  "const { existsSync, readFileSync } = require('node:fs')",
  'const hash = createHash("sha256").update(process.version).update(process.platform).update(process.arch)',
  'const manifests = execFileSync("git", ["ls-files", "-z", "--", "**/package.json"]).toString()',
  '  .split("\\0").filter(Boolean).sort()',
  'for (const name of ["pnpm-lock.yaml", "pnpm-workspace.yaml", ".npmrc", "package.json", ".pnpmfile.cjs", ...manifests]) {',
  '  hash.update(name)',
  '  hash.update(existsSync(name) ? readFileSync(name) : "missing")',
  '}',
  'console.log(hash.digest("hex"))',
].join('\n')

/** The stamp lives outside the source tree so cleaning a slot preserves its installed dependencies. */
export function warmPnpmInstall(source: string, cache: string, run: string): string[] {
  const stamp = join(dirname(source), 'install-inputs')
  const temporary = join(run, 'install-inputs')
  const install = `corepack pnpm install --frozen-lockfile --store-dir ${shellQuote(join(cache, 'pnpm-store'))}`
    + ` --cache-dir ${shellQuote(join(cache, 'pnpm-metadata'))}`
    + ' --package-import-method=clone-or-copy'
  return [
    `inputs=$(node -e ${shellQuote(dependencyInputs)}) || finish $?`,
    `if [ -d node_modules ] && [ -f ${shellQuote(stamp)} ]`
      + ` && [ "$(cat ${shellQuote(stamp)})" = "$inputs" ]; then`,
    "  echo '[ci-cache] dependency inputs unchanged; install skipped'",
    'else',
    `  rm -f ${shellQuote(stamp)} || finish $?`,
    `  mkdir -p ${shellQuote(join(cache, 'locks'))} || finish $?`,
    `  exec {cache_lock}>${shellQuote(join(cache, 'locks', 'install.lock'))}`,
    '  flock "$cache_lock" || finish $?',
    `  ${install} --offline || {`,
    "    echo '[ci-cache] filling store online'",
    `    ${install} || finish $?`,
    '  }',
    `  printf '%s' "$inputs" > ${shellQuote(temporary)} || finish $?`,
    `  mv ${shellQuote(temporary)} ${shellQuote(stamp)} || finish $?`,
    '  flock -u "$cache_lock"',
    '  exec {cache_lock}>&-',
    'fi',
  ]
}
