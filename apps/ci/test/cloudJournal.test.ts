import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readCloudRun, saveCloudRun } from '../src/cloudJournal.js'
import type { CloudRun } from '../src/cloudProviders.js'

const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })

async function fixture() {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const directory = await mkdtemp(join(parent, 'cloud-journal-')); directories.push(directory)
  const path = join(directory, 'runs', 'run', 'meta.json')
  const run: CloudRun = { runId: 'run', repository: 'fixture/project', mirror: 'fixture/ci', commit: 'a'.repeat(40),
    suite: 'unit', startedAt: '2026-10-23T00:00:00.000Z', providerRunId: '42', state: 'running',
    finishedAt: null, exitCode: null, message: null, dispatch: { attempts: 2, at: '2026-10-23T00:00:00.000Z', uncertain: true } }
  return { directory, path, run }
}

it('reopens cloud ownership with identical bytes and private permissions after replacement', async () => {
  const { path, run } = await fixture()
  expect(await saveCloudRun(path, run)).toBe(run)
  const completed: CloudRun = { ...run, state: 'passed', exitCode: 0, finishedAt: '2026-10-23T00:01:00.000Z' }
  expect(await saveCloudRun(path, completed)).toBe(completed)
  expect(await readCloudRun(path)).toEqual(completed)
  expect(await readFile(path, 'utf8')).toBe(JSON.stringify(completed))
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  expect((await stat(join(path, '..'))).mode & 0o777).toBe(0o700)
  expect(await readdir(join(path, '..'))).toEqual(['meta.json'])
})

it('preserves missing and corrupt ownership errors and leaves no pending file after a failed replacement', async () => {
  const { directory, path, run } = await fixture()
  await expect(readCloudRun(path)).rejects.toMatchObject({ code: 'CI_RUN_UNKNOWN', status: 404 })
  await saveCloudRun(path, run)
  await writeFile(path, '{broken')
  await expect(readCloudRun(path)).rejects.toMatchObject({ code: 'CI_RUN_CORRUPT', status: 409 })
  const blocked = join(directory, 'blocked'); await mkdir(blocked); await writeFile(join(blocked, 'keep'), 'old')
  await expect(saveCloudRun(blocked, run)).rejects.toMatchObject({ code: expect.stringMatching(/^(EISDIR|ENOTEMPTY|EEXIST)$/) })
  expect((await readdir(directory)).sort()).toEqual(['blocked', 'runs'])
  expect(await readFile(join(blocked, 'keep'), 'utf8')).toBe('old')
})
