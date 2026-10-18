import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createTestRoot, removeTestRoot, testAdminUrl, testEnvironment } from './test-resources.mjs'

for (const variable of ['PNPM_CONFIG_CACHE_DIR', 'npm_config_cache_dir', null]) {
  test(`preserves the pnpm publication metadata location across isolated test homes (${variable ?? 'XDG cache'})`, t => {
    const base = join(homedir(), '.cache', 'foreman-tmp')
    mkdirSync(base, { recursive: true })
    const root = createTestRoot(base, 'package-cache-environment-')
    t.after(() => removeTestRoot(root))
    const resource = { ...root, databaseUrl: testAdminUrl }
    const originalCache = join(root.directory, 'prefetched-metadata')
    const environment = { XDG_CACHE_HOME: join(root.directory, 'original-cache') }
    if (variable) environment[variable] = originalCache
    const expected = variable ? originalCache : join(environment.XDG_CACHE_HOME, 'pnpm')
    const isolated = testEnvironment(environment, resource)
    assert.equal(isolated.FOREMAN_CODE_TEST_PNPM_CACHE_DIR, expected)
    assert.equal(isolated.HOME, join(root.directory, 'home'))
    assert.equal(isolated.XDG_CACHE_HOME, join(root.directory, 'home/.cache'))
    assert.equal(testEnvironment(isolated, resource).FOREMAN_CODE_TEST_PNPM_CACHE_DIR, expected)
  })
}
