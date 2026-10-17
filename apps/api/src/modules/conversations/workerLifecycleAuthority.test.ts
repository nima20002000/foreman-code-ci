import { expect, it } from 'vitest'
import type pg from 'pg'
import type { WorkerConversationReceipt, WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import { legacyProviderAccountBinding } from '../provider-accounts/acceptedBindings.js'
import { createProductionWorkerConversations } from './workerProduction.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'

it('uses the retained owner for disposal after a read-only reader, while user controls still require their caller', async () => {
  const f = workerConversationFixture('agent', 'claude')
  if (!('agentId' in f.configuration) || f.binding.owner.kind !== 'agent') throw new Error('Agent fixture required')
  const binding = { ...f.binding,
    accountBinding: legacyProviderAccountBinding(f.configuration.harness, f.configuration.harnessProfileSelection)! }
  const principal = (id: string, actions: string[]) => ({ id, name: id, audience: 'operator', delegated_from: null,
    grants: [{ actions, scope: {} }], expires_at: new Date(Date.now() + 600_000), revoked_at: null })
  const owner = principal('runtime-owner', ['agent_chat:read', 'agent_chat:write'])
  const reader = principal('state-reader', ['agent_chat:read'])
  const conversation = { id: binding.owner.conversationId, kind: 'agent', workspace_id: f.configuration.workspaceId,
    workflow_id: binding.owner.workflowId, workflow_node_id: binding.owner.workflowNodeId, agent_id: f.configuration.agentId,
    agent_configuration_version_id: f.configuration.id, owner_principal_id: null, active_request_id: null,
    native_session_id: f.session.nativeSessionId, deleted_at: null, record: { status: 'open' }, payload: { ownerPrincipalId: owner.id } as { ownerPrincipalId: string } | null,
    worker_conversation_binding: binding }
  const pool = { query: async (sql: string, values: unknown[]) => {
    if (sql.includes('from management_principals')) return { rows: [values[0] === owner.id ? owner : reader] }
    if (sql.includes('from provider_account_accepted_bindings')) return { rows: [{ binding: binding.accountBinding }] }
    return { rows: [conversation], rowCount: 1 }
  } } as unknown as pg.Pool
  const receipt: WorkerConversationReceipt = { binding, connection: f.connection, session: f.session,
    nativeOwner: f.nativeOwner, revision: 1, closed: false, closing: false, turns: [], compactions: [],
    desiredPreferences: null, appliedPreferences: null }
  const methods: string[] = []
  const channel = { binding: f.connection, request: async (raw: unknown) => {
    const request = raw as WorkerConversationRpcRequest
    methods.push(request.method)
    if (request.method === 'conversation.pending') return { payload: null }
    if (request.method === 'conversation.release-runtime') { receipt.runtimeReleased = true; receipt.revision++ }
    return { payload: { receipt } }
  } }
  const profiles = { admit: async () => ({ override: { configuration: f.configuration.harness,
    target: binding.profile.target } }), revalidate: async () => {} }
  const production = createProductionWorkerConversations({ pool, endpoint: () => ({ captureRequest: () => channel }),
    profiles, claudeProfiles: profiles, operators: {}, agents: {}, registry: {}, qualifications: {},
    suiteRevisions: {}, access: {}, mcpForward: () => ({}),
  } as unknown as Parameters<typeof createProductionWorkerConversations>[0])
  const manager = production.create({ conversationId: conversation.id, configuration: f.configuration,
    workingDirectory: binding.workingDirectory, appMcpAccess: 'none', observationPrincipalId: owner.id })
  try {
    await manager.attachSession(f.session, { kind: 'agent-chat', configuration: f.configuration,
      conversationId: conversation.id, workflowId: binding.owner.workflowId, workflowNodeId: binding.owner.workflowNodeId,
      workingDirectory: binding.workingDirectory, correlationId: 'attach' })
    conversation.payload = null
    manager.setSessionControlPrincipal!(reader.id)
    await expect(manager.pending(f.session)).resolves.toBeUndefined()
    await expect(manager.closeForResume!(f.session)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(methods.filter(method => method === 'conversation.release-runtime')).toHaveLength(0)
    await manager.dispose!()
    expect(receipt.runtimeReleased).toBe(true)
    expect(methods.filter(method => method === 'conversation.release-runtime')).toHaveLength(1)
  } finally { await production.close() }
})
