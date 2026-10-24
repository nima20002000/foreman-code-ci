import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { NodePlacementChoicesResultSchema } from '@foreman-code/contracts/placement-readback'
import { SourceListResultSchema, SourceRootListResultSchema } from '@foreman-code/contracts/source-admission'
import { expect, it, vi } from 'vitest'
import { buildApp } from '../src/app.js'
import { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import { ProductionPlacementChoiceDiscovery } from '../src/modules/placement/choiceDiscovery.js'
import { NodePlacementChoicesService } from '../src/modules/placement/choicesService.js'
import { fixture, toolError } from './helpers/nodePlacementStartFixture.js'

it('repairs released source choices through authenticated HTTP and MCP with persisted readback and denied callers',
  async () => {
    const f = await fixture()
    const clients: Client[] = []
    let app: ReturnType<typeof buildApp> | undefined
    try {
      const saved = await f.save('mcp')
      const input = { workspaceId: saved.version.workspaceId, workflowId: saved.workflowId,
        nodeId: saved.version.definition.nodes[0]!.id,
        agentConfigurationVersionId: f.base.f.configurations[0]!.id }
      const pool = f.base.db.pool
      const profileEvidence = vi.fn(async () => ({ qualified: true }))
      const discovery = new ProductionPlacementChoiceDiscovery(pool, () => ({
        roots: f.placement.policies, sources: f.placement.sources,
        profiles: new HarnessInstanceSettingsRepository(pool),
        registry: { installations: f.placement.installations, profileEvidence },
      }))
      app = buildApp({ logger: false,
        readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
        operator: { access: f.base.access, services: { ...f.base.services,
          sources: f.placement.sources, placementChoices: new NodePlacementChoicesService(pool, discovery) } },
      })
      const address = await app.listen({ port: 0 })
      async function connect(token: string) {
        const client = new Client({ name: 'unavailable-placement-choices', version: '1' })
        clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
          authProvider: { token: async () => token },
        }))
        return client
      }
      const owner = await connect(f.base.writer.token)
      const boundBefore = await owner.callTool({ name: 'source_root_list',
        arguments: { workspaceId: input.workspaceId } })
      expect(boundBefore.isError).not.toBe(true)
      const roots = SourceRootListResultSchema.parse(decodeMcpToolResult(boundBefore)).items
      expect(roots).toHaveLength(2)
      await pool.query("update source_snapshots set availability='unavailable' where snapshot_id=$1",
        [f.placement.source.snapshotId])

      const response = await owner.callTool({ name: 'workflow_node_placement_choices', arguments: input })
      expect(response.isError).not.toBe(true)
      const result = NodePlacementChoicesResultSchema.parse(decodeMcpToolResult(response))
      expect(result.choices).toHaveLength(2)
      for (const placement of [f.placement.local, f.placement.remote]) {
        const choice = result.choices.find(value => value.placement.hostRef.kind === placement.hostRef.kind)!
        expect(choice).toMatchObject({ availability: 'ready', reason: null,
          placement: { hostRef: placement.hostRef, rootBinding: { rootId: placement.rootBinding!.rootId,
            bindingRevision: placement.rootBinding!.bindingRevision + 1 } } })
        expect(choice.placement.source!.snapshotId).not.toBe(f.placement.source.snapshotId)
      }
      expect(profileEvidence).toHaveBeenCalled()
      const path = `/api/management/workspaces/${input.workspaceId}/workflows/${input.workflowId}`
        + `/nodes/${input.nodeId}/placement-choices?agentConfigurationVersionId=${input.agentConfigurationVersionId}`
      const http = await app.inject({ method: 'GET', url: path, headers: f.headers })
      expect(http.statusCode).toBe(200)
      expect(NodePlacementChoicesResultSchema.parse(http.json())).toEqual(result)
      const sourceRead = await owner.callTool({ name: 'source_list',
        arguments: { workspaceId: input.workspaceId, detail: 'full' } })
      expect(sourceRead.isError).not.toBe(true)
      expect(SourceListResultSchema.parse(decodeMcpToolResult(sourceRead)).items).toEqual(expect.arrayContaining([
        expect.objectContaining({ availability: 'unavailable', manifest: expect.objectContaining({
          snapshotId: f.placement.source.snapshotId,
        }) }),
        expect.objectContaining({ availability: 'retained', manifest: expect.objectContaining({
          snapshotId: result.choices[0]!.placement.source!.snapshotId,
        }) }),
      ]))
      const boundAfter = await owner.callTool({ name: 'source_root_list',
        arguments: { workspaceId: input.workspaceId } })
      expect(boundAfter.isError).not.toBe(true)
      const refreshed = SourceRootListResultSchema.parse(decodeMcpToolResult(boundAfter)).items
      expect(refreshed).toHaveLength(roots.length)
      for (const root of roots) {
        expect(refreshed).toContainEqual(expect.objectContaining({ binding: expect.objectContaining({
          rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision + 1,
        }) }))
        const historical = (await pool.query('select record from source_root_bindings where root_id=$1 and binding_revision=$2',
          [root.binding.rootId, root.binding.bindingRevision])).rows[0]!
        expect(historical.record).toEqual(root)
      }
      const readback = await owner.callTool({ name: 'workflow_node_placement_choices', arguments: input })
      expect(readback.isError).not.toBe(true)
      expect(NodePlacementChoicesResultSchema.parse(decodeMcpToolResult(readback))).toEqual(result)

      // A later release must capture again rather than replay the first setup receipt.
      await pool.query("update source_snapshots set availability='unavailable' where snapshot_id=$1",
        [result.choices[0]!.placement.source!.snapshotId])
      const recoveredAgain = await app.inject({ method: 'GET', url: path, headers: f.headers })
      expect(recoveredAgain.statusCode).toBe(200)
      const again = NodePlacementChoicesResultSchema.parse(recoveredAgain.json())
      expect(again.choices).toHaveLength(2)
      for (const choice of again.choices) {
        expect(choice.availability).toBe('ready')
        expect(choice.placement.source!.snapshotId).not.toBe(result.choices[0]!.placement.source!.snapshotId)
      }

      const denied = await f.base.access.issue({ name: 'Other workflow reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 120_000), grants: [
          { actions: ['workflows:read'],
            scope: { workspaceIds: [input.workspaceId], workflowIds: [randomUUID()] } },
          { actions: ['workspace_locations:read', 'source_roots:read', 'sources:read'],
            scope: { workspaceIds: [input.workspaceId] } },
          { actions: ['harnesses:read'], scope: {} },
        ] })
      const deniedClient = await connect(denied.token)
      expect(toolError(await deniedClient.callTool({ name: 'workflow_node_placement_choices', arguments: input })))
        .toMatchObject({ error: { code: 'ACCESS_DENIED' } })
      expect((await app.inject({ method: 'GET', url: path,
        headers: { authorization: `Bearer ${denied.token}` } })).statusCode).toBe(403)
    } finally {
      await Promise.allSettled(clients.map(client => client.close()))
      await app?.close()
      await f.close()
      vi.restoreAllMocks()
    }
  }, 120_000)
