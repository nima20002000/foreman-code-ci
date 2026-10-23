import type { CoordinationResultContext, ResultProtocol } from '@foreman-code/contracts'
import type { WorkflowVersionCurrent } from '@foreman-code/contracts/current'
import { repeatTickIndex } from './repeatResolution.js'

export function workflowResultContext(version: WorkflowVersionCurrent, execution: {
  workflowNodeId: string; resultProtocol?: ResultProtocol | undefined; input?: unknown
}): CoordinationResultContext | undefined {
  if (!execution.resultProtocol) return undefined
  return { resultProtocol: execution.resultProtocol, definition: version.definition,
    workflowNodeId: execution.workflowNodeId, interval: repeatTickIndex(execution.input) !== undefined }
}
