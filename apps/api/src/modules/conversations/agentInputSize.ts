import type pg from 'pg'
import { randomUUID } from 'node:crypto'
import { sessionTaskContent, type AgentConfigurationVersion } from '@foreman-code/contracts'
import { WorkerConversationBindingSchema, WorkerConversationRpcRequestSchema } from '@foreman-code/contracts/remote-execution-rpc'
import type { SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import { agentChatCorrelation, type AgentConversationRow } from './agentChatRepository.js'
import { agentMessagePrompt } from './agentMessagePrompt.js'
import { assertWorkerChatInputSize, assertWorkerChatRequestSize } from './chatInputSize.js'
import { readExecutionPlacement, readNativePlacement } from '../placement/persistence.js'

export async function assertAgentChatInputSize(sql: Pick<pg.PoolClient, 'query'>, input: {
  row: AgentConversationRow; configuration: AgentConfigurationVersion; nextConfiguration?: AgentConfigurationVersion
  request: SendAgentChatMessageRequest; principalId: string
}): Promise<void> {
  const { row, configuration, nextConfiguration, request } = input
  const placement = row.origin_execution_id ? await readExecutionPlacement(sql, row.origin_execution_id) : undefined
  const configurations = [configuration, ...(nextConfiguration ? [nextConfiguration] : [])]
  if (!row.worker_conversation_binding && placement?.hostRef.kind !== 'device'
    && row.record.directoryBinding?.policy.hostRef.kind !== 'device'
    && !configurations.some(value => value.harnessProfileSelection?.target.hostRef.kind === 'device')) return
  const native = row.origin_execution_id ? await readNativePlacement(sql, row.origin_execution_id) : undefined
  const controls = (await sql.query<{ desired: unknown; defaults: unknown }>(
    "select record->'desired' as desired,record->'defaults' as defaults from conversation_session_controls where conversation_id=$1",
    [row.id])).rows
  const defaults = (await sql.query<{ record: unknown }>(`select record from conversation_session_defaults
    where principal_id=$1 and role='agent' and subject=$2 and profile_key=any($3::text[])`,
  [input.principalId, `${row.workspace_id}:${row.agent_id}`, configurations.map(value => value.id)])).rows
  const selected = nextConfiguration ?? configuration
  const content = sessionTaskContent(request.content, request.sessionMode)
  const prompt = request.intent === 'steer' ? request.content : agentMessagePrompt(row.record, selected, content).text
  if (row.worker_conversation_binding && row.native_session_id && row.provider_version && !nextConfiguration) {
    const binding = WorkerConversationBindingSchema.parse(row.worker_conversation_binding)
    const session = { harness: binding.harness, nativeSessionId: row.native_session_id, providerVersion: row.provider_version }
    const admissionId = randomUUID()
    const correlationId = agentChatCorrelation(row.id, request.requestId)
    if (request.intent === 'steer') {
      assertWorkerChatRequestSize({ method: 'conversation.steer', binding, admissionId, session, prompt,
        correlationId, expectedTurnId: request.expectedNativeTurnId ?? '' })
    } else {
      const preferences = controls[0]?.desired ?? defaults[0]?.record
      const fields = preferences === undefined ? {} : { preferences }
      // A retained session may need a cold attach; its configuration is sent separately from the next prompt.
      assertWorkerChatRequestSize(WorkerConversationRpcRequestSchema.parse({ method: 'conversation.open', binding,
        admissionId, source: session, mode: 'attach', configuration, operationId: correlationId, ...fields }))
      assertWorkerChatRequestSize(WorkerConversationRpcRequestSchema.parse({ method: 'conversation.start-turn',
        binding, admissionId, session, prompt, correlationId, sessionMode: request.sessionMode,
        ...(binding.harness === 'codex' ? { fileInputs: true } : {}), ...fields }))
    }
    return
  }
  assertWorkerChatInputSize({ prompt, metadata: [configurations, row.worker_conversation_binding,
    row.record, row.providerAccountBinding, placement, native, controls, defaults, request.context,
    { nativeSessionId: row.native_session_id, providerVersion: row.provider_version }] })
}
