import { randomUUID } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { ManagedWorkspaceCommandResultSchema } from '@foreman-code/contracts/management'
import { HarnessDirectoryBrowser } from '../src/modules/harnesses/directoryBrowser.js'
import { agentChatKey, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { OperatorAgentMutationService } from '../src/modules/workspaces/operatorAgents.js'
import { WorkspaceStorageFolders } from '../src/modules/workspaces/storageFolders.js'
import { workspaceMcpFixture, callWorkspaceTool } from './helpers/workspaceMcp.js'
import { workspaceRepositoryFixture } from './helpers/workspaceRepository.js'
import { workspace, add, get } from './helpers/workspaceRepositoryOnboarding.js'
import { deferred } from './helpers/deferred.js'
import { observe, lockWaiter, qualifyConfiguration } from './helpers/concurrentMutations.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { workspaceStorageFoldersHttp } from './support/workspaceStorageFoldersHttp.js'

it.each([
  { delivery: 'queued', tool: 'workspace_archive' }, { delivery: 'accepted', tool: 'workspace_archive' },
  { delivery: 'queued', tool: 'workspace_batch_archive' }, { delivery: 'accepted', tool: 'workspace_batch_archive' },
] as const)('retains an owned directory with $delivery chat work through $tool', async ({ delivery, tool }) => {
  const f = await workspaceMcpFixture()
  try {
    const created = (await callWorkspaceTool(f.owner.client, 'workspace_create', ManagedWorkspaceCommandResultSchema,
      { name: 'Chat project', parentPath: f.parentPath, commandId: randomUUID() })).value
    const mutations = new OperatorAgentMutationService(f.pool, f.commands, { qualifyConfiguration })
    const agent = (await mutations.create(f.owner.principal, { workspaceId: created.workspace.id,
      agentId: randomUUID(), name: 'Chat Agent', productRole: 'coder', commandId: randomUUID() })).value.agent
    const context = { workspaceId: created.workspace.id, workflowId: randomUUID(),
      workflowNodeId: randomUUID(), agentId: agent.id }
    const repository = new PostgresAgentChatRepository(f.pool)
    const requestId = randomUUID()
    const admitted = await repository.admit({ key: agentChatKey(context), context, delivery: 'queued',
      request: { requestId, content: 'Keep working', intent: 'next_turn', expectedConversationId: null,
        context: { workflowId: context.workflowId, workflowNodeId: context.workflowNodeId, agentId: agent.id } },
      create: { context, harness: 'codex', agentConfigurationVersionId: agent.configurationVersionId!,
        origin: { kind: 'fresh' }, workingDirectory: created.executionLocation!.rootPath, runtimeDirectory: f.parentPath } })
    if (delivery === 'accepted') {
      expect(await repository.claim(admitted.conversationId, requestId)).toBe(true)
      await repository.bindSession(admitted.conversationId, 'fixture', 'session')
      expect(await repository.accepted(admitted.conversationId, requestId, 'native-turn')).toBe(true)
    }
    const selected = { workspaceId: created.workspace.id, expectedRevision: created.revision }
    const input = { commandId: randomUUID(), ...(tool === 'workspace_archive' ? selected : { workspaces: [selected] }) }
    const reader = await f.issue([{ actions: ['workspaces:read'], scope: {} }])
    await expectMcpAccessDenied(reader.client.callTool({ name: tool, arguments: input }))
    const result = await f.owner.client.callTool({ name: tool, arguments: input })
    expect(result.isError).toBe(true)
    expect((await lstat(created.executionLocation!.rootPath)).isDirectory()).toBe(true)
    expect(decodeMcpToolResult(await f.owner.client.callTool({ name: 'workspace_get',
      arguments: { workspaceId: created.workspace.id } }))).toMatchObject({ archivedAt: null })
    await repository.cancelQueued(admitted.conversationId, requestId)
    if (delivery === 'accepted') await repository.finish(admitted.conversationId, requestId, { outcome: 'succeeded' })
    const removed = await f.owner.client.callTool({ name: tool, arguments: input })
    expect(removed.isError).not.toBe(true)
    await expect(lstat(created.executionLocation!.rootPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(repository.admit({ key: agentChatKey(context), context, delivery: 'queued',
      request: { requestId: randomUUID(), content: 'Too late', intent: 'next_turn',
        expectedConversationId: admitted.conversationId,
        context: { workflowId: context.workflowId, workflowNodeId: context.workflowNodeId, agentId: agent.id } } }))
      .rejects.toMatchObject({ code: 'WORKSPACE_ARCHIVED' })
  } finally { await f.close() }
})

it.each(['rename', 'delete', 'undo'] as const)('serializes folder %s with an attested location save', async operation => {
  const f = await workspaceRepositoryFixture()
  const release = deferred()
  let saving: ReturnType<typeof f.owner.client.callTool> | undefined
  let mutating: Promise<{ value: unknown } | { error: unknown }> | undefined
  try {
    const input = await workspace(f)
    const browser = new HarnessDirectoryBrowser([f.storage], f.pool)
    Object.assign(f.services, { harnessSettings: { directories: browser } })
    const creationCommandId = randomUUID()
    const folder = (await browser.create(f.owner.principal, 'mcp', {
      parentPath: f.storage, name: 'Selected folder', commandId: creationCommandId })).value
    const entered = deferred()
    const attest = f.policies.attest.bind(f.policies)
    vi.spyOn(f.policies, 'attest').mockImplementationOnce(async root => {
      const result = await attest(root)
      entered.resolve()
      await release.promise
      return result
    })
    const selection = { workspaceId: input.workspaceId, commandId: randomUUID(), hostRef: f.allowlist.hostRef,
      allowedBaseId: input.allowedBaseId, configurationRevision: '1', relativePath: folder.name,
      accessMode: 'read-write', expectedLocationRevision: 0, expectedRootPolicyRevision: 0 }
    saving = f.owner.client.callTool({ name: 'workspace_root_location_set', arguments: selection })
    await entered.promise
    const commandId = randomUUID()
    const mutate = (principal: ManagementPrincipal) => operation === 'delete'
      ? browser.deleteFolders(principal, 'http', { commandId, paths: [folder.path] })
      : operation === 'undo' ? browser.undoCreated(principal, 'http', { commandId, creationCommandId })
        : browser.renameCreated(principal, 'http', { commandId, path: folder.path, name: 'Renamed folder' })
    const reader = await f.issue([{ actions: ['workspaces:read'], scope: {} }])
    await expect(mutate(reader.principal)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    let finished = false
    mutating = mutate(f.owner.principal).then(value => ({ value }), error => ({ error })).then(result => {
      finished = true
      return result
    })
    await observe(async () => finished || await lockWaiter(f.pool, 'workspace-folder-lifecycle'))
    release.resolve()
    expect(await saving).not.toMatchObject({ isError: true })
    const result = await mutating
    if (operation === 'delete') expect(result).toMatchObject({ value: { value: { deleted: [],
      failed: [{ path: folder.path, message: expect.any(String) }] } } })
    else expect(result).toHaveProperty('error')
    expect((await lstat(folder.path)).isDirectory()).toBe(true)
    expect(decodeMcpToolResult(await f.owner.client.callTool({ name: 'workspace_root_location_get',
      arguments: { workspaceId: input.workspaceId } }))).toMatchObject({ evidence: 'bound',
      executionLocation: { rootPath: folder.path } })
  } finally {
    release.resolve()
    await Promise.allSettled([saving, mutating])
    vi.restoreAllMocks()
    await f.close()
  }
})

it('protects a repository import container before its location is assigned', async () => {
  const f = await workspaceRepositoryFixture()
  const release = deferred()
  let importing: ReturnType<typeof add> | undefined
  try {
    const input = await workspace(f)
    Object.assign(f.services.workspaces, { storageFolders: new WorkspaceStorageFolders(f.pool, f.commands, f.storage) })
    const cloning = deferred()
    const git = f.sources.git.git.bind(f.sources.git)
    vi.spyOn(f.sources.git, 'git').mockImplementation(async (args, options) => {
      if (args.includes('clone')) {
        cloning.resolve()
        await release.promise
      }
      return git(args, options)
    })
    importing = add(f, input)
    // Keep the rejected promise observed even when a pre-fix deletion breaks cloning.
    const settled = importing.then(value => ({ value }), error => ({ error }))
    await cloning.promise
    const owner = workspaceStorageFoldersHttp(f.app, f.owner.token)
    const listed = (await owner.list()).body as { items: Array<{ path: string; identity: string; deletion: { status: string } }> }
    expect(listed.items).toHaveLength(1)
    const folder = listed.items[0]!
    const mutation = { commandId: randomUUID(), path: folder.path, expectedIdentity: folder.identity }
    const reader = await f.issue([{ actions: ['workspaces:read', 'workspace_locations:read'], scope: {} }])
    expect((await workspaceStorageFoldersHttp(f.app, reader.token).remove(mutation)).statusCode).toBe(403)
    const removed = await owner.remove(mutation)
    expect(removed.ok).toBe(false)
    expect(folder.deletion.status).toBe('protected')
    expect((await lstat(folder.path)).isDirectory()).toBe(true)
    release.resolve()
    expect(await settled).toMatchObject({ value: { value: { state: 'ready' } } })
    expect((await get(f, { workspaceId: input.workspaceId })).state).toBe('ready')
    expect(await readFile(join(folder.path, 'project', 'content.txt'), 'utf8')).toBe('approved raw bytes\n')
  } finally {
    release.resolve()
    await Promise.allSettled([importing])
    vi.restoreAllMocks()
    await f.close()
  }
})
