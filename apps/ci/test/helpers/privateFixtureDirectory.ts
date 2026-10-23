import { mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { ownedTestDatabaseUrl } from './testResources.js'

/** A private directory below the invocation's owned test root, which test resources remove with the invocation. */
export async function privateFixtureDirectory(prefix: string): Promise<string> {
  ownedTestDatabaseUrl()
  const parent = join(process.env.FOREMAN_CODE_TEST_ROOT!, 'private-fixtures')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  return mkdtemp(join(parent, prefix))
}
