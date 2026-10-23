import { effectiveGraphqlTools, memoryBoardTools, parseCoordinationResult, type ExecutionResult } from '@foreman-code/contracts'
import { memoryExecution } from '../collaboration/memoryExecution.js'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { repeatTickIndex } from './repeatResolution.js'
import { workflowResultContext } from './resultContext.js'

/** The one follow-up a writable Agent gets when its turn left no card on its workflow's Kanban. */
export const KANBAN_FOLLOW_UP = [
  'Before this result is accepted: you did not record your work on this workflow\'s Kanban (its workflow memory board).',
  'Create or update a card for your task now with memory_card_create or memory_card_update, and move it to Done with a one-line result.',
  'Do not repeat the task. Then return your complete previous result again, unchanged.',
].join('\n')

/** True when a writable Agent's business turn neither created nor updated a card on its workflow's Kanban. */
export async function kanbanRecordMissingLocked(tx: GraphTransactionSql, executionId: string,
  result: ExecutionResult): Promise<boolean> {
  if (result.outcome !== 'succeeded') return false
  const saved = await memoryExecution(tx, executionId)
  const { execution, configuration, node, version } = saved
  if (repeatTickIndex(execution.input) !== undefined) return false
  const readOnly = configuration.harness.harness === 'opencode' || configuration.harness.sandbox === 'read-only'
  if (readOnly || !effectiveGraphqlTools(saved.subject.agent.productRole, configuration.graphqlTools,
    node.graphqlTools, Boolean(node.interval), memoryBoardTools('write')).includes('memory_card_create')) return false
  if (execution.resultProtocol) {
    try {
      const { board } = parseCoordinationResult(result.output, workflowResultContext(version, execution)!)
      if (board.kind === 'changes' && board.operations.some(operation => operation.kind.startsWith('card_'))) return false
    } catch {
      // ignore: an invalid result gets its own format correction; the Kanban check reads committed cards only.
    }
  }
  const recorded = await tx.query(`select 1 from memory_board_commands c join memory_boards b on b.id=c.board_id
    where c.principal_id=$1 and c.receipt->>'outcome' in ('created','updated') and c.receipt ? 'card'
      and b.scope->>'kind'='workflow' and b.scope->>'workflowId'=$2 limit 1`,
  [`execution:${execution.id}`, version.workflowId])
  return !recorded.rowCount
}
