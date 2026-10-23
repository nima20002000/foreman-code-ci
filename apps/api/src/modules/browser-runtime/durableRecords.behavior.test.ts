import { chmod, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { privateFixtureDirectory, withPrivateFixtureDirectories } from '../../../test/helpers/privateFixtureDirectory.js'
import { atomicBrowserPrivateJson } from './journal.js'
import { readBrowserProcessIdentity, writeBrowserProcessIdentity, type BrowserProcessIdentity } from './processIdentity.js'
import { checkpointBrowserRuntimeProfiles, restoreBrowserRuntimeProfiles } from './profileCheckpoint.js'

it('replaces private journal records and rejects public or linked directories', async () => {
  await withPrivateFixtureDirectories(async () => {
    const root = await privateFixtureDirectory('browser-journal-'), directory = join(root, 'records')
    await atomicBrowserPrivateJson(directory, 'record.json', { sequence: 1 })
    await atomicBrowserPrivateJson(directory, 'record.json', { sequence: 2 })
    expect(await readFile(join(directory, 'record.json'), 'utf8')).toBe('{"sequence":2}')
    expect((await stat(join(directory, 'record.json'))).mode & 0o777).toBe(0o600)
    expect(await readdir(directory)).toEqual(['record.json'])
    const linked = join(root, 'linked'); await symlink(directory, linked)
    await expect(atomicBrowserPrivateJson(linked, 'record.json', {})).rejects.toThrow('Browser journal directory is not private')
    await chmod(directory, 0o755)
    await expect(atomicBrowserPrivateJson(directory, 'record.json', {})).rejects.toThrow('Browser journal directory is not private')
    expect(await readFile(join(directory, 'record.json'), 'utf8')).toBe('{"sequence":2}')
    await chmod(directory, 0o700)
  })
})

it('retains process identity bytes and permissions without creating missing generation directories', async () => {
  await withPrivateFixtureDirectories(async () => {
    const root = await privateFixtureDirectory('browser-process-record-'), directory = join(root, 'generation-1')
    const identity: BrowserProcessIdentity = { pid: process.pid, generation: 1,
      token: '11111111-1111-4111-8111-111111111111', executable: '/fixture/browser', directory,
      headless: true, endpoint: null, birthId: null }
    await expect(writeBrowserProcessIdentity(identity)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(root)).toEqual([])
    await mkdir(directory, { mode: 0o700 })
    await writeBrowserProcessIdentity(identity)
    expect(await readBrowserProcessIdentity(directory)).toEqual(identity)
    const path = join(directory, 'foreman-process.json')
    expect(await readFile(path, 'utf8')).toBe(JSON.stringify(identity))
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect(await readdir(directory)).toEqual(['foreman-process.json'])
  })
})

it('restores the exact saved profile record after checkpointing a stopped generation', async () => {
  await withPrivateFixtureDirectories(async () => {
    const root = await privateFixtureDirectory('browser-profile-checkpoint-')
    const profile = join(root, 'profiles', 'a'.repeat(64)), generation = join(profile, 'generation-1')
    await mkdir(generation, { recursive: true, mode: 0o700 })
    const before = { profileId: 'profile', generation: 1, revision: 3, deleted: false, origins: ['https://fixture.test'] }
    await writeFile(join(profile, 'profile.json'), JSON.stringify(before), { mode: 0o600 })
    await writeFile(join(generation, 'state'), 'private browser state', { mode: 0o600 })
    const closed: string[] = []
    const checkpoint = await checkpointBrowserRuntimeProfiles(root, async id => { closed.push(id) })
    expect(closed).toEqual(['profile'])
    expect(JSON.parse(await readFile(join(profile, 'profile.json'), 'utf8'))).toEqual({
      ...before, generation: 2, runtimeCheckpointId: checkpoint.profileCheckpointId,
    })
    expect(await readFile(join(profile, 'generation-2', 'state'), 'utf8')).toBe('private browser state')
    await restoreBrowserRuntimeProfiles({ profileStateRoot: root, checkpointId: checkpoint.profileCheckpointId })
    expect(await readFile(join(profile, 'profile.json'), 'utf8')).toBe(JSON.stringify(before))
    expect(JSON.parse(await readFile(join(root, 'checkpoints', `${checkpoint.profileCheckpointId}.json`), 'utf8')))
      .toMatchObject({ state: 'restored', rows: [{ before }] })
  })
})
