import { join } from 'node:path'
import { checkoutCommands, slotSource } from './slotCheckout.js'
import { shellQuote as quote, warmPnpmInstall } from './warmSetup.js'

/** Fetch and install stay in the interruptible unit, outside the real CI admission queue. */
export function prewarmScript(root: string, request: {
  runId: string; repository: string; commit: string; slots: number[]
}) {
  const run = join(root, 'runs', request.runId)
  const cache = join(root, 'cache', ...request.repository.split('/'))
  return ['#!/bin/bash', 'set -o pipefail', `exec >>${quote(join(run, 'log'))} 2>&1`,
    `finish() { local code="$1"; echo "$code" > ${quote(join(run, 'exit.tmp'))};`
      + ` mv ${quote(join(run, 'exit.tmp'))} ${quote(join(run, 'exit'))}; exit "$code"; }`,
    `step() { echo "$1" > ${quote(join(run, 'step'))}; echo "::step $1"; }`,
    `export TMPDIR=${quote(join(run, 'tmp'))} CI=true GIT_TERMINAL_PROMPT=0`,
    'export NODE_OPTIONS=--max-old-space-size=1024',
    'mkdir -p "$TMPDIR" || finish $?',
    `git() { command git -c credential.helper= -c 'credential.helper=!gh auth git-credential' "$@"; }`,
    ...request.slots.flatMap(slotIndex => {
      const source = slotSource(root, slotIndex)
      return [
        `mkdir -p ${quote(source)} || finish $?`,
        `cd ${quote(source)} || finish $?`,
        'step fetch',
        'if [ ! -d .git ]; then',
        '  git init --quiet || finish $?',
        `  git remote add origin ${quote(`https://github.com/${request.repository}.git`)} || finish $?`,
        'else',
        `  git remote set-url origin ${quote(`https://github.com/${request.repository}.git`)} || finish $?`,
        'fi',
        `git cat-file -e ${quote(`${request.commit}^{commit}`)} 2>/dev/null`
          + ` || git fetch --quiet --no-tags origin ${quote(request.commit)} || finish $?`,
        ...checkoutCommands(request.commit).map(args => `git ${args.map(quote).join(' ')} || finish $?`),
        'if [ -f pnpm-lock.yaml ]; then',
        '  step install',
        ...warmPnpmInstall(source, cache, run),
        'fi',
      ]
    }),
    "echo '[ci-prewarm] idle slots ready'", 'finish 0', ''].join('\n')
}
