import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { copyRestartDependencyDirectory } from './helpers/installedRestartArtifact.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { removeFixtureDirectory } from './helpers/testResources.js'

describe('installed restart dependency snapshot', () => {
  it('copies dependencies into their cache directory without including cached files', async () => {
    const directory = await privateFixtureDirectory('installed-restart-dependencies-')
    const source = join(directory, 'node_modules')
    const destination = join(source, '.cache/fixtures/release/node_modules')
    const payload = '{"name":"fixture-dependency","version":"1.0.0"}\n'
    try {
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      await writeFile(join(source, 'dependency.json'), payload, { mode: 0o600 })
      await writeFile(join(source, '.cache/ignored.json'), 'cached bytes', { mode: 0o600 })
      await copyRestartDependencyDirectory(source, destination)
      expect(await readFile(join(destination, 'dependency.json'), 'utf8')).toBe(payload)
      await expect(stat(join(destination, '.cache'))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(join(source, '.cache/ignored.json'), 'utf8')).toBe('cached bytes')
    } finally {
      await removeFixtureDirectory(directory)
    }
  })
})
