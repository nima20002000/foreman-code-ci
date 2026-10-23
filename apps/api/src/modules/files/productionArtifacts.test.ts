import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import type { ApiConfig } from '../../config.js'
import type { TemporaryFileService } from './service.js'
import type { ArtifactPublicationAuthority, VerifiedArtifactReader } from './distributed/publication.js'
import type { AcceptedArtifactAttemptFence } from './distributed/authorization.js'
vi.mock('./tools/production.js', () => ({ createProductionFileTools: vi.fn() }))
vi.mock('./distributed/publication.js')
vi.mock('./distributed/nativeResults.js')
vi.mock('./distributed/edges.js')
vi.mock('../runs/remote/nativeArtifactOutputs.js')
import { DistributedArtifactPublicationService } from './distributed/publication.js'
import { CanonicalNativeArtifactResults } from './distributed/nativeResults.js'
import { ArtifactEdgeService } from './distributed/edges.js'
import { NativeArtifactOutputs } from '../runs/remote/nativeArtifactOutputs.js'
import { createProductionFileStorage, createProductionDistributedArtifacts } from './production.js'
function ports() {
  // No hooks, database calls or native process are run by this composition test.
  const pool = {} as pg.Pool
  return { pool, mainId: randomUUID(), authority: {} as ArtifactPublicationAuthority,
    attempts: {} as AcceptedArtifactAttemptFence, transfers: {} as VerifiedArtifactReader }
}
it('requires the original registered production store', () => {
  expect(() => createProductionDistributedArtifacts({ ...ports(), files: {} as TemporaryFileService }))
    .toThrow('The original production file store is required.')
})
it('shares the original repository, bytes, authority and publication ledger with output and edge services', () => {
  const input = ports(), app = { decorate: vi.fn(), addHook: vi.fn(), log: { warn: vi.fn() } } as unknown as FastifyInstance
  const config = { fileStorageRoot: '/original/files', workspaceStorageRoot: '/original/projects',
    harnesses: { workspaceRoot: '/original/runtime' } } as ApiConfig
  const { service: files } = createProductionFileStorage(app, input.pool, config)
  const mounted = createProductionDistributedArtifacts({ ...input, files })
  const ledger = vi.mocked(DistributedArtifactPublicationService).mock.calls[0]![1]
  expect(DistributedArtifactPublicationService).toHaveBeenCalledExactlyOnceWith(files, ledger,
    input.transfers, input.authority)
  expect(CanonicalNativeArtifactResults).toHaveBeenCalledExactlyOnceWith(files, ledger, input.authority)
  expect(ArtifactEdgeService).toHaveBeenCalledExactlyOnceWith(expect.anything(), files.repository, files.bytes,
    expect.anything())
  expect(NativeArtifactOutputs).toHaveBeenCalledExactlyOnceWith(mounted.results, expect.anything(),
    input.authority, mounted.edges)
  expect(app.addHook).toHaveBeenCalledTimes(2)
})
