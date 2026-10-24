import { describe, expect, it } from 'vitest'
import { agentChatFixtures, type AgentChatState } from '@foreman-code/contracts/agent-chat'
import { ActivitySnapshotV1Schema, type ActivityScope } from '@foreman-code/contracts/activity'
import { FileWithRevisionSchema } from '@foreman-code/contracts/files'
import { acceptAgentChatState } from '../../chat-core'
import { newerOperatorConversationState as newer } from '../../operator-chat'
import { operatorState } from '../../operator-chat/pr17-test-fixtures'

function attachment(conversationId: string, kind: 'agent' | 'operator', state = 'ready', context = agentChatFixtures.idleAfterCompletion.context) {
  return FileWithRevisionSchema.parse({
    file: { fileId: 'input-file', currentRevisionId: 'input-revision', state,
      scope: { kind: 'temporary', chat: kind === 'agent' ? { kind, conversationId, agentId: context.agentId, workspaceId: context.workspaceId, workflowId: context.workflowId }
        : { kind, conversationId, ownerPrincipalId: 'owner', operatorId: 'application-operator' } },
      createdAt: '2026-10-01T00:00:00Z', retentionDurationSeconds: 3600, expiresAt: '2026-10-01T01:00:00Z' },
    revision: { fileId: 'input-file', revisionId: 'input-revision', filename: 'input.md', mediaType: 'text/markdown',
      byteSize: 1, sha256: '0'.repeat(64), origin: 'upload', createdAt: '2026-10-01T00:00:00Z' },
  })
}
function snapshot(scope: Extract<ActivityScope, { kind: 'agent_chat' | 'operator_chat' }>, revision: number, fileRevision: string) {
  return ActivitySnapshotV1Schema.parse({ schemaVersion: 1, scope, revision: String(revision),
    sourceRevisions: [{ source: 'scope', id: scope.conversationId, revision: String(revision) },
      { source: 'file', id: 'input-file', revision: fileRevision }],
    active: [], queued: [], latest: null, pendingInteractions: [], activities: [],
    page: { before: null, nextCursor: null, hasMore: false } })
}

describe('attachment metadata consumer readback', () => {
  for (const change of ['removed', 'clock_expired'] as const) it(`Agent refreshes an input file ${change} without rewriting message/scope revisions`, () => {
    const state: AgentChatState = structuredClone(agentChatFixtures.idleAfterCompletion)
    const conversationId = state.conversation!.id, context = state.context
    const read = (fileState = 'ready', fileRevision = '7') => ({ ...state,
      messages: [{ ...state.messages[0]!, revision: '1', sequence: '1',
        attachments: [attachment(conversationId, 'agent', fileState, context)] }],
      activitySnapshot: snapshot({ kind: 'agent_chat', conversationId, workspaceId: context.workspaceId, workflowId: context.workflowId,
        nodeId: context.workflowNodeId, agentId: context.agentId }, state.revision, fileRevision) })
    const previous = read()
    const incoming = read(change === 'removed' ? 'removed' : 'expired', change === 'removed' ? '8' : '7'), accepted = acceptAgentChatState(previous, incoming, 'read')
    expect(incoming.messages[0]?.attachments?.[0]?.file.state).toBe(change === 'removed' ? 'removed' : 'expired')
    expect(accepted.messages[0]?.attachments?.[0]?.file.state).toBe(change === 'removed' ? 'removed' : 'expired')
    expect(accepted.messages[0]?.revision).toBe('1'); expect(accepted.revision).toBe(previous.revision)
    expect(incoming.activitySnapshot.sourceRevisions).toContainEqual({ source: 'file', id: 'input-file', revision: change === 'removed' ? '8' : '7' })
    if (change === 'clock_expired') {
      expect(incoming.activitySnapshot.sourceRevisions).toEqual(previous.activitySnapshot.sourceRevisions)
      expect(acceptAgentChatState(previous, incoming, 'receipt').messages[0]?.attachments?.[0]?.file.state).toBe('ready')
    } else expect(acceptAgentChatState(accepted, previous, 'read').messages[0]?.attachments?.[0]?.file.state).toBe('removed')
  })

  it('Operator accepts input-file metadata when its source vector advances', () => {
    const base = operatorState({ revision: 4 }), conversationId = base.conversation.id
    const read = (fileState = 'ready', fileRevision = '7') => ({ ...base,
      messages: [{ ...base.messages[0]!, revision: '1', sequence: '1',
        attachments: [attachment(conversationId, 'operator', fileState)] }],
      activitySnapshot: snapshot({ kind: 'operator_chat', conversationId }, base.revision, fileRevision) })
    const previous = read()
    const incoming = read('removed', '8'), accepted = newer(previous, incoming, 'read')
    expect(accepted.activitySnapshot?.sourceRevisions).toContainEqual({ source: 'file', id: 'input-file', revision: '8' })
    expect(accepted.messages[0]?.attachments?.[0]?.file.state).toBe('removed')
    expect(accepted.messages[0]?.revision).toBe('1'); expect(accepted.revision).toBe(4)
    expect(newer(accepted, previous, 'read').messages[0]?.attachments?.[0]?.file.state).toBe('removed')
    // Equal-vector cached receipts cannot replace dynamically expired metadata learned by a read.
    const ready = read('ready', '9')
    const expired = read('expired', '9'), observed = newer(ready, expired, 'read')
    expect(observed.messages[0]?.attachments?.[0]?.file.state).toBe('expired')
    expect(newer(observed, ready, 'receipt').messages[0]?.attachments?.[0]?.file.state).toBe('expired')
  })
})
