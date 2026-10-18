import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { expect, it } from 'vitest'
import { IntegrationCoverageStore } from './coverageStore.js'

it('merges complete commit artifacts, keeps repositories separate and selects the newest ancestor', async () => {
  const cache = join(homedir(), '.cache/foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'coverage-store-'))
  try {
    const store = new IntegrationCoverageStore(root)
    const first = 'apps/api/test/first.integration.test.ts'
    const second = 'apps/api/test/second.integration.test.ts'
    const a = 'a'.repeat(40)
    const b = 'b'.repeat(40)
    const report = { version: 1 as const, commit: a, testFiles: [first, second], coverage: { [first]: ['apps/api/src/a.ts'] } }
    await store.record('example/project', a, report)
    const commits = { isAncestor: async (_repository: string, ancestor: string) => ancestor === a || ancestor === b,
      testTree: async (_repository: string, commit: string) => ({
        blobs: new Map([['apps/api/src/a.ts', commit === a ? 'old' : 'changed']]),
        read: async () => '',
      }) }
    expect(await store.selection('example/project', b, commits)).toEqual({ changedFiles: [],
      reason: 'No complete coverage map from an ancestor commit is available.' })
    await store.record('example/project', a, { ...report, coverage: { [second]: ['apps/api/src/b.ts'] } })
    const selected = await store.selection('example/project', b, commits)
    expect(JSON.parse(gunzipSync(Buffer.from(selected.map!, 'base64')).toString()).coverage)
      .toEqual({ [first]: ['apps/api/src/a.ts'], [second]: ['apps/api/src/b.ts'] })
    expect(selected?.changedFiles).toEqual(['apps/api/src/a.ts'])
    expect(await store.selection('example/other', b, commits)).toEqual({ changedFiles: [],
      reason: 'No integration coverage artifacts are available.' })
    await store.record('example/project', b, { ...report, commit: b,
      coverage: { [first]: ['apps/api/src/a.ts'], [second]: ['apps/api/src/b.ts'] } })
    const newest = await store.selection('example/project', 'c'.repeat(40), commits)
    expect(JSON.parse(gunzipSync(Buffer.from(newest.map!, 'base64')).toString()).commit).toBe(b)
    const stale = { ...commits, testTree: async (_repository: string, commit: string) => ({
      blobs: new Map([['pnpm-lock.yaml', commit]]), read: async () => '',
    }) }
    expect(await store.selection('example/project', 'c'.repeat(40), stale)).toEqual({ changedFiles: [],
      reason: 'Coverage map predates lockfile or CI infrastructure changes.' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
