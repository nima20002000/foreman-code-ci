import type { SqlQuery } from '../../infrastructure/transaction.js'
import { AgentSubjectSchema, type AgentConfigurationVersion, type AgentSubject } from '@foreman-code/contracts'
import { PostgresWorkflowRepository } from '../workflows/postgres.js'
import { DomainError } from '../errors.js'
import type { AgentConversationRow } from './agentChatRepository.js'

type AgentNode = Exclude<NonNullable<Awaited<ReturnType<PostgresWorkflowRepository['getSavedVersion']>>>['definition']['nodes'][number], { kind: 'job' }>

/** Accepted conversation facts for D's shared scoped-credential resolver. Never an Operator or fabricated Run. */
export async function conversationFeatureContext(sql: SqlQuery,
  row: AgentConversationRow, configuration: AgentConfigurationVersion, acceptedWorkflowVersionId?: string | null) {
  if (configuration.workspaceId !== row.workspace_id || configuration.agentId !== row.agent_id) {
    throw new DomainError('CHAT_SUBJECT_CONFIGURATION_MISMATCH', 'The accepted configuration belongs to another Agent.', 409)
  }
  const workflows = new PostgresWorkflowRepository(sql)
  const origin = row.origin_run_id ? (await sql.query<{ workflow_version_id: string }>(
    'select workflow_version_id from runs where id=$1 and workspace_id=$2 and workflow_id=$3',
    [row.origin_run_id, row.workspace_id, row.workflow_id])).rows[0] : undefined
  const version = acceptedWorkflowVersionId ? await workflows.getSavedVersion(acceptedWorkflowVersionId) : row.origin_run_id
    ? origin && await workflows.getSavedVersion(origin.workflow_version_id)
    : await workflows.getCurrentSavedVersion(row.workspace_id, row.workflow_id)
  const saved = version?.definition.nodes.find(item => item.id === row.workflow_node_id)
  const draft = !saved && !row.origin_run_id && !acceptedWorkflowVersionId
  if (version && (version.workspaceId !== row.workspace_id || version.workflowId !== row.workflow_id)
    || !draft && (!version || !saved) || saved && (saved.kind === 'job' || saved.agentId !== row.agent_id)) {
    throw new DomainError('CHAT_SUBJECT_NODE_UNAVAILABLE', 'The exact saved conversation node is unavailable.', 409)
  }
  // Draft chat: the node is not in a saved workflow version yet (a never-saved workflow or a new node). Only a
  // conversation outside any Run qualifies; it runs on the Agent's own saved configuration, without workflow tools.
  const base: AgentNode = saved ?? { id: row.workflow_node_id, agentId: row.agent_id,
    name: (await sql.query<{ name: string | null }>("select record->>'name' as name from agents where id=$1 and workspace_id=$2",
      [row.agent_id, row.workspace_id])).rows[0]?.name ?? row.agent_id }
  // A chat outside any Run follows the Board's current browser switch, so turning it on needs no workflow save.
  const node: AgentNode = !row.origin_run_id && row.record.chatBrowser ? { ...base, browser: row.record.chatBrowser } : base
  const subject = AgentSubjectSchema.parse({ kind: 'conversation', conversationId: row.id, agent: {
    workspaceId: row.workspace_id, workflowId: row.workflow_id, workflowNodeId: row.workflow_node_id,
    agentId: row.agent_id, configurationVersionId: configuration.id,
    productRole: configuration.productRole ?? 'coder', displayName: node.name ?? node.label ?? row.agent_id,
  } }) as Extract<AgentSubject, { kind: 'conversation' }>
  return { subject, workflowVersionId: saved ? version!.id : null, configuration, node,
    workingDirectory: row.record.workingDirectory }
}

export type ConversationFeatureContext = Awaited<ReturnType<typeof conversationFeatureContext>>
