import assert from 'node:assert/strict'
import { copyFile, cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

test('production installer Worker modules load in a checkout without built contracts', async t => {
  const cache = join(homedir(), '.cache/foreman-tmp')
  await mkdir(cache, { recursive: true })
  const checkout = await mkdtemp(join(cache, 'production-worker-imports-'))
  t.after(() => rm(checkout, { recursive: true, force: true }))
  for (const path of ['apps/worker/src', 'packages/contracts/src']) {
    await cp(new URL(`../${path}`, import.meta.url), join(checkout, path), { recursive: true })
  }
  await copyFile(new URL('../packages/contracts/package.json', import.meta.url), join(checkout, 'packages/contracts/package.json'))
  const scope = join(checkout, 'apps/worker/node_modules/@foreman-code')
  await mkdir(scope, { recursive: true })
  await symlink(join(checkout, 'packages/contracts'), join(scope, 'contracts'))

  const installation = await import(pathToFileURL(join(checkout, 'apps/worker/src/installation.mjs')).href)
  const browser = await import(pathToFileURL(join(checkout, 'apps/worker/src/browserRuntime.mjs')).href)
  assert.equal(typeof installation.validateManifest, 'function')
  assert.equal(typeof installation.readInstalledRelease, 'function')
  assert.equal(typeof browser.createWorkerBrowserRuntime, 'function')
})
