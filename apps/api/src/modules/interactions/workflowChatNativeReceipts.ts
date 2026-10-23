import type { SqlTransaction } from '../../infrastructure/transaction.js'
import type { WorkflowNativeProofRecord } from '../runs/workflowNativeProof.js'
import { CONTROL_COMMAND_COLUMNS, WORKFLOW_INPUT_RETRIES, captureWorkflowControlNativeLocked, markWorkflowControlCommandLocked,
  type ControlCommandRow } from '../collaboration/index.js'
import type { WorkflowChatNativeTarget } from '../collaboration/index.js'
import { supportsExpectedTurnSteer } from '../harnesses/index.js'

const projectedNonTerminal = new WeakMap<SqlTransaction, Set<string>>()

const ACTIVE_CONTROL_FILTER = `run_id=$1 and state not in ('completed','failed','canceled') and (
      delivered_execution->>'executionId'=$2
      or operation='input' and delivered_execution->>'executionId' in (select id from retries)
      or target #>> '{execution,executionId}'=$2 and operation in ('steer','stop'))`

/** One statement tells a batch of frames for the same execution whether any of
 * them can have a chat receipt to project, instead of one lookup per frame. */
export async function hasWorkflowChatNativeReceiptsLocked(sql: SqlTransaction,
  runId: string, executionId: string): Promise<boolean> {
  return (await sql.query(`${WORKFLOW_INPUT_RETRIES} select 1 from run_chat_commands where ${ACTIVE_CONTROL_FILTER} limit 1`,
    [runId, executionId])).rows.length > 0
}

/** Called only after the original-source verifier has checked its live writer,
 * persisted physical evidence and canonical publication on THIS transaction. */
export async function projectWorkflowChatNativeReceiptsLocked(sql: SqlTransaction,
  proof: WorkflowNativeProofRecord): Promise<void> {
  const providerId = proof.lane?.providerId
  if (!providerId || proof.original.type === 'session_created' || proof.original.type === 'boundary') return
  const terminal = proof.original.type === 'history' ? proof.original.history.terminalTurn : undefined
  if (!terminal) {
    // Frames of one native turn in a transaction project the same command receipts; read them once.
    const key = [proof.scope.runId, proof.execution.executionId, proof.session.nativeSessionId, proof.commandId,
      providerId, proof.lane?.id].join('|')
    const seen = projectedNonTerminal.get(sql) ?? new Set<string>()
    projectedNonTerminal.set(sql, seen)
    if (seen.has(key)) return
    seen.add(key)
  }
  const rows = (await sql.query<ControlCommandRow>(`${WORKFLOW_INPUT_RETRIES} select ${CONTROL_COMMAND_COLUMNS} from run_chat_commands
    where ${ACTIVE_CONTROL_FILTER}
    order by sequence`, [proof.scope.runId, proof.execution.executionId])).rows
  for (const row of rows) {
    const captured = row.native_target as WorkflowChatNativeTarget | null
    const delivered = row.delivered_execution as { executionId?: string } | null
    const retryInput = !!delivered && row.operation === 'input' && delivered.executionId !== proof.execution.executionId
    if (retryInput && captured && (captured.nativeSessionId !== proof.session.nativeSessionId
      || captured.ownerRequestId !== proof.commandId)) continue
    if ((delivered?.executionId === proof.execution.executionId || retryInput) && row.kind === 'delivery') {
      if (row.state === 'accepted' && !terminal) continue
      if (!captured) await captureWorkflowControlNativeLocked(sql, {
        runId: row.run_id, commandId: row.id, now: proof.observedAt,
        nativeTarget: { nativeSessionId: proof.session.nativeSessionId, ownerRequestId: proof.commandId,
          ...(proof.session.harness === 'codex' ? { nativeTurnId: providerId } : { inputMessageId: providerId }),
          providerId, sessionMode: (row.request as { sessionMode?: 'regular' | 'plan' }).sessionMode ?? 'regular',
          steer: supportsExpectedTurnSteer(proof.session), interruptAndSend: true },
      })
      await markWorkflowControlCommandLocked(sql, { runId: row.run_id, commandId: row.id,
        state: terminal ? 'completed' : 'accepted',
        ...(proof.session.harness === 'codex' ? { nativeTurnId: providerId } : {}), now: proof.observedAt })
      continue
    }
    if (!captured || captured.nativeSessionId !== proof.session.nativeSessionId
      || captured.ownerRequestId !== proof.commandId
      || (captured.nativeTurnId ?? captured.inputMessageId) !== providerId || !terminal) continue
    // A pending continuation completes with its actual fixed successor. An
    // interrupt acknowledgement alone never completes that lineage.
    if (row.kind === 'stop' && !row.continuation_id || row.operation === 'steer' && row.state === 'accepted') {
      await markWorkflowControlCommandLocked(sql, { runId: row.run_id, commandId: row.id,
        state: 'completed', now: proof.observedAt })
    }
  }
}
