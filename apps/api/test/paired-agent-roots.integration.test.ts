import { execFileSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gitFixtureEnvironment } from './helpers/gitFixture.js'
import { randomUUID } from 'node:crypto'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { NodePlacementChoicesResultSchema } from '@foreman-code/contracts/placement-readback'
import { SourceRootListResultSchema } from '@foreman-code/contracts/source-admission'
import { WorkspaceRootListResultSchema } from '@foreman-code/contracts/workspace-root-policies'
import { WorkspaceBoundLocationSetResultSchema } from '@foreman-code/contracts/workspace-bound-location'
import { describe, expect, it } from 'vitest'
import { sourceSha256 } from '../src/modules/sources/manifest.js'
import { postgresEnabled } from './helpers/database.js'
import { pairedAgentRootsFixture } from './helpers/pairedAgentRootsFixture.js'

describe.skipIf(!postgresEnabled)('paired Agent workspace roots', () => {
  it.each(['mcp', 'http'] as const)('makes a paired computer ready through %s without manual root setup', async via => {
    const f = await pairedAgentRootsFixture()
    try {
      const owner = await f.connect()
      const { workspaceId } = f.input
      const scope = { workspaceId }
      const readPolicies = async () => WorkspaceRootListResultSchema.parse(decodeMcpToolResult(
        await owner.callTool({ name: 'workspace_root_choices_list', arguments: scope })))
      const readRoots = async () => SourceRootListResultSchema.parse(decodeMcpToolResult(
        await owner.callTool({ name: 'source_root_list', arguments: scope }))).items
      expect((await readPolicies()).policies.every(policy => policy.hostRef.kind === 'main')).toBe(true)
      expect((await readRoots()).every(root => root.selection.hostRef.kind === 'main')).toBe(true)
      const before = await f.workspaceRoots.get(f.base.writer.principal, scope)
      const path = `/api/management/workspaces/${workspaceId}/workflows/${f.input.workflowId}`
        + `/nodes/${f.input.nodeId}/placement-choices?agentConfigurationVersionId=${f.input.agentConfigurationVersionId}`
      const reader = await f.reader()
      const readOnly = await f.connect(reader.token)
      const readOnlyResult = await readOnly.callTool({ name: 'workflow_node_placement_choices', arguments: f.input })
      expect(readOnlyResult.isError).not.toBe(true)
      expect(NodePlacementChoicesResultSchema.parse(decodeMcpToolResult(readOnlyResult)).choices
        .some(choice => choice.placement.hostRef.kind === 'device')).toBe(false)
      expect((await readPolicies()).policies).toHaveLength(1)
      expect(f.prepared).toHaveLength(0)

      const denied = await f.reader(['workflows:read'])
      const deniedClient = await f.connect(denied.token)
      expect((await deniedClient.callTool({ name: 'workflow_node_placement_choices', arguments: f.input })).isError).toBe(true)
      expect((await f.app.inject({ method: 'GET', url: path,
        headers: { authorization: `Bearer ${denied.token}` } })).statusCode).toBe(403)
      expect(f.prepared).toHaveLength(0)
      let result
      if (via === 'mcp') {
        const response = await owner.callTool({ name: 'workflow_node_placement_choices', arguments: f.input })
        expect(response.isError).not.toBe(true)
        result = NodePlacementChoicesResultSchema.parse(decodeMcpToolResult(response))
      } else {
        const response = await f.app.inject({ method: 'GET', url: path, headers: f.headers })
        expect(response.statusCode, response.body).toBe(200)
        result = NodePlacementChoicesResultSchema.parse(response.json())
      }
      const choice = result.choices.find(value => value.placement.hostRef.kind === 'device')
      expect(choice).toMatchObject({ availability: 'ready', reason: null,
        placement: { hostRef: f.device.hostRef, source: f.placement.source } })
      const policy = (await readPolicies()).policies.find(value => value.hostRef.kind === 'device')!
      expect(policy).toMatchObject({ accessMode: 'read-write', bindingPurpose: 'ci-enrollment',
        relativePath: sourceSha256(Buffer.from(workspaceId)) })
      expect(policy.canonicalProjectRoot.startsWith(f.device.bases[0]!.canonicalPath + '/')).toBe(true)
      const roots = await readRoots()
      expect(roots).toContainEqual(expect.objectContaining({ source: f.placement.source,
        selection: expect.objectContaining({ rootPolicyId: policy.rootPolicyId }),
        binding: expect.objectContaining({ accessMode: 'exclusive-write',
          rootId: choice!.placement.rootBinding!.rootId }) }))
      expect(await f.workspaceRoots.get(f.base.writer.principal, scope)).toEqual(before)
      const again = await owner.callTool({ name: 'workflow_node_placement_choices', arguments: f.input })
      expect(NodePlacementChoicesResultSchema.parse(decodeMcpToolResult(again))).toEqual(result)
      expect(await readRoots()).toEqual(roots)
      expect(f.prepared).toHaveLength(1)
    } finally { await f.close() }
  }, 120_000)

  it('keeps the primary Main location when a device root is added, updated and replayed', async () => {
    const f = await pairedAgentRootsFixture()
    try {
      const owner = await f.connect()
      const scope = { workspaceId: f.input.workspaceId }
      const before = await f.workspaceRoots.get(f.base.writer.principal, scope)
      const input = { ...scope, hostRef: f.device.hostRef, allowedBaseId: f.device.bases[0]!.baseId,
        configurationRevision: f.device.configurationRevision, relativePath: 'project', accessMode: 'read-write',
        expectedLocationRevision: before.locationRevision, expectedRootPolicyRevision: 0, commandId: randomUUID() }
      const readLocation = async () => decodeMcpToolResult(await owner.callTool({
        name: 'workspace_root_location_get', arguments: scope }))
      const persisted = () => f.base.db.pool.query(
        'select execution_location,execution_location_identity,location_revision from workspaces where id=$1',
        [scope.workspaceId])
      const persistedBefore = (await persisted()).rows[0]
      const first = await owner.callTool({ name: 'workspace_root_location_set', arguments: input })
      expect(first.isError, JSON.stringify(first)).not.toBe(true)
      const accepted = WorkspaceBoundLocationSetResultSchema.parse(decodeMcpToolResult(first))
      expect(await readLocation()).toEqual(before)
      expect((await persisted()).rows[0]).toEqual(persistedBefore)
      expect(decodeMcpToolResult(await owner.callTool({ name: 'workspace_root_location_set', arguments: input })))
        .toEqual({ ...accepted, replayed: true })
      const updated = await f.app.inject({ method: 'PUT',
        url: `/api/management/workspaces/${scope.workspaceId}/root-location`, headers: f.headers,
        payload: { ...input, relativePath: 'another-project', expectedRootPolicyRevision: 1, commandId: randomUUID() } })
      expect(updated.statusCode, updated.body).toBe(200)
      expect(await readLocation()).toEqual(before)
      expect((await persisted()).rows[0]).toEqual(persistedBefore)
      const policies = WorkspaceRootListResultSchema.parse(decodeMcpToolResult(await owner.callTool({
        name: 'workspace_root_choices_list', arguments: scope }))).policies
      expect(policies).toContainEqual(expect.objectContaining({ hostRef: f.device.hostRef,
        rootPolicyRevision: '2', relativePath: 'another-project', locationRevision: String(before.locationRevision) }))
      const denied = await f.reader()
      expect((await (await f.connect(denied.token)).callTool({ name: 'workspace_root_location_set', arguments: input })).isError)
        .toBe(true)
      expect((await persisted()).rows[0]).toEqual(persistedBefore)
    } finally { await f.close() }
  }, 120_000)

  it.each([true, false])('sets up a selected Worker before offering it in real placement discovery (Main source bound: %s)', async mainSourceBound => {
    const f = await pairedAgentRootsFixture({ unboundMainSource: !mainSourceBound })
    try {
      const { workspaceId } = f.input
      const before = await f.workspaceRoots.get(f.base.writer.principal, { workspaceId })
      const project = before.executionLocation!.rootPath
      const git = (...args: string[]) => execFileSync('git', args, { cwd: project, env: gitFixtureEnvironment() })
      git('init', '-q', '-b', 'main')
      await writeFile(join(project, 'hello.ts'), 'export const hello = true\n')
      git('add', 'hello.ts')
      git('commit', '-qm', 'Initial project')
      const reader = await f.reader()
      const path = `/api/management/workspaces/${workspaceId}/workflows/${f.input.workflowId}`
        + `/nodes/${f.input.nodeId}/placement-choices?agentConfigurationVersionId=${f.input.agentConfigurationVersionId}`
      const readChoices = async () => NodePlacementChoicesResultSchema.parse((await f.app.inject({
        method: 'GET', url: path, headers: { authorization: `Bearer ${reader.token}` },
      })).json())
      const beforeChoices = await readChoices()
      expect(beforeChoices.choices.some(choice => choice.placement.hostRef.kind === 'device')).toBe(false)
      expect(beforeChoices.unavailableComputers).toContainEqual(expect.objectContaining({
        hostRef: f.device.hostRef, reason: expect.stringContaining('project isn’t set up'),
      }))
      const readRoots = async () => SourceRootListResultSchema.parse((await f.app.inject({ method: 'GET',
        url: `/api/management/workspaces/${workspaceId}/source-roots`, headers: f.headers })).json()).items
      const beforeRoots = await readRoots()
      expect(beforeRoots.filter(root => root.selection.hostRef.kind === 'main')).toHaveLength(mainSourceBound ? 1 : 0)
      const folder = await f.app.inject({ method: 'PUT', url: `/api/management/workspaces/${workspaceId}/root-location`,
        headers: f.headers, payload: { workspaceId, hostRef: f.device.hostRef, allowedBaseId: f.device.bases[0]!.baseId,
          configurationRevision: f.device.configurationRevision, relativePath: 'chosen-project', accessMode: 'read-write',
          expectedLocationRevision: before.locationRevision, expectedRootPolicyRevision: 0, commandId: randomUUID() } })
      expect(folder.statusCode, folder.body).toBe(200)
      const location = WorkspaceBoundLocationSetResultSchema.parse(folder.json()).value
      if (location.evidence !== 'bound') throw new Error('Expected a saved Worker folder')
      // A folder policy alone must not masquerade as a ready placement.
      expect((await readChoices()).choices.some(choice => choice.placement.hostRef.kind === 'device')).toBe(false)
      const input = { workspaceId, commandId: randomUUID(), selection: { hostRef: location.binding.hostRef,
        rootPolicyId: location.binding.rootPolicyId, rootPolicyRevision: location.binding.rootPolicyRevision,
        locationRevision: location.binding.locationRevision }, accessMode: 'exclusive-write' }
      const setup = () => f.app.inject({ method: 'POST', url: `/api/management/workspaces/${workspaceId}/source-roots/setup`,
        headers: f.headers, payload: input })
      const response = await setup()
      const choices = await readChoices()
      expect(choices.choices, response.body).toContainEqual(expect.objectContaining({ availability: 'ready', reason: null,
        placement: expect.objectContaining({ hostRef: f.device.hostRef, projectRoot: location.binding.canonicalProjectRoot,
          rootBinding: expect.objectContaining({ rootId: expect.any(String) }) }) }))
      expect(response.statusCode, response.body).toBe(200)
      expect(choices.unavailableComputers).toEqual([])
      const roots = await readRoots()
      expect(roots.filter(root => root.selection.hostRef.kind === 'main')).toEqual(beforeRoots)
      const worker = roots.find(root => root.selection.hostRef.kind === 'device')!
      expect(worker.selection).toEqual(input.selection)
      if (mainSourceBound) expect(worker.source).toEqual(f.placement.source)
      expect((await setup()).statusCode).toBe(200)
      expect(await readRoots()).toEqual(roots)
      expect(await f.workspaceRoots.get(f.base.writer.principal, { workspaceId })).toEqual(before)
    } finally { await f.close() }
  }, 120_000)

  it('does not provision an arbitrary device base that was not managed by pairing', async () => {
    const f = await pairedAgentRootsFixture({ managedBase: false })
    try {
      const owner = await f.connect()
      const response = await owner.callTool({ name: 'workflow_node_placement_choices', arguments: f.input })
      expect(response.isError).not.toBe(true)
      expect(NodePlacementChoicesResultSchema.parse(decodeMcpToolResult(response)).choices
        .some(choice => choice.placement.hostRef.kind === 'device')).toBe(false)
      expect(f.prepared).toHaveLength(0)
    } finally { await f.close() }
  }, 120_000)
})
