import { join } from 'node:path'
import { shellQuote as quote } from './warmSetup.js'

/** All expensive work stays in the interruptible unit, outside the real CI admission queue. */
export function prewarmScript(root: string, request: { runId: string; repository: string; commit: string }) {
  const run = join(root, 'runs', request.runId)
  const clone = join(root, 'git', ...request.repository.split('/'))
  const cache = join(root, 'cache', ...request.repository.split('/'))
  const source = join(run, 'src')
  return ['#!/bin/bash', 'set -euo pipefail', `exec >>${quote(join(run, 'log'))} 2>&1`,
    `finish() { code=$?; echo "$code" > ${quote(join(run, 'exit.tmp'))};`
      + ` mv ${quote(join(run, 'exit.tmp'))} ${quote(join(run, 'exit'))}; }`,
    'trap finish EXIT',
    `step() { echo "$1" > ${quote(join(run, 'step'))}; echo "::step $1"; }`,
    `export TMPDIR=${quote(join(run, 'tmp'))} CI=true CI_HOST_RUNNER=1 FOREMAN_CODE_CI_DEDICATED=1`,
    'export NODE_OPTIONS=--max-old-space-size=1024 FOREMAN_CODE_CI_CPU_COUNT=1',
    `export FOREMAN_CODE_CI_CONTRACTS_CACHE=${quote(join(cache, 'contracts'))}`,
    'mkdir -p "$TMPDIR"', 'step fetch',
    `git() { command git -c credential.helper= -c 'credential.helper=!gh auth git-credential' "$@"; }`,
    'export GIT_TERMINAL_PROMPT=0',
    `if [ ! -d ${quote(join(clone, '.git'))} ]; then`,
    `  mkdir -p ${quote(join(clone, '..'))}`,
    `  git clone --quiet --filter=blob:none --no-checkout ${quote(`https://github.com/${request.repository}.git`)} ${quote(clone)}`,
    'fi',
    `git -C ${quote(clone)} cat-file -e ${quote(`${request.commit}^{commit}`)} 2>/dev/null`
      + ` || git -C ${quote(clone)} fetch --quiet --no-tags origin ${quote(request.commit)}`,
    `git -C ${quote(clone)} worktree add --quiet --detach ${quote(source)} ${quote(request.commit)}`,
    `cd ${quote(source)}`,
    'if [ ! -f pnpm-lock.yaml ] || [ ! -f scripts/ci-contracts.mjs ]; then',
    "  echo '[ci-prewarm] repository has no warm-up contract'; exit 0", 'fi',
    'key=$(node scripts/ci-contracts.mjs key "$PWD")',
    'inputs=$( { echo "$key"; for name in .npmrc pnpm-workspace.yaml; do',
    '  if [ -f "$name" ]; then sha256sum "$name"; fi; done; } | sha256sum | cut -d " " -f 1)',
    `if [ -f ${quote(join(cache, 'prewarm-inputs'))} ]`
      + ` && [ "$(cat ${quote(join(cache, 'prewarm-inputs'))})" = "$inputs" ]`
      + ' && [ -f "$FOREMAN_CODE_CI_CONTRACTS_CACHE/$key/.ci-cache-key" ]'
      + ` && [ -d ${quote(join(cache, 'pnpm-store'))} ]; then`,
    "  echo '[ci-prewarm] unchanged lockfile and contracts inputs'; exit 0", 'fi',
    `mkdir -p ${quote(join(cache, 'locks'))}`,
    `lock=$(node -e ${quote("const fs=require('node:fs'),c=require('node:crypto'); console.log(c.createHash('sha256').update(process.version).update(fs.readFileSync('pnpm-lock.yaml')).digest('hex'))")})`,
    `exec {cache_lock}>${quote(join(cache, 'locks'))}/"$lock.lock"`,
    // A cache holder may be real work from a previous Worker; a warm-up never waits for it.
    'flock -n "$cache_lock" || exit 0', 'step install',
    `corepack pnpm install --offline --frozen-lockfile --package-import-method=hardlink`
      + ` --store-dir ${quote(join(cache, 'pnpm-store'))} --cache-dir ${quote(join(cache, 'pnpm-metadata'))}`,
    'flock -u "$cache_lock"', 'exec {cache_lock}>&-', 'step contracts',
    'corepack pnpm --filter @foreman-code/contracts build',
    `echo "$inputs" > ${quote(join(run, 'inputs'))}`,
    `mv ${quote(join(run, 'inputs'))} ${quote(join(cache, 'prewarm-inputs'))}`,
    "echo '[ci-prewarm] commit ready'", ''].join('\n')
}
