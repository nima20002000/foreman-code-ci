import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { RunExecutionLocation } from '@foreman-code/contracts'
import { PostgresSourceService } from '../src/modules/sources/service.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { approvedGitTreePaths, captureGitSource } from '../src/modules/sources/capture.js'
import { createSourceManifest } from '../src/modules/sources/manifest.js'
import { DomainError } from '../src/modules/errors.js'
import { sourceStorageCapacityFixture } from './helpers/sourceStorageCapacityFixture.js'

vi.mock('../src/modules/sources/capture.js', () => ({
  approvedGitTreePaths: vi.fn(), captureGitSource: vi.fn(), qualifiedGit: vi.fn(),
}))
afterEach(() => vi.restoreAllMocks())

function fixture(repository = false) {
  const mainId = randomUUID()
  const input = { workspaceId: 'workspace', commandId: randomUUID(), expectedLocationRevision: 1,
    commit: 'a'.repeat(40), executablePolicy: 'strip' as const }
  const principal: ManagementPrincipal = { id: 'actor', name: 'Actor', audience: 'operator',
    grants: [{ actions: ['source_roots:bind', 'sources:read', 'workspace_locations:read'], scope: {} }],
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null }
  const location: RunExecutionLocation = { runnerId: 'runner-local', rootPath: '/fixture/project',
    locationRevision: 1, identityHash: `sha256:${'b'.repeat(64)}` }
  const state = { connections: 0, transactions: 0, ownerId: principal.id, approvals: 0, snapshot: undefined as unknown,
    repository: repository ? { provider: 'github', owner: 'fixture', name: 'project', defaultBranch: 'main' } : undefined }
  // Reads are told apart by their bound values. The principal id alone is bound twice per source authorization, first by
  // the live authority read and then by the root-owner read. The workspace id alone is a workspace read, no value is the
  // Main installation read, and four values read a snapshot (the write of a snapshot binds five, the last being its JSON record, and an approval nine).
  let principalReads = 0
  const query = async (sql: string, values: unknown[] = []) => {
    if (sql.startsWith('begin')) state.transactions++
    if (sql === 'commit' || sql === 'rollback') state.transactions--
    if (values.length === 1 && values[0] === principal.id) {
      return ++principalReads % 2 === 0 ? { rows: [{ id: state.ownerId }] } : { rows: [{
        id: principal.id, name: principal.name, audience: principal.audience, grants: principal.grants,
        expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null,
      }] }
    }
    if (values.length === 0) return { rows: [{ id: mainId }] }
    if (values.length === 1 && values[0] === input.workspaceId) return { rows: [{ archived_at: null,
      location_revision: String(location.locationRevision), record: { id: input.workspaceId, name: 'Project',
        ...(state.repository ? { repository: state.repository } : {}) } }] }
    if (values.length === 9) state.approvals++
    if (values.length === 5 && String(values[4]).startsWith('{')) state.snapshot = JSON.parse(String(values[4]))
    if (values.length === 4) {
      return { rows: [{ record: state.snapshot, availability: 'retained' }] }
    }
    return { rows: [], rowCount: 0 }
  }
  const pool = { connect: async () => {
    state.connections++
    return { query, release: () => { state.connections-- } }
  } } as unknown as pg.Pool
  const commands = new PostgresCommandCoordinator(pool)
  vi.spyOn(commands, 'execute').mockImplementation(async request => ({
    value: await request.perform({ query } as unknown as pg.PoolClient), replayed: false,
  }))
  const locations = { snapshotAssigned: async (_sql: unknown, _workspace: string, revision: number) => {
    if (revision !== location.locationRevision) throw new DomainError('LOCATION_REVISION_CONFLICT', 'Location changed.', 409)
    return { ...location }
  }, revalidateSnapshot: vi.fn(async () => undefined) }
  const store = { storageIdentity: async () => ({ device: 'fixture', inode: 'fixture', mountId: 'fixture' }),
    storageCapacity: async () => {
      expect(state.transactions).toBe(0)
      expect(state.connections).toBe(0)
      return sourceStorageCapacityFixture({ filesystem: await store.storageIdentity() })
    },
    withCaptureLock: async (_id: string, work: () => Promise<unknown>) => work(),
    manifest: async () => null, retainedCaptureBytes: async () => 0 }
  type Dependencies = ConstructorParameters<typeof PostgresSourceService>
  const service = new PostgresSourceService(pool, commands, locations as unknown as Dependencies[2],
    store as unknown as Dependencies[3], mainId, {} as Dependencies[5], {} as Dependencies[6], {} as Dependencies[7])
  vi.spyOn(service, 'reconcileCaptures').mockResolvedValue(undefined)
  vi.spyOn(service.reservations, 'reserve').mockImplementation(async (_sql, request) => ({
    ...request, reservationId: randomUUID(),
  }))
  vi.spyOn(service.reservations, 'retain').mockResolvedValue(undefined)
  vi.mocked(captureGitSource).mockImplementation(async request => createSourceManifest({
    version: 1, approvedSourceId: request.approvedSourceId, snapshotId: request.snapshotId!,
    capturePolicy: 'git-tree-v1', executablePolicy: request.executablePolicy,
    git: { commit: input.commit, tree: 'c'.repeat(40), objectFormat: 'sha1',
      ...(request.repository ? { repository: request.repository } : {}) }, entries: [], deletions: [],
  }))
  const approve = () => service.approve(principal, 'mcp', input,
    repository ? { repository: 'fixture/project', clone: location.rootPath } : undefined)
  return { state, location, service, principal, input, approve }
}

it.each([false, true])('inventories a pinned commit without retaining a database connection (repository=%s)', async repository => {
  const f = fixture(repository)
  vi.mocked(approvedGitTreePaths).mockImplementation(async () => {
    expect(f.state.transactions).toBe(0)
    expect(f.state.connections).toBe(0)
    return []
  })
  const result = await f.approve()
  expect(result.value.manifest.git?.commit).toBe(f.input.commit)
  const { approvedSourceId, snapshotId, manifestDigest } = result.value.manifest
  expect((await f.service.get(f.principal, 'mcp', { workspaceId: f.input.workspaceId,
    approvedSourceId, snapshotId, manifestDigest })).manifest).toEqual(result.value.manifest)
  expect(f.state.approvals).toBe(1)
})

it('rejects a location change during Git inventory before recording approval', async () => {
  const f = fixture()
  vi.mocked(approvedGitTreePaths).mockImplementation(async () => {
    f.location.locationRevision++
    return []
  })
  await expect(f.approve()).rejects.toMatchObject({ code: 'LOCATION_REVISION_CONFLICT' })
  expect(f.state.approvals).toBe(0)
})

it.each([false, true])('captures source bytes without retaining a database connection (repository=%s)', async repository => {
  const f = fixture(repository)
  const capture = vi.mocked(captureGitSource).getMockImplementation()!
  vi.mocked(approvedGitTreePaths).mockResolvedValue([])
  vi.mocked(captureGitSource).mockImplementationOnce(async request => {
    expect(f.state.transactions).toBe(0)
    expect(f.state.connections).toBe(0)
    return capture(request)
  })
  const result = await f.approve()
  expect(result.value.manifest.git?.commit).toBe(f.input.commit)
  expect(f.state.approvals).toBe(1)
  expect(f.state.connections).toBe(0)
  expect(f.state.transactions).toBe(0)
})

it('rejects a repository change during Git inventory before recording approval', async () => {
  const f = fixture(true)
  vi.mocked(approvedGitTreePaths).mockImplementation(async () => {
    f.state.repository!.name = 'other-project'
    return []
  })
  await expect(f.approve()).rejects.toMatchObject({ code: 'SOURCE_REPOSITORY_CHANGED' })
  expect(f.state.approvals).toBe(0)
})

it('rejects a replaced directory identity during Git inventory before recording approval', async () => {
  const f = fixture()
  vi.mocked(approvedGitTreePaths).mockImplementation(async () => {
    f.location.identityHash = `sha256:${'d'.repeat(64)}`
    return []
  })
  await expect(f.approve()).rejects.toMatchObject({ code: 'SOURCE_APPROVAL_CONFLICT' })
  expect(f.state.approvals).toBe(0)
})

it('rejects an ownership change during Git inventory before recording approval', async () => {
  const f = fixture()
  vi.mocked(approvedGitTreePaths).mockImplementation(async () => {
    f.state.ownerId = 'other-owner'
    return []
  })
  await expect(f.approve()).rejects.toMatchObject({ code: 'SOURCE_APPROVAL_CONFLICT' })
  expect(f.state.approvals).toBe(0)
})
