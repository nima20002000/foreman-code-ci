import { randomUUID } from 'node:crypto'
import { mkdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { OperatorLifecycleService } from './operatorLifecycle.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

const principal: ManagementPrincipal = { id: 'owner', name: 'Owner', audience: 'operator',
  grants: [{ actions: ['workspaces:restore'], scope: {} }], expiresAt: '2099-01-01T00:00:00Z', revokedAt: null }

async function restore(policy?: Record<string, unknown>) {
  const parent = join(homedir(), '.cache', 'foreman-tmp', `restore-${randomUUID()}`)
  roots.push(parent)
  await mkdir(parent, { recursive: true })
  const rootPath = join(parent, 'Project')
  const updates: { values: unknown[] }[] = []
  const client = { query: vi.fn(async (text: string, values: unknown[] = []) => {
    if (text.startsWith('select revision,archived_at')) {
      return { rows: [{ revision: '3', archived_at: new Date(), removed_project_folder: { runnerId: 'runner-local', rootPath } }] }
    }
    if (text.startsWith('select location_revision')) return { rows: [{ location_revision: '4' }] }
    if (text.includes('workspace_root_policy_heads')) return { rows: policy ? [{ record: { ...policy, canonicalProjectRoot: rootPath } }] : [] }
    if (text.startsWith('update')) updates.push({ values })
    return { rows: [] }
  }) } as unknown as pg.PoolClient
  const commands = { execute: async (input: { perform: (client: pg.PoolClient) => Promise<unknown> }) =>
    ({ value: await input.perform(client), replayed: false }) } as unknown as PostgresCommandCoordinator
  const rebind = vi.fn(async () => undefined)
  await new OperatorLifecycleService(commands, { runnerId: 'runner-local', rebind })
    .restoreWorkspace(principal, { workspaceId: 'workspace', expectedRevision: 3, commandId: 'restore-command' })
  return { rootPath, updates, rebind }
}

it('recreates the project folder that archiving removed and records it as app-created again', async () => {
  const { rootPath, updates, rebind } = await restore()
  expect((await stat(rootPath)).isDirectory()).toBe(true)
  const recorded = updates.map(update => update.values)
  expect(recorded).toContainEqual(['workspace', expect.stringContaining(JSON.stringify(rootPath))])
  expect(recorded).toContainEqual(['workspace', expect.stringContaining('"inode"'), rootPath])
  expect(rebind).not.toHaveBeenCalled()
})

it('binds a recreated approved-root folder again so Runs accept the new directory', async () => {
  const mainId = randomUUID()
  const filesystem = { device: '1', inode: '2', mountId: '3' }
  const { rebind } = await restore({ schemaVersion: 1, rootPolicyId: randomUUID(), rootPolicyRevision: '2', workspaceId: 'workspace',
    hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId, registration: null, locationRevision: '4',
    ownerPrincipalId: 'owner', allowedBaseId: randomUUID(), configurationRevision: '1', relativePath: 'Project',
    accessMode: 'read-write', filesystem, directoryIdentityHash: 'a'.repeat(64), managedRuntimeRoot: '/runtime',
    runtimeFilesystem: filesystem, attestationId: randomUUID(), attestationDigest: 'b'.repeat(64) })
  expect(rebind).toHaveBeenCalledWith(principal, expect.objectContaining({ workspaceId: 'workspace', relativePath: 'Project',
    expectedLocationRevision: 4, expectedRootPolicyRevision: 2, commandId: 'restore-command:folder' }))
})
