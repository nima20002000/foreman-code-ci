import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'
import { AgentConfigurationVersionSchema, HarnessExecutionSchema } from '@foreman-code/contracts'
import { WorkflowRunV3Schema, WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { createPostgresClaudeInteractionBridge } from '../src/modules/harnesses/claudeSdk/domainAuthority.js'
import { claudeCallbackDatabase } from './support/claudeCallbackDatabase.js'

const configuration: ClaudeHarnessConfiguration = { harness: 'claude', model: 'fixture', authMode: 'subscription', configDirectory: '/fixture',
  permissionMode: 'default', sandbox: 'danger-full-access', tools: ['Read'], permissionRules: [], instructions: '', mcpServers: {} }
const session = { harness: 'claude' as const, nativeSessionId: 'native-session', providerVersion: 'fixture-cli' }
const createdAt = '2026-10-01T00:00:00.000Z'
const approval = { handler: 'user' as const }
const cfg = AgentConfigurationVersionSchema.parse({ id: 'cfg', workspaceId: 'ws', agentId: 'agent', version: 1, productRole: 'coder',
  harness: configuration, prompt: {}, assignedSkills: [], contentHash: `sha256:${'0'.repeat(64)}`, createdAt })
const version = WorkflowVersionV3Schema.parse({ id: 'version', workspaceId: 'ws', workflowId: 'wf', version: 1, executionSemanticsVersion: 3,
  entryNodeId: 'node', approval, agentConfigurationVersionIds: { agent: cfg.id }, contentHash: `sha256:${'0'.repeat(64)}`, createdAt,
  definition: { id: 'wf', workspaceId: 'ws', name: 'Correction turn fixture', version: 1, executionSemanticsVersion: 3, entryNodeId: 'node',
    approval, executionCondition: { kind: 'manual' }, executionPolicy: { maxParallelism: 1, maxNodeExecutions: 1 },
    nodes: [{ id: 'node', agentId: 'agent', name: 'Worker' }], edges: [] } })
const run = WorkflowRunV3Schema.parse({ id: 'run', workspaceId: 'ws', workflowId: 'wf', workflowVersionId: version.id, executionSemanticsVersion: 3,
  agentConfigurationVersionIds: version.agentConfigurationVersionIds, approval, executionCondition: { kind: 'manual' },
  executionState: 'running', outcome: 'pending', input: {}, createdAt })
const execution = HarnessExecutionSchema.parse({ id: 'exec', runId: run.id, workflowNodeId: 'node', agentId: 'agent',
  agentConfigurationVersionId: cfg.id, attempt: 1, nativeSessionId: session.nativeSessionId, state: 'running', input: {}, createdAt })

/** Modeled tables: the execution's run, its owner's grant, and one reserved result correction. */
function bridgeFor(clientCorrelationId: string) {
  const callbacks = claudeCallbackDatabase()
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    const callbackResult = callbacks(sql, values)
    if (callbackResult) return callbackResult
    const rows = sql.includes('e.record as execution') ? [{ run, version, execution, configuration: cfg, attempt: 1, stopped: false,
      execution_closed: false, native_reference: session, finalized: false, generation: '1', native_owner: 'agent', budget_active: true }]
      : sql.includes("record->>'authorizationPrincipalId'") ? [{ principal_id: 'sender' }]
      : sql.includes('from management_principals where id=') ? [{ id: 'sender', name: 'Sender', audience: 'operator',
        grants: [{ actions: ['runs:start'], scope: {} }], expires_at: new Date('2099-01-01'), revoked_at: null, delegated_from: null }]
      : sql.includes('from execution_work_result_repairs') ? [{ attempt: 1 }]
      : (() => { throw new Error('Unexpected workflow SQL ' + sql.slice(0, 100)) })()
    return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] }
  })
  const callback = { ownerPrincipalId: 'sender', attemptId: '1', nativeSessionId: session.nativeSessionId, nativeMessageId: 'message',
    clientCorrelationId, generation: 'generation', toolUseId: 'tool-use' }
  const { bridge } = createPostgresClaudeInteractionBridge({ database: { query } as unknown as pg.Pool, configuration,
    binding: { kind: 'workflow', runId: 'run', executionId: 'exec', attempt: 1, getOwner: () => undefined },
    manager: { nativeCallbackContext: () => ({ nativeSessionId: session.nativeSessionId, nativeMessageId: callback.nativeMessageId,
      clientCorrelationId, generation: callback.generation }) } })
  return () => bridge.beforeToolUse(callback, 'Read', { path: 'owned-root' })
}

it('lets an Agent use its tools while it answers a result correction for its own execution', async () => {
  await expect(bridgeFor('execution:exec')()).resolves.toEqual({})
  await expect(bridgeFor('execution:exec:result-repair:1')()).resolves.toEqual({})
})

it('still denies tools in a correction turn the execution never reserved', async () => {
  await expect(bridgeFor('execution:exec:result-repair:2')()).resolves.toMatchObject({ permissionDecision: 'deny' })
  await expect(bridgeFor('execution:other')()).resolves.toMatchObject({ permissionDecision: 'deny' })
})
