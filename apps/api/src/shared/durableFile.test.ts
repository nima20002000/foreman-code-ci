import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { privateFixtureDirectory, withPrivateFixtureDirectories } from '../../test/helpers/privateFixtureDirectory.js'
import { readBoundedText, readBoundedTextIfPresent, writeDurableFile } from './durableFile.js'

const limit = { maxBytes: 16, message: 'Record byte limit reached' }

it('replaces a record whole, creates missing parents privately and leaves no temporary file', async () => {
  await withPrivateFixtureDirectories(async () => {
    const root = await privateFixtureDirectory('durable-file-')
    const path = join(root, 'nested', 'record.json')
    await writeDurableFile(path, '{"v":1}')
    await writeDurableFile(path, new TextEncoder().encode('{"v":2}'))

    expect(await readFile(path, 'utf8')).toBe('{"v":2}')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(root, 'nested'))).mode & 0o777).toBe(0o700)
    expect(await readdir(join(root, 'nested'))).toEqual(['record.json'])
  })
})

it('leaves no temporary file when the record cannot be put in place', async () => {
  await withPrivateFixtureDirectories(async () => {
    const root = await privateFixtureDirectory('durable-file-fail-')
    const path = join(root, 'record')
    await mkdir(path)
    await writeFile(join(path, 'occupant'), 'x')

    await expect(writeDurableFile(path, 'new')).rejects.toMatchObject({ code: expect.stringMatching(/^(EISDIR|ENOTEMPTY|EEXIST)$/) })

    expect(await readdir(root)).toEqual(['record'])
    expect(await readFile(join(path, 'occupant'), 'utf8')).toBe('x')
  })
})

it('reads records within their byte limit and reports a missing file only when asked to', async () => {
  await withPrivateFixtureDirectories(async () => {
    const root = await privateFixtureDirectory('durable-file-read-')
    const path = join(root, 'record.json')
    await writeFile(path, 'x'.repeat(16))
    expect(await readBoundedText(path, limit)).toBe('x'.repeat(16))

    await writeFile(path, 'x'.repeat(17))
    await expect(readBoundedText(path, limit)).rejects.toThrow('Record byte limit reached')
    await expect(readBoundedTextIfPresent(path, limit)).rejects.toThrow('Record byte limit reached')

    const missing = join(root, 'missing.json')
    await expect(readBoundedText(missing, limit)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readBoundedTextIfPresent(missing, limit)).toBeUndefined()
  })
})
