import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { LocalProviderCredentials } from './localCredentials.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

it('recovers the host identity after a repairable failure instead of caching the rejection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'credentials-')); roots.push(root)
  await chmod(root, 0o755)
  const credentials = new LocalProviderCredentials(root)
  await expect(credentials.hostId()).rejects.toMatchObject({ code: 'ACCOUNT_HOME_UNSAFE' })
  await chmod(root, 0o700)
  expect(await credentials.hostId()).toMatch(/^[0-9a-f-]{36}$/)
})
