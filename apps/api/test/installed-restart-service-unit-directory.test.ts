import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeRestartServiceUnit } from './helpers/installedRestartService.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { removeFixtureDirectory } from './helpers/testResources.js'

describe('installed restart service unit creation', () => {
  it('writes a private service unit when its parent directory does not exist', async () => {
    const directory = await privateFixtureDirectory('installed-restart-unit-')
    const unitPath = join(directory, 'config/systemd/user/restart-fixture.service')
    const service = '[Service]\nType=exec\nRestart=no\n'
    try {
      await expect(stat(dirname(unitPath))).rejects.toMatchObject({ code: 'ENOENT' })
      await writeRestartServiceUnit(unitPath, service)
      expect(await readFile(unitPath, 'utf8')).toBe(service)
      expect((await stat(unitPath)).mode & 0o777).toBe(0o600)
    } finally {
      await removeFixtureDirectory(directory)
    }
  })
})
