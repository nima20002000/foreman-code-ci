export * from '../packages/verification-runner/src/verification-reports.mjs'
export { default } from '../packages/verification-runner/src/verification-reports.mjs'
import { runVerificationCommand } from '../packages/verification-runner/src/verification-reports.mjs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

if (process.argv[2] === '__command' && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [, , , root, cwd, script, ...command] = process.argv
  runVerificationCommand(command, { root, cwd, script, env: process.env })
    .then((code) => { process.exitCode = code })
    .catch((error) => { console.error(`[verification] ${error.message}`); process.exitCode = 1 })
}
