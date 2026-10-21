import { ChatSendRequestSchema } from '@foreman-code/contracts'
import type { DispatchIntent } from '@foreman-code/contracts/node-placement'
import type { RemoteOwnerControl } from '@foreman-code/contracts/remote-execution'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'
import { readControlCommand } from './workflowControlRecords.js'
import type { WorkflowChatNativeTarget } from './workflowControlTypes.js'

export async function assertWorkflowRemoteControl(sql: GraphSqlClient, intent: DispatchIntent,
  control: RemoteOwnerControl): Promise<void> {
  const command = await readControlCommand(sql, control.commandId)
  const native = command?.native_target as WorkflowChatNativeTarget | null | undefined
  if (!control.workflowControl || !command || command.run_id !== intent.runId
    || control.operationId !== intent.operationId || control.executionId !== intent.executionId
    || control.attemptId !== intent.attemptId || control.bindingHash !== intent.bindingHash
    || !sameWorkflowValue(control.owner, intent.owner)
    || !['submitting', 'accepted', 'unknown', 'settling'].includes(command.state)
    || !native || native.nativeSessionId !== control.native?.sessionId
    || (native.nativeTurnId ?? native.inputMessageId) !== control.native.turnId
    || native.ownerRequestId !== control.workflowControl.ownerRequestId
    || native.ownerRequestId !== `execution:${intent.executionId}`) throw new DomainError(
    'REMOTE_CONTROL_UNAVAILABLE', 'The durable workflow control no longer owns this exact native input.', 409)
  if (control.action.kind === 'steer') {
    const request = ChatSendRequestSchema.parse(command.request)
    if (command.operation !== 'steer' || command.native_prompt !== control.action.prompt
      || request.attachments.length || native.sessionMode !== (request.sessionMode ?? native.sessionMode)) throw new DomainError(
      'REMOTE_CONTROL_UNAVAILABLE', 'The steering command differs from its admitted input.', 409)
  } else if (control.action.kind !== 'stop' || !['stop', 'interrupt'].includes(command.operation)) {
    throw new DomainError('REMOTE_CONTROL_UNAVAILABLE', 'The admitted workflow control has a different operation.', 409)
  }
}
