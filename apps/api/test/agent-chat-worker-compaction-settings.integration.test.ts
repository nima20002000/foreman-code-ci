import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { AgentChatControlsStateSchema } from '@foreman-code/contracts/agent-chat'
import { WorkerConversationBindingSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { historicalChatPlacement } from './helpers/historicalChatPlacement.js'
import { workerSettingsChat } from './helpers/agentChatWorkerSettings.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

it.each(['resident', 'unloaded'] as const)(
  'recovers Worker compaction after its profile is superseded with a %s Main session', async residency => {
    await historicalChatPlacement(async fixture => {
      const chat = await workerSettingsChat(fixture)
      const target = { workspaceId: chat.workspaceId, conversationId: chat.id }
      const session = chat.completed.conversation!.nativeSession!
      const controls = AgentChatControlsStateSchema.parse(await fixture.value('agent_chat_controls_get', target))
      expect(controls.capabilities.compact.supported).toBe(true)
      await fixture.provider.loseCompactionResponse()
      const request = { kind: 'compact', requestId: randomUUID(), expectedRevision: controls.revision }
      const compacted = AgentChatControlsStateSchema.parse(await fixture.value('agent_chat_controls_update', {
        ...target, request,
      }))
      expect(compacted.compaction).toMatchObject({ requestId: request.requestId, status: 'uncertain',
        dispatchPhase: 'dispatched', nativeSessionId: session.nativeSessionId })
      const binding = WorkerConversationBindingSchema.parse((await fixture.db.pool.query<{
        worker_conversation_binding: unknown
      }>('select worker_conversation_binding from operator_conversations where id=$1', [chat.id]))
        .rows[0]!.worker_conversation_binding)
      const saved = await chat.save({ model: 'other-model', reasoningEffort: 'medium' })
      expect(saved.update.harnessProfileSelection.instanceId).toBe(binding.profile.instanceId)
      expect(saved.update.harnessProfileSelection.instanceRevision).not.toBe(binding.profile.instanceRevision)
      if (residency === 'unloaded') await fixture.restartMain()
      const blocked = await fixture.call('agent_chat_send', { workspaceId: chat.workspaceId,
        selection: chat.selection, message: { requestId: randomUUID(), expectedConversationId: chat.id,
          content: 'Wait for compaction recovery.' } })
      expect(blocked.isError).toBe(true)
      expect(JSON.stringify(blocked.content)).toContain('SESSION_COMPACT_UNCONFIRMED')
      const beforeRead = (await fixture.provider.calls()).length
      const denied = await fixture.access.issue({ name: 'Denied compaction observer', audience: 'operator',
        expiresAt: new Date(Date.now() + 600_000), grants: [] })
      await expectMcpAccessDenied(fixture.call('agent_chat_controls_get', target, denied.token))
      const recovered = AgentChatControlsStateSchema.parse(await fixture.value('agent_chat_controls_get', target))
      expect(recovered).toMatchObject({ profileKey: controls.profileKey,
        nativeSessionId: session.nativeSessionId,
        compaction: { requestId: request.requestId, status: 'completed', nativeSessionId: session.nativeSessionId },
        configuration: { versionId: saved.result.value.agent.configurationVersionId,
          harness: { model: 'other-model', reasoningEffort: 'medium' } } })
      const recoveryCalls = (await fixture.provider.calls()).slice(beforeRead)
      expect(recoveryCalls).toContainEqual(expect.objectContaining({ method: 'thread/read',
        threadId: session.nativeSessionId }))
      expect(recoveryCalls.filter(call => ['thread/start', 'thread/resume', 'thread/fork', 'turn/start',
        'thread/compact/start'].includes(String(call.method)))).toEqual([])
      const replay = AgentChatControlsStateSchema.parse(await fixture.value('agent_chat_controls_update', {
        ...target, request,
      }))
      expect(replay.compaction).toMatchObject({ requestId: request.requestId, status: 'completed' })
      const persisted = AgentChatControlsStateSchema.parse(await fixture.value('agent_chat_controls_get', target))
      expect(persisted.compaction).toEqual(recovered.compaction)
      const continued = await chat.send('Continue with the saved settings after compaction.')
      expect(continued.state.conversation).toMatchObject({ id: chat.id, nativeSession: session,
        agentConfigurationVersionId: saved.result.value.agent.configurationVersionId })
      const calls = await fixture.provider.calls()
      expect(calls.filter(call => call.method === 'thread/compact/start')).toHaveLength(1)
      expect(calls.filter(call => call.method === 'turn/start'
        && call.correlationId === `agent-chat:${chat.id}:${continued.message.requestId}`)).toHaveLength(1)
      expect(calls).toContainEqual(expect.objectContaining({ method: 'thread/resume',
        threadId: session.nativeSessionId, model: 'other-model', reasoningEffort: 'medium' }))
      expect(await fixture.details(chat.started.run.id)).toEqual(chat.before)
    }, { includeNodeRuntimePayload: false, sourceAccessMode: 'exclusive-write' })
  }, 240_000,
)
