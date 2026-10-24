import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)

it.each(['server-kit', 'installed-runtime-node', 'local-client-node', 'device-identity-node',
  'device-setup-node', 'device-tls-node'])('loads the built %s entry in native Node ESM', async subpath => {
  const result = await execute(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    const module = await import('@foreman-code/contracts-node/${subpath}');
    assert.ok(Object.keys(module).length > 0);
  `], { cwd: new URL('..', import.meta.url) })
  expect(result.stderr).toBe('')
})
