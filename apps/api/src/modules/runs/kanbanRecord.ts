import { effectiveGraphqlTools, memoryBoardTools, type ExecutionResult } from '@foreman-code/contracts'
import { memoryExecution } from '../collaboration/memoryExecution.js'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { repeatTickIndex } from './repeatResolution.js'
import { agentCard, findScopeBoard } from '../memory-boards/repository.js'

/** The one follow-up a writable Agent gets when it did not update its assigned card. */
export const KANBAN_FOLLOW_UP = (cardId: string) => [
  `Before this result is accepted: update your card ${cardId} on this workflow's Kanban with memory_card_update.`,
  'Keep its body current with what you worked on and what you found; do not create new cards.',
  'Do not repeat the task. Then return your complete previous result again, unchanged.',
].join('\n')

/** Returns the assigned card ID only when this execution has no updated receipt for it. */
export async function kanbanRecordMissingLocked(tx: GraphTransactionSql, executionId: string,
  result: ExecutionResult): Promise<string | undefined> {
  if (result.outcome !== 'succeeded') return undefined
  const saved = await memoryExecution(tx, executionId)
  const { execution, configuration, node } = saved
  if (repeatTickIndex(execution.input) !== undefined) return undefined
  const readOnly = configuration.harness.harness === 'opencode' || configuration.harness.sandbox === 'read-only'
  if (readOnly || !effectiveGraphqlTools(saved.subject.agent.productRole, configuration.graphqlTools,
    node.graphqlTools, Boolean(node.interval), memoryBoardTools('write')).includes('memory_card_update')) return undefined
  const board = await findScopeBoard(tx, { kind: 'workflow', workspaceId: saved.subject.agent.workspaceId,
    workflowId: saved.subject.agent.workflowId })
  const own = board ? await agentCard(tx, board.board.id, saved.subject.agent) : undefined
  if (!own) return undefined
  const recorded = await tx.query(`select 1 from memory_board_commands
    where principal_id=$1 and board_id=$2 and receipt->>'outcome'='updated'
      and receipt#>>'{card,id}'=$3 limit 1`, [`execution:${execution.id}`, own.boardId, own.id])
  return recorded.rowCount ? undefined : own.id
}
